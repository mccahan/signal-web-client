import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { api } from './signal-api.js';
import { bus } from './bus.js';
import { db } from './db.js';
import { syncRoster } from './roster.js';
import { claimSend } from './throttle.js';
import {
  self,
  isSelf,
  getConversation,
  decorateConversation,
  recipientFor,
  insertMessage,
  updateMessageStatus,
  getMessage,
  findMessage,
  setReaction,
  markConversationRead,
  unreadIncomingTimestamps,
  setAttachmentPath,
  rememberAttachment,
  getContact,
  markDeleted,
  clearConversation,
} from './store.js';

const DATA_URI = /^data:([^;,]+)?(?:;(?:filename=([^;,]+)|[^;,]*))*,(.*)$/s;

/**
 * The provisional timestamp doubles as the dedup key
 * (conversation, ts, author), and outgoing messages all share one author — so
 * two sends in the same millisecond would collapse into a single row and
 * destroy the first message's text. Keep it strictly increasing.
 */
let lastProvisionalTs = 0;
function nextProvisionalTs() {
  const now = Date.now();
  lastProvisionalTs = now > lastProvisionalTs ? now : lastProvisionalTs + 1;
  return lastProvisionalTs;
}

/**
 * Persist an outgoing attachment locally so the sent bubble can render it —
 * signal-cli only ever gives ids back for *incoming* files.
 */
async function storeOutgoingAttachment({ base64, contentType, filename }) {
  const id = `out_${crypto.randomUUID()}`;
  const buf = Buffer.from(base64, 'base64');
  const ext = path.extname(filename || '') || guessExt(contentType);
  const localPath = path.join(config.mediaDir, `${id}${ext}`);
  await fs.writeFile(localPath, buf);

  rememberAttachment({ id, contentType, filename: filename || `file${ext}`, size: buf.length });
  setAttachmentPath(id, localPath, contentType);

  return { id, contentType, filename: filename || `file${ext}`, size: buf.length };
}

function guessExt(ct = '') {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/webm': '.weba',
    'application/pdf': '.pdf',
  };
  return map[ct] || '';
}

/**
 * Send a message and reconcile the optimistic row the browser already drew.
 *
 * The row goes in as `pending` before the API call so the UI is instant, then
 * gets re-keyed to the real Signal timestamp the API returns — that timestamp
 * is the message's identity, and receipts arriving later reference it.
 */
export async function sendMessage({
  conversationId,
  body = '',
  attachments = [],
  quote = null,
  mentions = [],
  clientId = null,
}) {
  let conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('unknown conversation'), { status: 404 });

  if (!body.trim() && !attachments.length) {
    throw Object.assign(new Error('nothing to send'), { status: 400 });
  }

  // Claim rate-limit capacity here: after the checks that cost nothing, and
  // before the first thing that does. The roster refresh below is already an
  // upstream call, and everything past it either writes to the database or
  // publishes an optimistic bubble to every open browser — a message rejected
  // any later than this would leave that bubble on screen unsent.
  claimSend('message');

  // A group first seen in an envelope only has the base64 internal id, which
  // /v2/send won't accept. Pull the roster so we learn its "group.xxx" send id
  // instead of failing until the next scheduled sync.
  if (conv.type === 'group' && !conv.group_id) {
    await syncRoster({ force: true }).catch((err) =>
      log.debug(`roster refresh before group send failed: ${err.message}`)
    );
    conv = getConversation(conversationId) || conv;
  }

  const recipient = recipientFor(conv);
  if (!recipient) throw Object.assign(new Error('conversation has no address'), { status: 400 });

  // Save attachments first so the optimistic bubble can show them right away.
  const stored = [];
  const base64Attachments = [];
  for (const att of attachments) {
    const m = typeof att === 'string' ? att.match(DATA_URI) : null;
    const contentType = (m ? m[1] : att.contentType) || 'application/octet-stream';
    const filename = (m ? m[2] : att.filename) || '';
    const data = m ? m[3] : att.data;
    if (!data) continue;

    if (Buffer.byteLength(data, 'base64') > config.maxUploadBytes) {
      throw Object.assign(new Error(`attachment exceeds ${config.maxUploadBytes} bytes`), {
        status: 413,
      });
    }

    stored.push(await storeOutgoingAttachment({ base64: data, contentType, filename }));
    // signal-cli wants the filename embedded in the data URI to preserve it.
    base64Attachments.push(
      `data:${contentType};${filename ? `filename=${filename};` : ''}base64,${data}`
    );
  }

  const provisionalTs = nextProvisionalTs();
  let message = insertMessage({
    conversationId,
    ts: provisionalTs,
    direction: 'out',
    authorId: self.contactId,
    authorName: 'You',
    body,
    attachments: stored,
    quote,
    mentions,
    status: 'pending',
    clientId,
  });

  bus.publish('message', {
    message,
    conversation: decorateConversation(getConversation(conversationId)),
  });

  const payload = {
    number: self.number,
    recipients: [recipient],
    message: body,
    text_mode: 'normal',
  };
  if (base64Attachments.length) payload.base64_attachments = base64Attachments;
  if (mentions?.length) {
    payload.mentions = mentions.map((m) => ({
      author: m.number || m.uuid || m.author,
      start: m.start,
      length: m.length,
    }));
  }
  if (quote?.ts) {
    payload.quote_timestamp = quote.ts;
    const qc = getContact(quote.authorId);
    payload.quote_author = qc ? qc.number || qc.uuid || quote.authorId : quote.authorId;
    payload.quote_message = quote.text || '';
  }

  try {
    const res = await api.send(payload);
    const realTs = Number(res?.timestamp) || provisionalTs;

    if (realTs !== provisionalTs) {
      // Re-key onto the authoritative timestamp, collapsing onto any row the
      // receive loop may already have created from a sync echo.
      try {
        message = repointMessage(message.id, conversationId, realTs);
      } catch (err) {
        log.warn(`could not re-key sent message: ${err.message}`);
      }
    }
    message = updateMessageStatus(message.id, 'sent');
  } catch (err) {
    log.error(`send failed: ${err.message}`);
    message = updateMessageStatus(message.id, 'failed', err.message);
    bus.publish('message_update', { message, reason: 'send_failed' });
    throw err;
  }

  bus.publish('message_update', {
    message,
    reason: 'sent',
    conversation: decorateConversation(getConversation(conversationId)),
  });
  return message;
}

