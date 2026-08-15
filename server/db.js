import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, randomSecret } from './config.js';
import { log } from './log.js';
import { runMigrations } from './migrate.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
`);

// Bring the schema up to date before anyone prepares a statement against it.
// Top-level await is load-bearing here: `store.js` prepares dozens of
// statements at module scope, and it only imports this module — so importers
// block until migrations have finished.
await runMigrations(db, { backupDir: config.backupDir });

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
