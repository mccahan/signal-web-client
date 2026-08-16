import crypto from 'node:crypto';
import { db, plain, plainAll } from './db.js';
import { config } from './config.js';
import { log } from './log.js';

/**
 * Server-side browser sessions.
 *
 * The cookie carries a signed session id rather than a self-contained claim, so
 * an individual login can be revoked (a stateless token can only be invalidated
 * by rotating the signing secret, which signs every device out).
 */

const DAY = 864e5;
// last_seen is only rewritten this often, to keep reads from turning into a
// write on every single request.
const TOUCH_INTERVAL_MS = 60_000;

export function createSession({ userAgent, ip }) {
  const id = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();

  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, expires_at, user_agent, ip, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    now,
    now,
    now + config.sessionDays * DAY,
    (userAgent || '').slice(0, 400),
    ip || '',
    describeClient(userAgent)
  );

  return id;
}

export function getSession(id) {
  if (typeof id !== 'string' || !id) return null;
  return plain(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
}

/** Valid = exists, not revoked, not expired. */
export function isSessionValid(id) {
  const s = getSession(id);
  if (!s) return false;
  if (s.revoked_at) return false;
  if (s.expires_at <= Date.now()) return false;
  return true;
}

export function touchSession(id, { ip } = {}) {
  const s = getSession(id);
  if (!s) return;
  const now = Date.now();
  if (now - s.last_seen_at < TOUCH_INTERVAL_MS && (!ip || ip === s.ip)) return;
  // Single quotes: node:sqlite parses a double-quoted token as an identifier,
  // so NULLIF(?, "") raises `no such column: ""` rather than comparing to an
  // empty string. Only reachable once a session is touched from a new IP after
  // TOUCH_INTERVAL_MS, which is why it hid until a phone changed network.
  db.prepare("UPDATE sessions SET last_seen_at = ?, ip = COALESCE(NULLIF(?, ''), ip) WHERE id = ?").run(
    now,
    ip || '',
    id
  );
}

export function revokeSession(id) {
  const res = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id);
  return res.changes > 0;
}

export function revokeAllExcept(keepId) {
  const res = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id != ?')
    .run(Date.now(), keepId || '');
  return res.changes;
}

export function listSessions() {
  return plainAll(
    db
      .prepare(
        `SELECT * FROM sessions
          WHERE revoked_at IS NULL AND expires_at > ?
          ORDER BY last_seen_at DESC`
      )
      .all(Date.now())
  );
}

/**
 * Drop sessions that can no longer be used.
 *
 * Revoked rows are kept briefly so a revoked device gets a clean 401 rather
 * than looking like an unknown session, then removed.
 */
export function pruneSessions() {
  const now = Date.now();
  const revokedGrace = now - 7 * DAY;

  const expired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
  const revoked = db
    .prepare('DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at <= ?')
    .run(revokedGrace).changes;

  // A session nobody has used in a long time is dead weight even if its cookie
  // has not formally expired.
  const idleCutoff = now - config.sessionIdleDays * DAY;
  const idle = config.sessionIdleDays
    ? db.prepare('DELETE FROM sessions WHERE last_seen_at <= ?').run(idleCutoff).changes
    : 0;

  const total = expired + revoked + idle;
  if (total) {
    log.info(
      `pruned ${total} session(s): ${expired} expired, ${revoked} revoked, ${idle} idle`
    );
  }
  return { expired, revoked, idle };
}

export function startSessionPruneLoop() {
  pruneSessions();
  const timer = setInterval(pruneSessions, 6 * 3600 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Best-effort "Chrome on macOS" style label from a User-Agent string. */
export function describeClient(ua = '') {
  if (!ua) return 'Unknown device';

  // Order matters: most of these also claim "Safari/" for compatibility, so
  // the generic checks have to come last.
  const browser =
    /\bEdg\//.test(ua) ? 'Edge'
    : /\bOPR\/|\bOpera/.test(ua) ? 'Opera'
    : /\bFirefox\//.test(ua) ? 'Firefox'
    : /\bHeadlessChrome\//.test(ua) ? 'Headless Chrome'
    : /\bChrome\//.test(ua) && !/\bChromium\//.test(ua) ? 'Chrome'
    : /\bChromium\//.test(ua) ? 'Chromium'
    : /\bSafari\//.test(ua) ? 'Safari'
    : 'Browser';

  const os =
    /\biPhone\b/.test(ua) ? 'iPhone'
    : /\biPad\b/.test(ua) ? 'iPad'
    : /\bAndroid\b/.test(ua) ? 'Android'
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'macOS'
    : /\bWindows\b/.test(ua) ? 'Windows'
    : /\bCrOS\b/.test(ua) ? 'ChromeOS'
    : /\bLinux\b/.test(ua) ? 'Linux'
    : '';

  return os ? `${browser} on ${os}` : browser;
}
