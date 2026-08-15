import { db, plain, plainAll, getMeta, setMeta, tx } from './db.js';
import { log } from './log.js';

const now = () => Date.now();
const j = (v) => (v == null ? null : JSON.stringify(v));
const unj = (v, dflt) => {
  if (v == null) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
};

/** The account this server drives, plus its own ACI once we learn it. */
export const self = { number: '', uuid: '', contactId: 'self' };

export function setSelf({ number, uuid }) {
  if (number) self.number = number;
  if (uuid) self.uuid = uuid;
  self.contactId = self.uuid || self.number || 'self';
  upsertContact({ uuid: self.uuid, number: self.number, name: 'Note to Self' });
  ensureSelfConversation();
}

export const isSelf = (ref) =>
  !!ref && (ref === self.uuid || ref === self.number || ref === self.contactId);

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const selContactByUuid = db.prepare('SELECT * FROM contacts WHERE uuid = ?');
const selContactByNumber = db.prepare("SELECT * FROM contacts WHERE number = ? AND number != ''");
const selContactById = db.prepare('SELECT * FROM contacts WHERE id = ?');

/**
 * Contacts arrive keyed sometimes by UUID and sometimes by phone number. We key
 * on the UUID when we have one and fold any number-keyed row into it the moment
 * the two are seen together, so a conversation never splits in half.
 */
export function upsertContact({
  uuid,
  number,
  name,
  profileName,
  username,
  hasAvatar,
  blocked,
} = {}) {
  uuid = uuid || null;
  number = number || null;
  if (!uuid && !number) return null;

  let byUuid = uuid ? plain(selContactByUuid.get(uuid)) : null;
  let byNumber = number ? plain(selContactByNumber.get(number)) : null;

  // Same human reached by two keys: keep the UUID row, migrate the other away.
  if (byUuid && byNumber && byUuid.id !== byNumber.id) {
    mergeContacts(byNumber.id, byUuid.id);
    byNumber = null;
  }

  const existing = byUuid || byNumber;
  let id = existing ? existing.id : uuid || number;

  // A number-keyed row that just learned its UUID gets re-keyed onto the UUID.
  // Fall through to the upsert afterwards rather than returning early: the same
  // roster payload usually carries the profile name, and returning here dropped
  // it, leaving the contact nameless until the next sync.
  if (existing && uuid && existing.id !== uuid && existing.id === existing.number) {
    mergeContacts(existing.id, uuid, { uuid, number });
    id = uuid;
  }

  db.prepare(
    `INSERT INTO contacts (id, uuid, number, name, profile_name, username, has_avatar, blocked, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       uuid         = COALESCE(excluded.uuid, contacts.uuid),
       number       = COALESCE(NULLIF(excluded.number, ''), contacts.number),
       name         = COALESCE(NULLIF(excluded.name, ''), contacts.name),
       profile_name = COALESCE(NULLIF(excluded.profile_name, ''), contacts.profile_name),
       username     = COALESCE(NULLIF(excluded.username, ''), contacts.username),
       has_avatar   = MAX(excluded.has_avatar, contacts.has_avatar),
       blocked      = excluded.blocked,
       updated_at   = excluded.updated_at`
  ).run(
    id,
    uuid,
    number || '',
    name || '',
    profileName || '',
    username || '',
    hasAvatar ? 1 : 0,
    blocked ? 1 : 0,
    now()
  );

  // Keep the conversation title in step with the name we just learned, so a
  // thread stops showing a bare phone number once the profile arrives.
  const fresh = plain(selContactById.get(id));
  if (fresh) {
    db.prepare(
      "UPDATE conversations SET name = ? WHERE id = ? AND type != 'self' AND name != ?"
    ).run(contactName(fresh), `dm:${id}`, contactName(fresh));
  }

  return id;
}

