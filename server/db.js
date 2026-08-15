import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, randomSecret } from './config.js';
import { log } from './log.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per browser login. The cookie carries only this row's id, so a
-- session can be revoked without rotating the signing secret (which would sign
-- everyone out).
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  label         TEXT,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- One row per person we know about. Keyed by the stable Signal ACI (uuid) when
-- we have one, otherwise by E.164. resolveContact() collapses the two.
CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  uuid          TEXT UNIQUE,
  number        TEXT,
  name          TEXT,
  profile_name  TEXT,
  username      TEXT,
  has_avatar    INTEGER NOT NULL DEFAULT 0,
  avatar_etag   TEXT,
  blocked       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS contacts_number ON contacts(number);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,          -- dm:<uuid|e164>  |  group:<internalId>
  type          TEXT NOT NULL,             -- 'dm' | 'group' | 'self'
  name          TEXT,
  contact_id    TEXT,                      -- for dm/self
  group_id      TEXT,                      -- signal-cli "group.xxx" send id
  group_internal_id TEXT,                  -- base64 id seen in envelopes
  members       TEXT,                      -- JSON array, groups only
  description   TEXT,
  has_avatar    INTEGER NOT NULL DEFAULT 0,
  expiration    INTEGER NOT NULL DEFAULT 0,
  muted         INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  unread        INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER NOT NULL DEFAULT 0,
  last_read_ts  INTEGER NOT NULL DEFAULT 0,
  draft         TEXT,
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS conversations_activity ON conversations(last_activity DESC);
CREATE INDEX IF NOT EXISTS conversations_internal ON conversations(group_internal_id);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  ts            INTEGER NOT NULL,          -- Signal sent-timestamp; the real message identity
  server_ts     INTEGER,
  received_at   INTEGER NOT NULL,
  direction     TEXT NOT NULL,             -- 'in' | 'out'
  author_id     TEXT,                      -- contacts.id of the sender
  author_name   TEXT,
  body          TEXT,
  attachments   TEXT,                      -- JSON array
  quote         TEXT,                      -- JSON object
  mentions      TEXT,                      -- JSON array
  sticker       TEXT,                      -- JSON object
  previews      TEXT,                      -- JSON array
  text_styles   TEXT,                      -- JSON array
  kind          TEXT NOT NULL DEFAULT 'message', -- 'message' | 'event'
  edited_at     INTEGER,
  deleted       INTEGER NOT NULL DEFAULT 0,
  view_once     INTEGER NOT NULL DEFAULT 0,
  expires_in    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT '',  -- '' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
  error         TEXT,
  client_id     TEXT,                      -- echo of the browser's optimistic id
  UNIQUE(conversation_id, ts, author_id)
);
CREATE INDEX IF NOT EXISTS messages_conv_ts ON messages(conversation_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);

CREATE TABLE IF NOT EXISTS reactions (
  conversation_id TEXT NOT NULL,
  target_ts     INTEGER NOT NULL,
  target_author TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  author_name   TEXT,
  emoji         TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, target_ts, target_author, author_id)
);
CREATE INDEX IF NOT EXISTS reactions_target ON reactions(conversation_id, target_ts);

-- Locally cached copies of attachments. signal-cli-rest-api prunes its own
-- attachment store, so we keep our own copy the first time we fetch one.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  content_type  TEXT,
  filename      TEXT,
  size          INTEGER,
  width         INTEGER,
  height        INTEGER,
  local_path    TEXT,
  fetched_at    INTEGER
);
`);

// --- lightweight forward-compatible migrations -----------------------------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    log.info(`migrating: adding ${table}.${column}`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('conversations', 'draft', 'draft TEXT');
ensureColumn('messages', 'client_id', 'client_id TEXT');

// --- meta helpers ----------------------------------------------------------
const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getMeta(key, dflt = null) {
  const row = getMetaStmt.get(key);
  return row ? row.value : dflt;
}
export function setMeta(key, value) {
  setMetaStmt.run(key, String(value));
}

/** Stable session secret so logins survive a restart when none is configured. */
export function resolveSessionSecret() {
  if (config.sessionSecret) return config.sessionSecret;
  let s = getMeta('session_secret');
  if (!s) {
    s = randomSecret();
    setMeta('session_secret', s);
  }
  return s;
}

/** Row objects from node:sqlite have a null prototype; normalise for safety. */
export function plain(row) {
  return row ? { ...row } : row;
}
export function plainAll(rows) {
  return rows.map((r) => ({ ...r }));
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

process.on('exit', () => {
  try {
    db.close();
  } catch {
    /* nothing to do at exit */
  }
});

log.info(`database ready at ${path.relative(process.cwd(), config.dbPath)}`);
