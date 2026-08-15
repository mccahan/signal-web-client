import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { api } from '../signal-api.js';
import { bus } from '../bus.js';
import { publicStatus } from '../receiver.js';
import { syncRoster } from '../roster.js';
import {
  self,
  listConversations,
  getConversation,
  decorateConversation,
  getMessages,
  searchMessages,
  ensureDmConversation,
  ensureGroupConversation,
  upsertContact,
  findContact,
  getContact,
  setDraft,
  setConversationFlags,
  markDeleted,
  findMessage,
} from '../store.js';
import {
  sendMessage,
  sendReaction,
  markRead,
  sendTyping,
  deleteForEveryone,
  leaveGroup,
  deleteConversation,
} from '../outbound.js';
import { cacheAttachment } from '../media.js';
import { runBackup, backupState } from '../backup.js';
import {
  authEnabled,
  checkPassword,
  issueToken,
  cookieHeader,
  clearCookieHeader,
  requireAuth,
  isAuthed,
  sessionFor,
  clientIp,
} from '../auth.js';
import {
  createSession,
  listSessions,
  revokeSession,
  revokeAllExcept,
  pruneSessions,
  describeClient,
} from '../sessions.js';

export const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- session ---------------------------------------------------------------

router.get('/session', (req, res) => {
  res.json({ authRequired: authEnabled, authenticated: isAuthed(req) });
});

router.post('/session', (req, res) => {
  if (!authEnabled) return res.json({ authenticated: true });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const sessionId = createSession({
    userAgent: req.headers['user-agent'],
    ip: clientIp(req),
  });
  res.setHeader('Set-Cookie', cookieHeader(issueToken(sessionId)));
  res.json({ authenticated: true });
});

router.delete('/session', (req, res) => {
  // Signing out must invalidate the session server-side, not just drop the
  // cookie — otherwise a copied cookie keeps working.
  const sid = sessionFor(req);
  if (sid) revokeSession(sid);
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.json({ authenticated: false });
});

// Everything past this point needs a session.
router.use(requireAuth);

// --- state -----------------------------------------------------------------

router.get('/me', (req, res) => {
  res.json({
    number: self.number,
    uuid: self.uuid,
    contactId: self.contactId,
    status: publicStatus(),
    features: {
      readReceipts: config.sendReadReceipts,
      typingIndicators: config.sendTypingIndicators,
      maxUploadBytes: config.maxUploadBytes,
    },
  });
});

router.get('/status', (req, res) => res.json(publicStatus()));

// --- browser sessions ------------------------------------------------------

/**
 * Logins known to the server, annotated with which are connected right now.
 *
 * With auth disabled there are no logins to track, so this reports the live
 * connections alone rather than pretending otherwise.
 */
router.get('/sessions', (req, res) => {
  const live = bus.presence();
  const liveBySession = new Map();
  for (const c of live) {
    if (!c.sessionId) continue;
    const entry = liveBySession.get(c.sessionId) || { count: 0, since: c.connectedAt };
    entry.count++;
    entry.since = Math.min(entry.since || c.connectedAt, c.connectedAt);
    liveBySession.set(c.sessionId, entry);
  }

  if (!authEnabled) {
    return res.json({
      authRequired: false,
      sessions: live.map((c, i) => ({
        id: `live-${i}`,
        label: describeClient(c.userAgent),
        ip: c.ip,
        createdAt: c.connectedAt,
        lastSeenAt: Date.now(),
        expiresAt: null,
        connections: 1,
        connected: true,
        current: false,
        revocable: false,
      })),
    });
  }

  const current = sessionFor(req);
  const sessions = listSessions().map((s) => {
    const liveInfo = liveBySession.get(s.id);
    return {
      id: s.id,
      label: s.label || describeClient(s.user_agent),
      ip: s.ip || '',
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      connections: liveInfo?.count || 0,
      connected: !!liveInfo,
      current: s.id === current,
      revocable: true,
    };
  });

  res.json({ authRequired: true, sessions });
});

