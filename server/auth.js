import crypto from 'node:crypto';
import { config } from './config.js';
import { resolveSessionSecret } from './db.js';

const SECRET = resolveSessionSecret();
export const COOKIE = 'swc_session';
export const authEnabled = !!config.password;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

export function issueToken() {
  const payload = b64(JSON.stringify({ exp: Date.now() + config.sessionDays * 864e5 }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return false;

  const expected = sign(payload);
  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

export function checkPassword(candidate) {
  if (!authEnabled) return true;
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(config.password);
  // Hash both sides so the compare is length-independent.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
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

export function isAuthed(req) {
  if (!authEnabled) return true;
  const cookies = parseCookies(req.headers?.cookie || '');
  return verifyToken(cookies[COOKIE]);
}

/** Express guard for everything under /api except the login handshake. */
export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'authentication required' });
}
