import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { config } from './config.js';
import { log } from './log.js';
import { db } from './db.js';

/**
 * Periodic SQLite snapshots.
 *
 * The live database must never be copied by an external backup job: it runs in
 * WAL mode, so the .db file on its own is missing whatever is still in
 * `-wal`, and a copy taken mid-checkpoint can be torn. SQLite's online backup
 * produces one self-contained, consistent file instead — safe to copy, with no
 * sidecars — and unlike `VACUUM INTO` it yields between pages rather than
 * blocking the event loop (measured on a 12 MB database: 0 ms stall vs 24 ms).
 *
 * Snapshots are written under a dot-prefixed temporary name and renamed into
 * place, so a backup job scanning the directory can never observe a partially
 * written file. `latest.db` always points at the newest good snapshot.
 */

export const backupState = {
  lastRunAt: 0,
  lastSuccessAt: 0,
  lastError: '',
  lastPath: '',
  lastBytes: 0,
  running: false,
};

const LATEST = 'latest.db';

const stamp = (d) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}` +
  `T${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;

/** Take one snapshot. Resolves with its path, or throws. */
export async function runBackup({ reason = 'scheduled' } = {}) {
  if (backupState.running) {
    log.debug('backup already in progress; skipping');
    return null;
  }
  backupState.running = true;
  backupState.lastRunAt = Date.now();

  const dir = config.backupDir;
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.db`);

  try {
    await fs.mkdir(dir, { recursive: true });
    const final = await uniquePath(dir, stamp(new Date()));

    await sqliteBackup(db, tmp, { rate: 200 });

    // A snapshot that isn't readable is worse than no snapshot, because it
    // looks like protection. Prove it opens and passes before publishing it.
    verifySnapshot(tmp);

    // Opening the snapshot to verify it leaves -wal/-shm sidecars next to the
    // temp file; the rename below moves only the main file, so clear them or
    // they pile up in the backup directory forever.
    await Promise.all([
      fs.rm(`${tmp}-wal`, { force: true }),
      fs.rm(`${tmp}-shm`, { force: true }),
    ]);

    await fs.rename(tmp, final);
    await refreshLatest(dir, final);

    const { size } = await fs.stat(final);
    backupState.lastSuccessAt = Date.now();
    backupState.lastError = '';
    backupState.lastPath = final;
    backupState.lastBytes = size;

    await prune(dir);

    log.info(
      `${reason} backup written: ${path.basename(final)} (${(size / 1048576).toFixed(2)} MB)`
    );
    return final;
  } catch (err) {
    backupState.lastError = err.message;
    log.error(`backup failed: ${err.message}`);
    await Promise.all([
      fs.rm(tmp, { force: true }),
      fs.rm(`${tmp}-wal`, { force: true }),
      fs.rm(`${tmp}-shm`, { force: true }),
    ]).catch(() => {});
    throw err;
  } finally {
    backupState.running = false;
  }
}

/**
 * Names carry one-second resolution, so two snapshots in the same second would
 * otherwise rename over each other and silently lose one. Only reachable via
 * the manual trigger in practice, but a backup that quietly vanishes is exactly
 * the failure this module exists to prevent.
 */
async function uniquePath(dir, base) {
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, `signal-web-${base}${n ? `-${n}` : ''}.db`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

function verifySnapshot(file) {
  const snap = new DatabaseSync(file, { readOnly: true });
  try {
    const result = snap.prepare('PRAGMA integrity_check').get();
    const verdict = result?.integrity_check;
    if (verdict !== 'ok') throw new Error(`integrity check returned "${verdict}"`);
    // Cheap sanity check that this is actually our schema.
    snap.prepare('SELECT COUNT(*) AS c FROM messages').get();
  } finally {
    snap.close();
  }
}

/**
 * Point `latest.db` at the newest snapshot, atomically.
 *
 * A hard link costs no extra space and shares the timestamped file's data; the
 * rename over the old name is atomic, so a backup job reading `latest.db`
 * always gets a complete file.
 */
async function refreshLatest(dir, target) {
  const latest = path.join(dir, LATEST);
  const tmp = path.join(dir, `.tmp-latest-${process.pid}.db`);
  await fs.rm(tmp, { force: true }).catch(() => {});

  try {
    await fs.link(target, tmp);
  } catch {
    // Some filesystems refuse hard links; a copy is equally correct, just fatter.
    await fs.copyFile(target, tmp);
  }
  await fs.rename(tmp, latest);
}

/**
 * Keep the newest N snapshots.
 *
 * Ordered by mtime rather than by filename: a disambiguated name like
 * `...Z-2.db` sorts *before* `...Z.db` lexicographically ('-' < '.'), which
 * would delete the wrong files.
 */
async function prune(dir) {
  const keep = config.backupKeep;
  if (keep <= 0) return;

  const names = (await fs.readdir(dir)).filter((f) =>
    /^signal-web-\d{8}T\d{6}Z(-\d+)?\.db$/.test(f)
  );

  const entries = [];
  for (const name of names) {
    try {
      const { mtimeMs } = await fs.stat(path.join(dir, name));
      entries.push({ name, mtimeMs });
    } catch {
      /* vanished under us; nothing to prune */
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const excess = entries.slice(0, Math.max(0, entries.length - keep));
  for (const { name } of excess) {
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
  if (excess.length) log.debug(`pruned ${excess.length} old backup(s)`);
}

export function startBackupLoop() {
  if (!config.backupEnabled) {
    log.info('periodic database backups are disabled');
    return () => {};
  }

  const everyMs = config.backupIntervalHours * 3600 * 1000;
  log.info(
    `database backups every ${config.backupIntervalHours}h into ${config.backupDir} ` +
      `(keeping ${config.backupKeep}); copy ${path.join(config.backupDir, LATEST)}`
  );

  // One shortly after boot so a snapshot exists without waiting a full period.
  const initial = setTimeout(() => {
    runBackup({ reason: 'startup' }).catch(() => {});
  }, 30_000);
  initial.unref?.();

  const timer = setInterval(() => {
    runBackup().catch(() => {});
  }, everyMs);
  timer.unref?.();

  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