/** Sign a specific device out. Revoking your own ends this session too. */
router.delete('/sessions/:id', (req, res) => {
  if (!authEnabled) return res.status(400).json({ error: 'Sessions require AUTH_PASSWORD' });

  const id = String(req.params.id);
  if (!revokeSession(id)) return res.status(404).json({ error: 'not found' });

  disconnectSockets((ws) => ws.sessionId === id);

  if (id === sessionFor(req)) res.setHeader('Set-Cookie', clearCookieHeader());
  res.json({ revoked: id });
});

/** Sign out every other device, keeping this one. */
router.post('/sessions/revoke-others', (req, res) => {
  if (!authEnabled) return res.status(400).json({ error: 'Sessions require AUTH_PASSWORD' });

  const current = sessionFor(req);
  const count = revokeAllExcept(current);
  disconnectSockets((ws) => ws.sessionId && ws.sessionId !== current);
  pruneSessions();
  res.json({ revoked: count });
});

/**
 * Close sockets belonging to sessions that just lost access. Without this a
 * revoked device keeps streaming messages over its already-open WebSocket,
 * because authentication is only checked at upgrade time.
 */
function disconnectSockets(match) {
  for (const ws of bus.sockets) {
    if (!match(ws)) continue;
    try {
      ws.close(4001, 'session revoked');
    } catch {
      /* already closing */
    }
  }
}

router.get('/backups', (req, res) => res.json({ ...backupState, dir: config.backupDir }));

/** Take a snapshot now, for testing the backup path without waiting. */
router.post(
  '/backups',
  wrap(async (req, res) => {
    const file = await runBackup({ reason: 'manual' });
    res.json({ path: file, ...backupState });
  })
);

router.get(
  '/conversations',
  wrap(async (req, res) => {
    if (req.query.refresh === '1') await syncRoster({ force: true });
    res.json({ conversations: listConversations() });
  })
);

router.get('/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json({ conversation: decorateConversation(conv) });
});

router.get('/conversations/:id/messages', (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before ? Number(req.query.before) : undefined;
  const messages = getMessages(req.params.id, { before, limit });
  res.json({
    messages,
    hasMore: messages.length === limit,
    conversation: decorateConversation(conv),
  });
});

router.post(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    const message = await sendMessage({
      conversationId: req.params.id,
      body: String(req.body?.body ?? ''),
      attachments: req.body?.attachments || [],
      quote: req.body?.quote || null,
      mentions: req.body?.mentions || [],
      clientId: req.body?.clientId || null,
    });
    res.status(201).json({ message });
  })
);

router.post(
  '/conversations/:id/read',
  wrap(async (req, res) => {
    const conversation = await markRead(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'not found' });
    res.json({ conversation });
  })
);

router.post(
  '/conversations/:id/typing',
  wrap(async (req, res) => {
    await sendTyping(req.params.id, req.body?.started !== false);
    res.status(204).end();
  })
);

router.patch('/conversations/:id', (req, res) => {
  const { muted, archived, draft } = req.body || {};
  // `String(null)` would store the literal text "null" back into the composer.
  if (draft !== undefined) setDraft(req.params.id, draft == null ? '' : String(draft));
  const conv = setConversationFlags(req.params.id, { muted, archived });
  if (!conv) return res.status(404).json({ error: 'not found' });
  const conversation = decorateConversation(getConversation(req.params.id));
  bus.publish('conversation', { conversation });
  res.json({ conversation });
});

router.post(
  '/conversations/:id/reactions',
  wrap(async (req, res) => {
    const { targetTs, targetAuthorId, emoji, remove } = req.body || {};
    if (!targetTs || !emoji) return res.status(400).json({ error: 'targetTs and emoji required' });
    const message = await sendReaction({
      conversationId: req.params.id,
      targetTs: Number(targetTs),
      targetAuthorId: targetAuthorId || self.contactId,
      emoji,
      remove: !!remove,
    });
    res.json({ message });
  })
);