function repointMessage(id, conversationId, realTs) {
  const clash = findMessage(conversationId, realTs, self.contactId);
  if (clash && clash.id !== id) {
    // The sync echo beat us to it — keep that row, drop the optimistic one and
    // tell browsers to retract the bubble they already drew for it.
    dropMessage(id);
    bus.publish('message_removed', { id, conversationId });
    return clash;
  }
  updateMessageTs(id, realTs);
  return getMessage(id);
}

function updateMessageTs(id, ts) {
  db.prepare('UPDATE messages SET ts = ? WHERE id = ?').run(ts, id);
  const row = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(id);
  if (row) {
    db.prepare('UPDATE conversations SET last_activity = MAX(last_activity, ?) WHERE id = ?').run(
      ts,
      row.conversation_id
    );
  }
}
function dropMessage(id) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

export async function sendReaction({ conversationId, targetTs, targetAuthorId, emoji, remove }) {
  const conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('unknown conversation'), { status: 404 });

  // Before the optimistic setReaction below, for the same reason as in
  // sendMessage: past that point browsers have already been told it happened.
  claimSend('reaction');

  const recipient = recipientFor(conv);
  const targetContact = getContact(targetAuthorId);
  const targetAuthor =
    targetAuthorId === self.contactId
      ? self.number || self.uuid
      : targetContact?.number || targetContact?.uuid || targetAuthorId;

  const body = { reaction: emoji, recipient, target_author: targetAuthor, timestamp: targetTs };

  // Reflect locally first; the API round trip is ~2s on a busy lane.
  const updated = setReaction({
    conversationId,
    targetTs,
    targetAuthor: targetAuthorId,
    authorId: self.contactId,
    authorName: 'You',
    emoji,
    ts: Date.now(),
    remove,
  });
  bus.publish('message_update', { message: updated, reason: 'reaction' });

  try {
    if (remove) await api.unreact(self.number, body);
    else await api.react(self.number, body);
  } catch (err) {
    log.warn(`reaction failed: ${err.message}`);
    // Roll back the optimistic change.
    const reverted = setReaction({
      conversationId,
      targetTs,
      targetAuthor: targetAuthorId,
      authorId: self.contactId,
      authorName: 'You',
      emoji,
      ts: Date.now(),
      remove: !remove,
    });
    bus.publish('message_update', { message: reverted, reason: 'reaction' });
    throw err;
  }
  return updated;
}

/**
 * Retract a message for everyone who received it.
 *
 * Signal only lets you delete your *own* messages this way, and only within its
 * retention window — the API returns an error past that, which we surface
 * rather than pretending the delete worked.
 */
export async function deleteForEveryone({ conversationId, ts }) {
  const conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('unknown conversation'), { status: 404 });

  const existing = findMessage(conversationId, ts, self.contactId);
  if (!existing) {
    throw Object.assign(new Error('You can only delete your own messages for everyone'), {
      status: 403,
    });
  }
  if (existing.status === 'pending') {
    throw Object.assign(new Error('That message is still sending'), { status: 409 });
  }

  const recipient = recipientFor(conv);
  if (!recipient) throw Object.assign(new Error('conversation has no address'), { status: 400 });

  // A retraction is itself a message to every recipient, so it counts.
  claimSend('remote delete');

  await api.remoteDelete(self.number, { recipient, timestamp: ts });

  // Only tombstone locally once Signal has accepted the retraction, so a
  // failure leaves the message visible rather than silently hiding it here.
  const message = markDeleted(conversationId, ts, self.contactId);
  bus.publish('message_update', {
    message,
    reason: 'delete',
    conversation: decorateConversation(getConversation(conversationId)),
  });
  return message;
}