function mergeContacts(fromId, toId, seed = {}) {
  if (fromId === toId) return;
  const from = plain(selContactById.get(fromId));
  if (!from) return;
  log.debug(`merging contact ${fromId} -> ${toId}`);

  db.prepare(
    `INSERT INTO contacts (id, uuid, number, name, profile_name, username, has_avatar, blocked, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    toId,
    seed.uuid || from.uuid || toId,
    seed.number || from.number || '',
    from.name || '',
    from.profile_name || '',
    from.username || '',
    from.has_avatar,
    from.blocked,
    now()
  );

  // Re-point everything that referenced the old key. `target_author` matters as
  // much as `author_id`: it is part of the reactions primary key and is matched
  // when removing a reaction, so leaving it stale makes the reaction permanent.
  db.prepare('UPDATE OR IGNORE messages SET author_id = ? WHERE author_id = ?').run(toId, fromId);
  db.prepare('UPDATE OR IGNORE reactions SET author_id = ? WHERE author_id = ?').run(toId, fromId);
  db.prepare('UPDATE OR IGNORE reactions SET target_author = ? WHERE target_author = ?').run(toId, fromId);
  db.prepare('DELETE FROM reactions WHERE author_id = ? OR target_author = ?').run(fromId, fromId);
  db.prepare('UPDATE OR IGNORE conversations SET contact_id = ? WHERE contact_id = ?').run(toId, fromId);

  const oldConv = `dm:${fromId}`;
  const newConv = `dm:${toId}`;
  if (plain(db.prepare('SELECT id FROM conversations WHERE id = ?').get(oldConv))) {
    if (plain(db.prepare('SELECT id FROM conversations WHERE id = ?').get(newConv))) {
      db.prepare('UPDATE OR IGNORE messages SET conversation_id = ? WHERE conversation_id = ?').run(newConv, oldConv);
      db.prepare('UPDATE OR IGNORE reactions SET conversation_id = ? WHERE conversation_id = ?').run(newConv, oldConv);
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(oldConv);
      db.prepare('DELETE FROM reactions WHERE conversation_id = ?').run(oldConv);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(oldConv);
    } else {
      db.prepare('UPDATE conversations SET id = ?, contact_id = ? WHERE id = ?').run(newConv, toId, oldConv);
      db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?').run(newConv, oldConv);
      db.prepare('UPDATE reactions SET conversation_id = ? WHERE conversation_id = ?').run(newConv, oldConv);
    }
  }

  db.prepare('DELETE FROM contacts WHERE id = ?').run(fromId);
}

export function getContact(id) {
  // node:sqlite rejects undefined bindings outright, so guard rather than
  // letting a missing id throw from deep inside a send.
  if (id === undefined || id === null || typeof id !== 'string') return null;
  return plain(selContactById.get(id));
}

export function findContact({ uuid, number }) {
  if (uuid) {
    const c = plain(selContactByUuid.get(uuid));
    if (c) return c;
  }
  if (number) {
    const c = plain(selContactByNumber.get(number));
    if (c) return c;
  }
  return null;
}

export function contactName(c) {
  if (!c) return 'Unknown';
  return c.name || c.profile_name || c.number || c.username || shortId(c.uuid || c.id);
}

const shortId = (v) => (v ? `${String(v).slice(0, 8)}…` : 'Unknown');

/** The address to hand signal-cli when sending: prefer E.164, fall back to ACI. */
export function sendAddress(contact) {
  if (!contact) return null;
  return contact.number || contact.uuid || contact.id;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const selConv = db.prepare('SELECT * FROM conversations WHERE id = ?');
const selConvByInternal = db.prepare('SELECT * FROM conversations WHERE group_internal_id = ?');

export function getConversation(id) {
  return plain(selConv.get(id));
}

export function conversationIdForContact(contactId) {
  return isSelf(contactId) ? `dm:${self.contactId}` : `dm:${contactId}`;
}

function touchConversation(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  db.prepare(
    `UPDATE conversations SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  ).run(...cols.map((c) => fields[c]), now(), id);
}

export function ensureDmConversation(contactId) {
  const contact = getContact(contactId);
  const id = conversationIdForContact(contactId);
  const type = isSelf(contactId) ? 'self' : 'dm';
  const name = type === 'self' ? 'Note to Self' : contactName(contact);

  db.prepare(
    `INSERT INTO conversations (id, type, name, contact_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = CASE WHEN conversations.type = 'self' THEN conversations.name ELSE excluded.name END,
       contact_id = excluded.contact_id,
       updated_at = excluded.updated_at`
  ).run(id, type, name, contactId, now());

  return id;
}