/**
 * Delete a message. `?scope=everyone` retracts it on the recipients' devices
 * too (own messages only); the default just hides it in this client.
 */
router.delete(
  '/conversations/:id/messages/:ts',
  wrap(async (req, res) => {
    const ts = Number(req.params.ts);
    if (!Number.isFinite(ts)) return res.status(400).json({ error: 'bad timestamp' });

    if (req.query.scope === 'everyone') {
      const message = await deleteForEveryone({ conversationId: req.params.id, ts });
      return res.json({ message, scope: 'everyone' });
    }

    // Express parses `?authorId[x]=1` into an object, which SQLite refuses to
    // bind; coerce to a string so a malformed query is a 404, not a 500.
    const authorId =
      typeof req.query.authorId === 'string' && req.query.authorId
        ? req.query.authorId
        : self.contactId;
    const existing = findMessage(req.params.id, ts, authorId);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const message = markDeleted(req.params.id, ts, authorId);
    bus.publish('message_update', { message, reason: 'delete' });
    res.json({ message, scope: 'local' });
  })
);

router.post(
  '/conversations/:id/leave',
  wrap(async (req, res) => {
    const conversation = await leaveGroup(req.params.id);
    bus.publish('conversation', { conversation });
    res.json({ conversation });
  })
);

/** Removes the thread here; for a group it also deletes the group itself. */
router.delete(
  '/conversations/:id',
  wrap(async (req, res) => {
    const result = await deleteConversation(req.params.id);
    res.json(result);
  })
);

// --- starting new conversations -------------------------------------------

router.post(
  '/conversations',
  wrap(async (req, res) => {
    const raw = String(req.body?.recipient || '').trim();
    if (!raw) return res.status(400).json({ error: 'recipient required' });

    const number = normalizeNumber(raw);
    if (!number) {
      return res.status(400).json({
        error: 'Enter a phone number in international format, e.g. +13035550123',
      });
    }

    // Ask Signal whether this number is actually reachable before we create a
    // conversation the user can never send to.
    try {
      const found = await api.search(self.number, number);
      const hit = Array.isArray(found) ? found[0] : null;
      if (hit && hit.registered === false) {
        return res.status(404).json({ error: `${number} is not on Signal` });
      }
      if (hit?.uuid) upsertContact({ uuid: hit.uuid, number });
    } catch (err) {
      log.debug(`recipient lookup failed, continuing anyway: ${err.message}`);
    }

    const existing = findContact({ number });
    const contactId = existing ? existing.id : upsertContact({ number });
    const id = ensureDmConversation(contactId);
    const conversation = decorateConversation(getConversation(id));
    bus.publish('conversation', { conversation });
    res.status(201).json({ conversation });
  })
);

router.post(
  '/groups',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const members = (req.body?.members || []).map(normalizeNumber).filter(Boolean);
    if (!name) return res.status(400).json({ error: 'group name required' });
    if (!members.length) return res.status(400).json({ error: 'at least one member required' });

    const created = await api.createGroup(self.number, { name, members });
    // The create response carries only the "group.xxx" send id, so let the
    // roster tell us the internal id that inbound envelopes will use.
    await syncRoster({ force: true });

    const id = ensureGroupConversation({
      internalId: created?.internal_id,
      groupId: created?.id,
      name,
      members,
    });
    const conversation = decorateConversation(getConversation(id));
    bus.publish('conversation', { conversation });
    res.status(201).json({ conversation });
  })
);

function normalizeNumber(input) {
  const raw = String(input || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return /^\+\d{7,15}$/.test(digits) ? digits : null;
  // Bare 10-digit input is assumed to share the account's country code.
  if (/^\d{10}$/.test(digits) && self.number.startsWith('+1')) return `+1${digits}`;
  if (/^\d{11,15}$/.test(digits)) return `+${digits}`;
  return null;
}

// --- contacts & search -----------------------------------------------------

router.get('/contacts', (req, res) => {
  const conversations = listConversations();
  res.json({ conversations });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ messages: [] });
  const messages = searchMessages(q).map((m) => {
    const conv = getConversation(m.conversationId);
    return { ...m, conversationName: conv?.name || '', conversationType: conv?.type };
  });
  res.json({ messages });
});