/**
 * Leave a group. The other members are told, and the thread stays here as
 * history until it's explicitly deleted.
 */
export async function leaveGroup(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('unknown conversation'), { status: 404 });
  if (conv.type !== 'group') {
    throw Object.assign(new Error('Only groups can be left'), { status: 400 });
  }

  // Group path parameters take the "group.xxx" send id, not the internal id.
  const groupId = conv.group_id || conv.group_internal_id;
  if (!groupId) throw Object.assign(new Error('group has no id'), { status: 400 });

  await api.quitGroup(self.number, groupId);
  await syncRoster({ force: true }).catch(() => {});

  const message = insertMessage({
    conversationId,
    ts: Date.now(),
    direction: 'out',
    authorId: self.contactId,
    authorName: 'You',
    body: 'You left the group',
    kind: 'event',
  });
  bus.publish('message', { message, conversation: decorateConversation(getConversation(conversationId)) });

  return decorateConversation(getConversation(conversationId));
}

/**
 * Remove a conversation from this client: history is erased and the thread is
 * hidden from the list.
 *
 * Deleting the row outright does not work for groups. signal-cli keeps listing
 * a group even after DELETE /v1/groups returns 200 (verified: it comes back
 * with an empty member list), so the next roster sync would recreate the thread
 * as brand new. Hiding it survives the sync instead, because the roster upsert
 * never touches this flag.
 *
 * A group you're still in is left first — otherwise you'd keep receiving
 * messages for a conversation you just deleted.
 */
export async function deleteConversation(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('unknown conversation'), { status: 404 });

  if (conv.type === 'group') {
    const groupId = conv.group_id || conv.group_internal_id;
    if (groupId) {
      if (stillAMember(conv)) {
        try {
          await api.quitGroup(self.number, groupId);
        } catch (err) {
          throw Object.assign(new Error(`Could not leave the group: ${err.message}`), {
            status: 502,
          });
        }
      }
      // Best effort: clears signal-cli's local copy. It stays in the group
      // listing regardless, which is why we also hide it locally.
      await api.deleteGroup(self.number, groupId).catch((err) =>
        log.debug(`upstream group delete failed: ${err.message}`)
      );
    }
  }

  clearConversation(conversationId);
  bus.publish('conversation_removed', { conversationId });
  return { conversationId };
}

function stillAMember(conv) {
  let members = [];
  try {
    members = JSON.parse(conv.members || '[]');
  } catch {
    members = [];
  }
  return members.some((m) => m === self.number || m === self.uuid);
}

/** Clear the local badge and, when enabled, tell the sender we read it. */
export async function markRead(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return null;

  const pending = unreadIncomingTimestamps(conversationId);
  const updated = markConversationRead(conversationId);
  bus.publish('conversation', { conversation: decorateConversation(updated) });

  if (config.sendReadReceipts && pending.length) {
    // Don't make the browser wait: each receipt is a separate API call on the
    // shared lane (~2s apiece in native mode), and the badge is already clear.
    dispatchReadReceipts(pending).catch((err) =>
      log.debug(`read receipts failed: ${err.message}`)
    );
  }

  return decorateConversation(updated);
}

const MAX_RECEIPTS_PER_READ = 40;

/**
 * Acknowledge messages to the people who sent them.
 *
 * Receipts are addressed per author, which is what makes this work in groups:
 * marking a group thread read tells each participant that *their* message was
 * read, rather than trying to send a receipt to the group itself.
 */
async function dispatchReadReceipts(pending) {
  // Newest first: if we have to truncate, the recent messages matter most.
  const recent = pending.slice(-MAX_RECEIPTS_PER_READ);
  if (recent.length < pending.length) {
    log.info(
      `acknowledging the ${recent.length} most recent of ${pending.length} unread messages`
    );
  }

  for (const { ts, authorId } of recent) {
    if (isSelf(authorId)) continue;

    const contact = getContact(authorId);
    const recipient = contact?.number || contact?.uuid;
    if (!recipient) {
      log.debug(`no address for ${authorId}; skipping its read receipt`);
      continue;
    }

    try {
      await api.receipt(self.number, { receipt_type: 'read', recipient, timestamp: ts });
    } catch (err) {
      // One bad recipient shouldn't stop the rest of the batch.
      log.debug(`read receipt to ${recipient} for ${ts} failed: ${err.message}`);
    }
  }
}

export async function sendTyping(conversationId, started) {
  if (!config.sendTypingIndicators) return;
  const conv = getConversation(conversationId);
  if (!conv || conv.type === 'self') return;
  const recipient = recipientFor(conv);
  if (!recipient) return;

  try {
    const body = { recipient };
    if (started) await api.startTyping(self.number, body);
    else await api.stopTyping(self.number, body);
  } catch (err) {
    log.debug(`typing indicator failed: ${err.message}`);
  }
}
