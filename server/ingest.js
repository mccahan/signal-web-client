import { bus } from './bus.js';
import { log } from './log.js';
import { prefetchAttachments } from './media.js';
import { syncRoster } from './roster.js';
import {
  self,
  isSelf,
  upsertContact,
  getContact,
  contactName,
  ensureDmConversation,
  ensureGroupConversation,
  conversationIdForContact,
  insertMessage,
  applyReceipt,
  setReaction,
  markDeleted,
  applyEdit,
  rememberAttachment,
  decorateConversation,
  getConversation,
  markConversationRead,
  findContact,
} from './store.js';

/** Turn a source/uuid/number triple from an envelope into a known contact id. */
function contactFrom({ uuid, number, name }) {
  const id = upsertContact({
    uuid: uuid || undefined,
    number: number || undefined,
    profileName: name || undefined,
  });
  return id;
}

/**
 * `source` in an envelope is either a UUID or an E.164 depending on version and
 * whether the contact is known, so normalise before touching the store.
 */
function splitAddress(source, uuid, number) {
  const looksUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);
  const looksNumber = (v) => typeof v === 'string' && /^\+\d{6,}$/.test(v);
  return {
    uuid: uuid || (looksUuid(source) ? source : null),
    number: number || (looksNumber(source) ? source : null),
  };
}

function normalizeAttachments(list) {
  const out = (list || []).map((a) => {
    const att = {
      id: a.id,
      contentType: a.contentType || 'application/octet-stream',
      filename: a.filename || '',
      size: a.size || 0,
      width: a.width || 0,
      height: a.height || 0,
      caption: a.caption || '',
    };
    rememberAttachment(att);
    return att;
  });

  // Pull the bytes down now, at background priority, so the photo is already
  // local when the user opens the thread instead of stalling behind a poll.
  if (out.length) prefetchAttachments(out);
  return out;
}

/** Who a message we sent was addressed to, when the payload carries it. */
function destinationOf(data) {
  const dest = splitAddress(data?.destination, data?.destinationUuid, data?.destinationNumber);
  if (!dest.uuid && !dest.number) return null;
  return contactFrom(dest);
}

function normalizeMentions(list) {
  return (list || []).map((m) => ({
    start: m.start || 0,
    length: m.length || 0,
    uuid: m.uuid || '',
    number: m.number || '',
    name: m.name || '',
  }));
}

function normalizeQuote(q) {
  if (!q) return null;
  const { uuid, number } = splitAddress(q.author, q.authorUuid, q.authorNumber);
  const authorId = uuid || number ? contactFrom({ uuid, number }) : null;
  return {
    ts: q.id,
    authorId,
    authorName: contactName(getContact(authorId)) || '',
    text: q.text || '',
    attachments: (q.attachments || []).map((a) => ({
      contentType: a.contentType || '',
      filename: a.filename || '',
    })),
  };
}

/**
 * Resolve which conversation an inbound payload belongs to, creating it on
 * first contact. Group membership wins over the 1:1 pairing.
 */
function resolveConversation({ groupInfo, peerContactId }) {
  if (groupInfo?.groupId) {
    return ensureGroupConversation({
      internalId: groupInfo.groupId,
      name: groupInfo.groupName || '',
    });
  }
  if (!peerContactId) return null;
  return ensureDmConversation(peerContactId);
}

function publishMessage(message) {
  if (!message) return;
  const conv = getConversation(message.conversationId);
  bus.publish('message', {
    message,
    conversation: conv ? decorateConversation(conv) : null,
  });
}

function publishMessageUpdate(message, reason) {
  if (!message) return;
  const conv = getConversation(message.conversationId);
  bus.publish('message_update', {
    message,
    reason,
    conversation: conv ? decorateConversation(conv) : null,
  });
}

/**
 * Handle one dataMessage-shaped payload. Shared by inbound messages and by the
 * sync copies of messages sent from another linked device.
 */