function ensureSelfConversation() {
  if (!self.contactId) return null;
  return ensureDmConversation(self.contactId);
}

/**
 * Groups are addressed two ways: envelopes carry the base64 `internal_id`,
 * while /v1/send wants the `group.xxx` id. We index on the internal id and
 * remember the send id alongside it.
 */
const selConvByGroupId = db.prepare("SELECT * FROM conversations WHERE group_id = ? AND group_id != ''");

export function ensureGroupConversation({ internalId, groupId, name, members, description, hasAvatar }) {
  // The two ids are easy to mix up: envelopes carry the raw base64 internal id
  // while /v2/send wants the "group.xxx" form, and POST /v1/groups only returns
  // the latter. Sort them out here so one group never becomes two rows.
  if (internalId?.startsWith('group.') && !groupId) {
    groupId = internalId;
    internalId = null;
  }
  if (!internalId && !groupId) return null;

  const existing =
    (internalId ? plain(selConvByInternal.get(internalId)) : null) ||
    (groupId ? plain(selConvByGroupId.get(groupId)) : null);

  const id = existing ? existing.id : `group:${internalId || groupId}`;

  db.prepare(
    `INSERT INTO conversations
       (id, type, name, group_id, group_internal_id, members, description, has_avatar, updated_at)
     VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name              = COALESCE(NULLIF(excluded.name, ''), conversations.name),
       group_id          = COALESCE(NULLIF(excluded.group_id, ''), conversations.group_id),
       group_internal_id = COALESCE(NULLIF(excluded.group_internal_id, ''), conversations.group_internal_id),
       members           = COALESCE(excluded.members, conversations.members),
       description       = COALESCE(NULLIF(excluded.description, ''), conversations.description),
       has_avatar        = MAX(excluded.has_avatar, conversations.has_avatar),
       updated_at        = excluded.updated_at`
  ).run(
    id,
    name || '',
    groupId || '',
    internalId || '',
    members ? j(members) : null,
    description || '',
    hasAvatar ? 1 : 0,
    now()
  );

  return id;
}

/** The recipient string signal-cli needs for this conversation. */
export function recipientFor(conv) {
  if (!conv) return null;
  if (conv.type === 'group') return conv.group_id || conv.group_internal_id;
  const contact = getContact(conv.contact_id);
  return sendAddress(contact) || conv.contact_id;
}

export function listConversations() {
  // A conversation with no messages yet is still real — one you just started,
  // a group from the roster, or Note to Self. Hiding it here made new chats
  // vanish on the next page load.
  const rows = plainAll(
    db
      .prepare(
        `SELECT * FROM conversations
          WHERE archived = 0
          ORDER BY last_activity DESC, updated_at DESC`
      )
      .all()
  );
  return rows.map(decorateConversation);
}

export function decorateConversation(conv) {
  if (!conv) return conv;
  const last = plain(
    db
      .prepare(
        `SELECT ts, body, direction, author_name, attachments, sticker, deleted, status, kind
           FROM messages WHERE conversation_id = ? ORDER BY ts DESC LIMIT 1`
      )
      .get(conv.id)
  );

  return {
    id: conv.id,
    type: conv.type,
    name: conv.name || 'Unknown',
    contactId: conv.contact_id,
    groupId: conv.group_id,
    members: unj(conv.members, null),
    description: conv.description || '',
    hasAvatar: !!conv.has_avatar,
    unread: conv.unread,
    muted: !!conv.muted,
    archived: !!conv.archived,
    expiration: conv.expiration,
    lastActivity: conv.last_activity,
    draft: conv.draft || '',
    preview: last
      ? {
          ts: last.ts,
          direction: last.direction,
          authorName: last.author_name,
          status: last.status,
          kind: last.kind,
          text: previewText(last),
        }
      : null,
  };
}

