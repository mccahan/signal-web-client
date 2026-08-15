import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { log } from './log.js';

/**
 * Schema migrations.
 *
 * Runs at database-open time, before anything prepares a statement — `store.js`
 * prepares dozens at module scope, so the schema has to be settled first.
 *
 * A migration is a file in `migrations/` named `<number>-<name>.sql` or
 * `<number>-<name>.mjs`. SQL files are executed as-is; `.mjs` files export
 * `up(db)` and can do data transforms that SQL alone can't express. Each runs
 * once, inside a transaction, in numeric order, and is recorded in
 * `schema_migrations`.
 *
 * `.mjs` rather than `.js` deliberately: a `.js` migration is only ESM if the
 * nearest package.json says so, which makes the loader depend on where the
 * file happens to sit.
 *
 * Adding one: drop a new higher-numbered file in. Never edit an applied
 * migration — its checksum is recorded and a change is reported on next boot.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function ensureBookkeeping(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      ms         INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** Discover migration files, ordered by their numeric prefix. */
export function discoverMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => /^\d+-.+\.(sql|mjs)$/.test(f));

  const seen = new Map();
  const migrations = files
    .map((file) => {
      const id = Number(file.match(/^(\d+)/)[1]);
      if (seen.has(id)) {
        throw new Error(
          `duplicate migration id ${id}: "${file}" and "${seen.get(id)}" — ids must be unique`
        );
      }
      seen.set(id, file);

      const full = path.join(dir, file);
      const source = fs.readFileSync(full, 'utf8');
      return { id, file, path: full, checksum: sha256(source), source, kind: path.extname(file) };
    })
    .sort((a, b) => a.id - b.id);

  return migrations;
}

/**
 * Snapshot the database before the first migration of a run.
 *
 * VACUUM INTO (rather than the async backup used elsewhere) because this runs
 * during module initialisation, and a self-contained file is exactly what you
 * want to restore from if a migration goes wrong.
 */
function snapshotBefore(db, backupDir, fromVersion) {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const target = path.join(backupDir, `pre-migration-v${fromVersion}-${stamp}.db`);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    log.info(`pre-migration snapshot written to ${path.basename(target)}`);
    return target;
  } catch (err) {
    // Worth knowing about, but not a reason to refuse to start.
    log.warn(`could not write a pre-migration snapshot: ${err.message}`);
    return null;
  }
}

async function applyOne(db, migration) {
  if (migration.kind === '.mjs') {
    const mod = await import(pathToFileURL(migration.path).href);
    if (typeof mod.up !== 'function') {
      throw new Error(`${migration.file} must export an up(db) function`);
    }
    mod.up(db);
  } else {
    db.exec(migration.source);
  }
}

/**
 * Bring the database up to date. Returns the migrations that were applied.
 */
export async function runMigrations(db, { backupDir, dir = MIGRATIONS_DIR } = {}) {
  ensureBookkeeping(db);

  const available = discoverMigrations(dir);
  const applied = new Map(
    db.prepare('SELECT id, name, checksum FROM schema_migrations').all().map((r) => [r.id, r])
  );

  // An applied migration whose file has since changed means the database and
  // the code no longer agree about history. Don't rewrite it silently.
  for (const m of available) {
    const record = applied.get(m.id);
    if (record && record.checksum !== m.checksum) {
      log.warn(
        `migration ${m.file} has changed since it was applied ` +
          `(recorded ${record.checksum}, now ${m.checksum}). ` +
          'Applied migrations should never be edited; add a new one instead.'
      );
    }
  }

  const pending = available.filter((m) => !applied.has(m.id));
  if (!pending.length) {
    log.debug(`schema up to date (${applied.size} migration(s) applied)`);
    return [];
  }

  const currentVersion = applied.size ? Math.max(...applied.keys()) : 0;
  log.info(
    `applying ${pending.length} migration(s): ${pending.map((m) => m.file).join(', ')}`
  );

  // Only snapshot when there is an existing schema worth protecting.
  if (applied.size > 0 && backupDir) snapshotBefore(db, backupDir, currentVersion);

  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, checksum, applied_at, ms) VALUES (?, ?, ?, ?, ?)'
  );

  for (const m of pending) {
    const started = Date.now();
    db.exec('BEGIN');
    try {
      await applyOne(db, m);
      record.run(m.id, m.file, m.checksum, Date.now(), Date.now() - started);
      db.exec('COMMIT');
      log.info(`  migrated ${m.file} (${Date.now() - started}ms)`);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      // Stop here rather than pressing on: later migrations assume this one
      // landed, and a half-migrated database is worse than a refusal to start.
      throw new Error(`migration ${m.file} failed: ${err.message}`);
    }
  }

  return pending;
}

/** For diagnostics: what has been applied, and what is outstanding. */
export function migrationStatus(db, dir = MIGRATIONS_DIR) {
  ensureBookkeeping(db);
  const applied = db
    .prepare('SELECT id, name, checksum, applied_at, ms FROM schema_migrations ORDER BY id')
    .all();
  const appliedIds = new Set(applied.map((r) => r.id));
  const pending = discoverMigrations(dir)
    .filter((m) => !appliedIds.has(m.id))
    .map((m) => m.file);

  return {
    version: applied.length ? Math.max(...appliedIds) : 0,
    applied: applied.map((r) => ({ ...r })),
    pending,
  };
}