function handleDataMessage({ data, authorId, authorName, direction, peerContactId, envelope }) {
  if (!data) return;

  // Reactions, deletes and edits reference an existing message rather than
  // creating one, so they're handled before the insert path.
  if (data.reaction) {
    const r = data.reaction;
    const { uuid, number } = splitAddress(r.targetAuthor, r.targetAuthorUuid, r.targetAuthorNumber);
    const targetAuthorId = contactFrom({ uuid, number });
    const conversationId = resolveConversation({ groupInfo: data.groupInfo, peerContactId });
    if (!conversationId) return;
    const updated = setReaction({
      conversationId,
      targetTs: r.targetSentTimestamp,
      targetAuthor: targetAuthorId,
      authorId,
      authorName,
      emoji: r.emoji,
      ts: data.timestamp || envelope.timestamp,
      remove: !!r.isRemove,
    });
    publishMessageUpdate(updated, 'reaction');
    return;
  }

  if (data.remoteDelete) {
    const conversationId = resolveConversation({ groupInfo: data.groupInfo, peerContactId });
    if (!conversationId) return;
    const updated = markDeleted(conversationId, data.remoteDelete.timestamp, authorId);
    publishMessageUpdate(updated, 'delete');
    return;
  }

  const conversationId = resolveConversation({ groupInfo: data.groupInfo, peerContactId });
  if (!conversationId) {
    log.debug('dropping payload with no resolvable conversation');
    return;
  }

  // A group update with no body is a membership/name change, not a message.
  if (!data.message && !data.attachments?.length && !data.sticker && data.groupInfo?.type && data.groupInfo.type !== 'DELIVER') {
    handleGroupUpdate({
      conversationId,
      authorId,
      authorName,
      ts: data.timestamp || envelope.timestamp,
      serverTs: envelope.serverReceivedTimestamp,
      direction,
    }).catch((err) => log.warn(`group update handling failed: ${err.message}`));
    return;
  }

  if (data.isExpirationUpdate) {
    const secs = data.expiresInSeconds || 0;
    const msg = insertMessage({
      conversationId,
      ts: data.timestamp || envelope.timestamp,
      direction,
      authorId,
      authorName,
      body: secs
        ? `Disappearing messages set to ${formatDuration(secs)}`
        : 'Disappearing messages disabled',
      kind: 'event',
    });
    publishMessage(msg);
    return;
  }

  // Nothing renderable — a typing-only or receipt-only carrier.
  if (!data.message && !data.attachments?.length && !data.sticker && !data.quote) return;

  const message = insertMessage({
    conversationId,
    ts: data.timestamp || envelope.timestamp,
    serverTs: envelope.serverReceivedTimestamp,
    direction,
    authorId,
    authorName,
    body: data.message || '',
    attachments: normalizeAttachments(data.attachments),
    quote: normalizeQuote(data.quote),
    mentions: normalizeMentions(data.mentions),
    sticker: data.sticker || null,
    previews: data.previews || [],
    textStyles: data.textStyles || [],
    viewOnce: data.viewOnce,
    expiresIn: data.expiresInSeconds || 0,
    status: direction === 'out' ? 'sent' : '',
  });

  publishMessage(message);
}

/** Human name for a group member, who is listed as either an E.164 or a UUID. */
function memberName(address) {
  if (!address) return 'someone';
  const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(address);
  const contact = findContact(looksUuid ? { uuid: address } : { number: address });
  if (isSelf(contact?.id) || isSelf(address)) return 'You';
  return contact ? contactName(contact) : address;
}

const listNames = (addresses) => addresses.map(memberName).join(', ');

/**
 * Describe what a group change actually did.
 *
 * The envelope only says "something changed" — it carries no membership diff —
 * so refresh the roster and compare before/after. Without this the member list
 * stays stale until the next scheduled sync, and every change reads as the same
 * vague "updated the group".
 */
async function handleGroupUpdate({ conversationId, authorId, authorName, ts, serverTs, direction }) {
  const before = getConversation(conversationId);
  const oldMembers = new Set(parseMembers(before?.members));
  const oldName = before?.name || '';

  await syncRoster({ force: true });

  const after = getConversation(conversationId);
  const newMembers = new Set(parseMembers(after?.members));
  const newName = after?.name || '';

  const removed = [...oldMembers].filter((m) => !newMembers.has(m));
  const added = [...newMembers].filter((m) => !oldMembers.has(m));

  // Someone dropping only themselves is a departure, not a removal.
  const authorLeft =
    removed.length === 1 && !added.length && sameParty(removed[0], authorId);

  let body;
  if (authorLeft) {
    body = `${authorName || 'Someone'} left the group`;
  } else if (removed.length && added.length) {
    body = `${authorName} added ${listNames(added)} and removed ${listNames(removed)}`;
  } else if (removed.length) {
    body = `${authorName} removed ${listNames(removed)}`;
  } else if (added.length) {
    body = `${authorName} added ${listNames(added)}`;
  } else if (oldName && newName && oldName !== newName) {
    body = `${authorName} changed the group name to “${newName}”`;
  } else {
    body = `${authorName || 'Someone'} updated the group`;
  }

  const msg = insertMessage({
    conversationId,
    ts,
    serverTs,
    direction,
    authorId,
    authorName,
    body,
    kind: 'event',
  });
  publishMessage(msg);

  // Push the refreshed membership out so open threads update their header.
  const conv = getConversation(conversationId);
  if (conv) bus.publish('conversation', { conversation: decorateConversation(conv) });
}