// --- media -----------------------------------------------------------------

/**
 * Serve an attachment, caching it on the way through. signal-cli-rest-api
 * discards its own copies over time, so the first fetch is also the last chance
 * to keep one.
 */
router.get(
  '/attachments/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    // Reject pure-dot names too: "." and ".." resolve back to the media
    // directory itself, which then fails as EISDIR rather than 404.
    if (!/^[\w.@-]{1,200}$/.test(id) || /^\.+$/.test(id)) {
      return res.status(400).json({ error: 'bad id' });
    }

    let cached;
    try {
      cached = await cacheAttachment(id);
    } catch (err) {
      const status = err.status === 404 ? 404 : 502;
      return res.status(status).json({ error: `attachment unavailable: ${err.message}` });
    }

    streamFile(res, cached.path, cached.contentType, cached.filename, req.query.download);
  })
);

function streamFile(res, filePath, contentType, filename, download) {
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (download) {
    const name = (filename || path.basename(filePath)).replace(/["\\]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }

  const stream = fs.createReadStream(filePath);

  // pipe() does not forward source errors, and an unhandled 'error' on a
  // ReadStream takes the process down — one unreadable file would otherwise
  // disconnect every other user.
  stream.on('error', (err) => {
    log.warn(`failed to stream ${filePath}: ${err.message}`);
    if (!res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).end();
    else res.destroy(err);
  });

  // Don't keep reading into a socket the browser already abandoned.
  res.on('close', () => stream.destroy());

  stream.pipe(res);
}

/** Avatars for the conversation list. Cached to disk with a short TTL. */
router.get(
  '/avatars/:conversationId',
  wrap(async (req, res) => {
    const conv = getConversation(req.params.conversationId);
    if (!conv) return res.status(404).end();

    const key = `avatar_${req.params.conversationId.replace(/[^\w.-]/g, '_')}`;
    const cachePath = path.join(config.mediaDir, key);
    const metaPath = `${cachePath}.json`;

    try {
      const stat = await fsp.stat(cachePath);
      if (Date.now() - stat.mtimeMs < 6 * 3600 * 1000) {
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8').catch(() => '{}'));
        if (stat.size === 0) return res.status(404).end();
        return streamFile(res, cachePath, meta.contentType || 'image/jpeg');
      }
    } catch {
      /* not cached yet */
    }

    let result = null;
    try {
      if (conv.type === 'group') {
        // Group path parameters take the "group.xxx" send id — the raw internal
        // id 404s here.
        result = await api.groupAvatar(self.number, conv.group_id || conv.group_internal_id);
      } else {
        const contact = getContact(conv.contact_id);
        if (contact?.uuid) result = await api.contactAvatar(self.number, contact.uuid);
      }
    } catch (err) {
      log.debug(`avatar fetch failed for ${req.params.conversationId}: ${err.message}`);
    }

    if (!result?.buffer?.length) {
      // Negative-cache so we don't hammer the lane for someone with no avatar.
      await fsp.writeFile(cachePath, Buffer.alloc(0));
      await fsp.writeFile(metaPath, JSON.stringify({ contentType: '' }));
      return res.status(404).end();
    }

    await fsp.writeFile(cachePath, result.buffer);
    await fsp.writeFile(metaPath, JSON.stringify({ contentType: result.contentType }));
    streamFile(res, cachePath, result.contentType);
  })
);

// --- errors ----------------------------------------------------------------

router.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error(`${req.method} ${req.originalUrl}:`, err.message);
  res.status(status).json({ error: err.message || 'internal error' });
});