function previewText(m) {
  if (m.deleted) return 'This message was deleted';
  if (m.body) return m.body;
  const atts = unj(m.attachments, []) || [];
  if (atts.length) {
    const a = atts[0];
    const ct = a.contentType || '';
    if (ct.startsWith('image/')) return atts.length > 1 ? `${atts.length} photos` : 'Photo';
    if (ct.startsWith('video/')) return 'Video';
    if (ct.startsWith('audio/')) return 'Voice message';
    return a.filename || 'Attachment';
  }
  if (m.sticker) return 'Sticker';
  return '';
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const insertMessageStmt = db.prepare(
  `INSERT INTO messages
     (conversation_id, ts, server_ts, received_at, direction, author_id, author_name, body,
      attachments, quote, mentions, sticker, previews, text_styles, kind, view_once,
      expires_in, status, client_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(conversation_id, ts, author_id) DO UPDATE SET
     body        = COALESCE(NULLIF(excluded.body, ''), messages.body),
     attachments = COALESCE(excluded.attachments, messages.attachments),
     quote       = COALESCE(excluded.quote, messages.quote),
     mentions    = COALESCE(excluded.mentions, messages.mentions),
     sticker     = COALESCE(excluded.sticker, messages.sticker),
     server_ts   = COALESCE(excluded.server_ts, messages.server_ts)
   RETURNING id`
);

/**
 * Insert a message. Idempotent on (conversation, sent-timestamp, author), which
 * is how Signal itself identifies a message — so replays and the sync copy of
 * something we just sent collapse onto one row.
 */
export function insertMessage(msg) {
  // Whether this is genuinely new decides the unread count: re-ingesting the
  // same envelope (a retry, or the sync echo of something we just sent) must
  // not bump the badge a second time.
  const already = plain(
    db
      .prepare('SELECT id FROM messages WHERE conversation_id = ? AND ts = ? AND author_id = ?')
      .get(msg.conversationId, msg.ts, msg.authorId || 'unknown')
  );

  const row = plain(
    insertMessageStmt.get(
      msg.conversationId,
      msg.ts,
      msg.serverTs ?? null,
      now(),
      msg.direction,
      msg.authorId || 'unknown',
      msg.authorName || '',
      msg.body || '',
      msg.attachments?.length ? j(msg.attachments) : null,
      msg.quote ? j(msg.quote) : null,
      msg.mentions?.length ? j(msg.mentions) : null,
      msg.sticker ? j(msg.sticker) : null,
      msg.previews?.length ? j(msg.previews) : null,
      msg.textStyles?.length ? j(msg.textStyles) : null,
      msg.kind || 'message',
      msg.viewOnce ? 1 : 0,
      msg.expiresIn || 0,
      msg.status || '',
      msg.clientId || null
    )
  );

  const id = row?.id;
  const countsAsUnread = !already && msg.direction === 'in' && msg.kind !== 'event';
  bumpActivity(msg.conversationId, msg.ts, countsAsUnread);
  return id ? getMessage(id) : null;
}

function bumpActivity(conversationId, ts, incrementUnread) {
  db.prepare(
    `UPDATE conversations
        SET last_activity = MAX(last_activity, ?),
            unread = CASE WHEN ? = 1 AND ? > last_read_ts THEN unread + 1 ELSE unread END,
            -- New traffic un-hides a deleted thread: a message must never
            -- arrive into a conversation the user cannot see.
            archived = 0,
            updated_at = ?
      WHERE id = ?`
  ).run(ts, incrementUnread ? 1 : 0, ts, now(), conversationId);
}

const selMessageById = db.prepare('SELECT * FROM messages WHERE id = ?');

export function getMessage(id) {
  return hydrate(plain(selMessageById.get(id)));
}

export function findMessage(conversationId, ts, authorId) {
  return hydrate(
    plain(
      db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? AND ts = ? AND author_id = ?')
        .get(conversationId, ts, authorId)
    )
  );
}

export function getMessages(conversationId, { before, limit = 50 } = {}) {
  const rows = plainAll(
    before
      ? db
          .prepare(
            `SELECT * FROM messages WHERE conversation_id = ? AND ts < ?
              ORDER BY ts DESC LIMIT ?`
          )
          .all(conversationId, before, limit)
      : db
          .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC LIMIT ?')
          .all(conversationId, limit)
  );
  return rows.reverse().map(hydrate);
}

export function searchMessages(query, limit = 60) {
  const rows = plainAll(
    db
      .prepare(
        `SELECT * FROM messages
          WHERE deleted = 0 AND body != '' AND body LIKE ? ESCAPE '\\'
          ORDER BY ts DESC LIMIT ?`
      )
      .all(`%${String(query).replace(/[\\%_]/g, '\\$&')}%`, limit)
  );
  return rows.map(hydrate);
}

const selReactions = db.prepare(
  'SELECT author_id, author_name, emoji, ts FROM reactions WHERE conversation_id = ? AND target_ts = ?'
);

export function hydrate(row) {
  if (!row) return null;
  const reactions = plainAll(selReactions.all(row.conversation_id, row.ts)).map((r) => ({
    authorId: r.author_id,
    authorName: r.author_name,
    emoji: r.emoji,
    ts: r.ts,
    mine: isSelf(r.author_id),
  }));

  return {
    id: row.id,
    conversationId: row.conversation_id,
    ts: row.ts,
    serverTs: row.server_ts,
    direction: row.direction,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.deleted ? '' : row.body,
    attachments: row.deleted ? [] : unj(row.attachments, []) || [],
    quote: unj(row.quote, null),
    mentions: unj(row.mentions, []) || [],
    sticker: unj(row.sticker, null),
    previews: unj(row.previews, []) || [],
    textStyles: unj(row.text_styles, []) || [],
    kind: row.kind,
    editedAt: row.edited_at,
    deleted: !!row.deleted,
    viewOnce: !!row.view_once,
    expiresIn: row.expires_in,
    status: row.status,
    error: row.error,
    clientId: row.client_id,
    reactions,
  };
}

export function updateMessageStatus(id, status, error) {
  const rank = { '': 0, pending: 1, failed: 1, sent: 2, delivered: 3, read: 4 };
  const cur = plain(selMessageById.get(id));
  if (!cur) return null;
  // Receipts can arrive out of order; never walk a message backwards. This
  // includes 'failed': if the recipient already acknowledged the message, a
  // timed-out HTTP call means we lost the response, not the message.
  if ((rank[status] ?? 0) < (rank[cur.status] ?? 0)) return hydrate(cur);
  db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run(status, error || null, id);
  return getMessage(id);
}

/** Apply a delivery/read receipt to every outgoing message with these timestamps. */
export function applyReceipt({ timestamps, status, conversationId }) {
  const touched = [];
  for (const ts of timestamps || []) {
    const rows = plainAll(
      conversationId
        ? db
            .prepare(
              "SELECT id FROM messages WHERE ts = ? AND direction = 'out' AND conversation_id = ?"
            )
            .all(ts, conversationId)
        : db.prepare("SELECT id FROM messages WHERE ts = ? AND direction = 'out'").all(ts)
    );
    for (const r of rows) {
      const m = updateMessageStatus(r.id, status);
      if (m) touched.push(m);
    }
  }
  return touched;
}

export function setReaction({ conversationId, targetTs, targetAuthor, authorId, authorName, emoji, ts, remove }) {
  if (remove) {
    db.prepare(
      'DELETE FROM reactions WHERE conversation_id = ? AND target_ts = ? AND target_author = ? AND author_id = ?'
    ).run(conversationId, targetTs, targetAuthor, authorId);
  } else {
    db.prepare(
      `INSERT INTO reactions (conversation_id, target_ts, target_author, author_id, author_name, emoji, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, target_ts, target_author, author_id)
       DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts, author_name = excluded.author_name`
    ).run(conversationId, targetTs, targetAuthor, authorId, authorName || '', emoji, ts);
  }
  return findMessage(conversationId, targetTs, targetAuthor);
}

export function markDeleted(conversationId, ts, authorId) {
  db.prepare(
    "UPDATE messages SET deleted = 1, body = '', attachments = NULL, sticker = NULL WHERE conversation_id = ? AND ts = ? AND author_id = ?"
  ).run(conversationId, ts, authorId);
  return findMessage(conversationId, ts, authorId);
}

export function applyEdit({ conversationId, targetTs, authorId, body, attachments, mentions, editTs }) {
  const existing = findMessage(conversationId, targetTs, authorId);
  if (!existing) return null;
  db.prepare(
    'UPDATE messages SET body = ?, attachments = ?, mentions = ?, edited_at = ? WHERE conversation_id = ? AND ts = ? AND author_id = ?'
  ).run(
    body || '',
    attachments?.length ? j(attachments) : null,
    mentions?.length ? j(mentions) : null,
    editTs || now(),
    conversationId,
    targetTs,
    authorId
  );
  return findMessage(conversationId, targetTs, authorId);
}

export function markConversationRead(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return null;
  const top = plain(
    db
      .prepare("SELECT MAX(ts) AS ts FROM messages WHERE conversation_id = ? AND direction = 'in'")
      .get(conversationId)
  );
  db.prepare('UPDATE conversations SET unread = 0, last_read_ts = MAX(last_read_ts, ?), updated_at = ? WHERE id = ?').run(
    top?.ts || conv.last_read_ts || 0,
    now(),
    conversationId
  );
  return getConversation(conversationId);
}

/** Timestamps of unacknowledged incoming messages, for read receipts. */
/**
 * Unacknowledged incoming messages, with their authors.
 *
 * A read receipt is addressed to whoever *sent* the message, not to the
 * conversation — so a group needs one receipt per author, and the caller can't
 * work that out from the conversation alone.
 */
export function unreadIncomingTimestamps(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return [];
  return plainAll(
    db
      .prepare(
        `SELECT ts, author_id FROM messages
          WHERE conversation_id = ? AND direction = 'in' AND kind = 'message' AND ts > ?
          ORDER BY ts`
      )
      .all(conversationId, conv.last_read_ts || 0)
  ).map((r) => ({ ts: r.ts, authorId: r.author_id }));
}

/**
 * Erase a conversation's history and hide it from the list.
 *
 * The row itself is kept and flagged rather than deleted, because the roster
 * sync would otherwise recreate any group thread from upstream. A later
 * incoming message unhides it (see bumpActivity) so nothing arrives silently.
 */
export function clearConversation(conversationId) {
  return tx(() => {
    db.prepare('DELETE FROM reactions WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    const res = db
      .prepare(
        `UPDATE conversations
            SET archived = 1, unread = 0, last_activity = 0, last_read_ts = 0, draft = '', updated_at = ?
          WHERE id = ?`
      )
      .run(now(), conversationId);
    return res.changes > 0;
  });
}

export function setDraft(conversationId, draft) {
  db.prepare('UPDATE conversations SET draft = ?, updated_at = ? WHERE id = ?').run(
    draft || '',
    now(),
    conversationId
  );
}

export function setConversationFlags(conversationId, { muted, archived } = {}) {
  const sets = [];
  const vals = [];
  if (muted !== undefined) {
    sets.push('muted = ?');
    vals.push(muted ? 1 : 0);
  }
  if (archived !== undefined) {
    sets.push('archived = ?');
    vals.push(archived ? 1 : 0);
  }
  if (!sets.length) return getConversation(conversationId);
  db.prepare(`UPDATE conversations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...vals,
    now(),
    conversationId
  );
  return getConversation(conversationId);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export function rememberAttachment(att) {
  if (!att?.id) return;
  db.prepare(
    `INSERT INTO attachments (id, content_type, filename, size, width, height)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content_type = COALESCE(NULLIF(excluded.content_type, ''), attachments.content_type),
       filename     = COALESCE(NULLIF(excluded.filename, ''), attachments.filename),
       size         = COALESCE(excluded.size, attachments.size)`
  ).run(
    att.id,
    att.contentType || '',
    att.filename || '',
    att.size || null,
    att.width || null,
    att.height || null
  );
}

export function getAttachment(id) {
  return plain(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
}

export function setAttachmentPath(id, localPath, contentType) {
  db.prepare(
    `INSERT INTO attachments (id, local_path, content_type, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       local_path = excluded.local_path,
       content_type = COALESCE(NULLIF(attachments.content_type, ''), excluded.content_type),
       fetched_at = excluded.fetched_at`
  ).run(id, localPath, contentType || '', now());
}

export { getMeta, setMeta };