function parseMembers(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Do a member address and a contact id refer to the same person? */
function sameParty(address, contactId) {
  if (!address || !contactId) return false;
  if (address === contactId) return true;
  const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(address);
  const contact = findContact(looksUuid ? { uuid: address } : { number: address });
  return !!contact && contact.id === contactId;
}

function formatDuration(secs) {
  if (secs % 604800 === 0) return `${secs / 604800} week(s)`;
  if (secs % 86400 === 0) return `${secs / 86400} day(s)`;
  if (secs % 3600 === 0) return `${secs / 3600} hour(s)`;
  if (secs % 60 === 0) return `${secs / 60} minute(s)`;
  return `${secs} seconds`;
}

/**
 * Entry point: consume one envelope from GET /v1/receive and fan out whatever
 * it turns out to contain.
 */
export function ingestEnvelope(item) {
  const envelope = item?.envelope;
  if (!envelope) return;

  const src = splitAddress(envelope.source, envelope.sourceUuid, envelope.sourceNumber);
  const fromSelf = isSelf(src.uuid) || isSelf(src.number);
  const senderId = fromSelf ? self.contactId : contactFrom({ ...src, name: envelope.sourceName });
  const senderName = fromSelf ? 'You' : contactName(getContact(senderId));

  // --- messages addressed to us ------------------------------------------
  if (envelope.dataMessage) {
    handleDataMessage({
      data: envelope.dataMessage,
      authorId: senderId,
      authorName: senderName,
      direction: fromSelf ? 'out' : 'in',
      peerContactId: senderId,
      envelope,
    });
  }

  // --- an edit of an earlier message --------------------------------------
  if (envelope.editMessage?.dataMessage) {
    const edit = envelope.editMessage;
    const data = edit.dataMessage;
    // An edit we made on another device is addressed to the *recipient*, not to
    // us — resolving it by sender would file it under Note to Self and then
    // insert a stray copy of the edited text there.
    const peerId = fromSelf ? destinationOf(data) || senderId : senderId;
    const conversationId = data.groupInfo?.groupId
      ? ensureGroupConversation({ internalId: data.groupInfo.groupId })
      : conversationIdForContact(peerId);
    const updated = applyEdit({
      conversationId,
      targetTs: edit.targetSentTimestamp,
      authorId: senderId,
      body: data.message || '',
      attachments: normalizeAttachments(data.attachments),
      mentions: normalizeMentions(data.mentions),
      editTs: data.timestamp,
    });
    if (updated) publishMessageUpdate(updated, 'edit');
    else
      handleDataMessage({
        data,
        authorId: senderId,
        authorName: senderName,
        direction: fromSelf ? 'out' : 'in',
        peerContactId: peerId,
        envelope,
      });
  }

  // --- copies of what we sent from another linked device -------------------
  if (envelope.syncMessage?.sentMessage) {
    const sent = envelope.syncMessage.sentMessage;
    const dest = splitAddress(sent.destination, sent.destinationUuid, sent.destinationNumber);
    const peerId = sent.groupInfo?.groupId
      ? null
      : dest.uuid || dest.number
        ? contactFrom(dest)
        : self.contactId;

    handleDataMessage({
      data: sent,
      authorId: self.contactId,
      authorName: 'You',
      direction: 'out',
      peerContactId: peerId,
      envelope,
    });
  }

  // --- our own read state, synced from the phone ---------------------------
  if (envelope.syncMessage?.readMessages?.length) {
    for (const r of envelope.syncMessage.readMessages) {
      const { uuid, number } = splitAddress(r.sender, r.senderUuid, r.senderNumber);
      const peerId = contactFrom({ uuid, number });
      const conversationId = conversationIdForContact(peerId);
      // You read it on your phone — clear the badge here too.
      const conv = markConversationRead(conversationId);
      if (conv) bus.publish('conversation', { conversation: decorateConversation(conv) });
    }
  }

  // --- delivery / read receipts for messages we sent -----------------------
  if (envelope.receiptMessage) {
    const r = envelope.receiptMessage;
    const status = r.isViewed ? 'read' : r.isRead ? 'read' : r.isDelivery ? 'delivered' : null;
    // Receipts are the one envelope whose effect is invisible in the UI beyond
    // a tick changing colour, so log enough to tell a real acknowledgement
    // from a misread flag without having to reproduce it live.
    log.debug(
      `receipt from ${envelope.sourceNumber || envelope.sourceUuid || envelope.source || '?'}: ` +
        `delivery=${!!r.isDelivery} read=${!!r.isRead} viewed=${!!r.isViewed} ` +
        `-> ${status || 'ignored'} for ts ${JSON.stringify(r.timestamps || [])}`
    );
    if (status) {
      const touched = applyReceipt({ timestamps: r.timestamps || [], status });
      for (const m of touched) publishMessageUpdate(m, 'receipt');
    }
  }

  // --- typing indicators ---------------------------------------------------
  if (envelope.typingMessage) {
    const t = envelope.typingMessage;
    const conversationId = t.groupId
      ? ensureGroupConversation({ internalId: t.groupId })
      : conversationIdForContact(senderId);
    if (conversationId) {
      bus.publish('typing', {
        conversationId,
        authorId: senderId,
        authorName: senderName,
        started: t.action === 'STARTED',
      });
    }
  }
}

export function ingestBatch(items) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const item of items) {
    try {
      ingestEnvelope(item);
      n++;
    } catch (err) {
      log.error('failed to ingest envelope:', err.message, JSON.stringify(item).slice(0, 400));
    }
  }
  return n;
}
