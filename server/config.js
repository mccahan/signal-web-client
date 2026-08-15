import path from 'node:path';
import crypto from 'node:crypto';

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, dflt) => (v === undefined || v === '' ? dflt : Number(v));

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  // Where signal-cli-rest-api lives. No trailing slash.
  apiUrl: (process.env.SIGNAL_API_URL || 'http://10.0.1.197:8095').replace(/\/+$/, ''),
  // Which registered account to use. Auto-detected from /v1/accounts when blank.
  number: process.env.SIGNAL_NUMBER || '',

  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',

  dataDir,
  dbPath: path.join(dataDir, 'signal-web.db'),
  mediaDir: path.join(dataDir, 'media'),

  // Optional shared password. Blank disables auth entirely (fine on a trusted LAN).
  password: process.env.AUTH_PASSWORD || '',
  // Persisted to the DB on first boot if not supplied, so sessions survive restarts.
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: num(process.env.SESSION_DAYS, 30),
  // Sessions unused for this long are pruned even if the cookie hasn't expired.
  // 0 disables idle pruning.
  sessionIdleDays: num(process.env.SESSION_IDLE_DAYS, 14),
  secureCookie: bool(process.env.SECURE_COOKIE, false),

  // Poll tuning (only used when the API server is in native/normal mode).
  // Each receive call costs ~2s of signal-cli startup, so the timeout is the
  // *extra* time we're willing to hold the single API lane open.
  receiveTimeout: num(process.env.RECEIVE_TIMEOUT, 1),
  // Longer poll when nobody has the UI open, to cut idle load. Kept modest:
  // an in-flight idle poll can't be cancelled without risking message loss
  // (signal-cli drops messages from the server queue as it reads them), so
  // this is also the worst-case wait for the first send after opening the app.
  idleReceiveTimeout: num(process.env.IDLE_RECEIVE_TIMEOUT, 5),
  // Pause between receive cycles when no browser is connected.
  idlePollGap: num(process.env.IDLE_POLL_GAP_MS, 5000),

  // Send read receipts to the sender when you open a conversation.
  sendReadReceipts: bool(process.env.SEND_READ_RECEIPTS, true),
  // Broadcast your typing state to the other side.
  sendTypingIndicators: bool(process.env.SEND_TYPING_INDICATORS, true),

  // Max upload size for outgoing attachments (base64 inflates by ~33%).
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 100 * 1024 * 1024),

  // Ceiling on outbound messages, reactions and remote deletes, shared by every
  // signed-in browser because they all drive one Signal account. Sized so a
  // person never reaches it and a loop does. 0 disables the limit.
  sendRatePerMinute: num(process.env.SEND_RATE_PER_MINUTE, 30),
  // How many may go out back to back before the sustained rate applies.
  sendBurst: num(process.env.SEND_BURST, 15),

  // How long to trust the cached contact/group roster before refreshing.
  rosterTtlMs: num(process.env.ROSTER_TTL_MS, 5 * 60 * 1000),

  // Periodic consistent snapshots of the database. The live file is in WAL
  // mode and unsafe for an external backup job to copy; these are not.
  backupEnabled: bool(process.env.BACKUP_ENABLED, true),
  backupDir: path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups')),
  backupIntervalHours: num(process.env.BACKUP_INTERVAL_HOURS, 6),
  backupKeep: num(process.env.BACKUP_KEEP, 7),

  logLevel: process.env.LOG_LEVEL || 'info',
};

export function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}
