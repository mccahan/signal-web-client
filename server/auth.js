import crypto from 'node:crypto';
import { config } from './config.js';
import { resolveSessionSecret } from './db.js';
import { isSessionValid, touchSession } from './sessions.js';

const SECRET = resolveSessionSecret();
export const COOKIE = 'swc_session';
export const authEnabled = !!config.password;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

/** Mint a cookie value for a freshly created session row. */
export function issueToken(sessionId) {
  const payload = b64(JSON.stringify({ sid: sessionId }));
  return `${payload}.${sign(payload)}`;
}

/**
 * Return the session id a cookie vouches for, or null.
 *
 * The signature proves we issued it; the sessions table decides whether it is
 * still allowed to be used, which is what makes revocation possible.
 */
export function sessionIdFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;

  const expected = sign(payload);
  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const { sid } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof sid === 'string' && sid ? sid : null;
  } catch {
    return null;
  }
}

export function checkPassword(candidate) {
  if (!authEnabled) return true;
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(config.password);
  // Use HMAC with a fixed key to produce equal-length digests for a
  // timing-safe comparison that does not expose length information.
  const key = Buffer.alloc(32);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(token) {
  const bits = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionDays * 86400}`,
  ];
  if (config.secureCookie) bits.push('Secure');
  return bits.join('; ');
}

export const clearCookieHeader = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** The live session behind a request, or null. */
export function sessionFor(req) {
  const cookies = parseCookies(req.headers?.cookie || '');
  const sid = sessionIdFromToken(cookies[COOKIE]);
  if (!sid || !isSessionValid(sid)) return null;
  return sid;
}

export function isAuthed(req) {
  if (!authEnabled) return true;
  return !!sessionFor(req);
}

export const clientIp = (req) =>
  (req.headers?.['x-forwarded-for']?.split(',')[0] || '').trim() ||
  req.socket?.remoteAddress ||
  '';

/** Express guard for everything under /api except the login handshake. */
export function requireAuth(req, res, next) {
  if (!authEnabled) return next();

  const sid = sessionFor(req);
  if (!sid) {
    // Clear a cookie that is signed but no longer usable (revoked or expired),
    // so the browser stops presenting it and shows the login screen.
    res.setHeader('Set-Cookie', clearCookieHeader());
    return res.status(401).json({ error: 'authentication required' });
  }

  req.sessionId = sid;
  touchSession(sid, { ip: clientIp(req) });
  next();
}
