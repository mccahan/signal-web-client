import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { api } from './signal-api.js';
import { getAttachment, setAttachmentPath } from './store.js';

/** Attachment ids often already carry an extension; don't double it up. */
function localName(id, contentType, filename) {
  const base = id.replace(/[^\w.-]/g, '_');
  const ext =
    (filename ? path.extname(filename) : '') ||
    { 'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3' }[
      contentType
    ] ||
    '';
  return ext && path.extname(base).toLowerCase() !== ext.toLowerCase() ? `${base}${ext}` : base;
}

const inflight = new Map();

/**
 * Return a local copy of an attachment, downloading it once if needed.
 *
 * Concurrent callers share one download: a thread with six photos would
 * otherwise fire six requests into a lane that serialises anyway.
 */
export function cacheAttachment(id) {
  if (inflight.has(id)) return inflight.get(id);

  const job = (async () => {
    const record = getAttachment(id);

    if (record?.local_path) {
      try {
        await fs.access(record.local_path);
        return { path: record.local_path, contentType: record.content_type, filename: record.filename };
      } catch {
        log.debug(`cached attachment ${id} vanished, refetching`);
      }
    }

    const fetched = await api.attachment(id);
    const contentType = record?.content_type || fetched.contentType || 'application/octet-stream';
    const localPath = path.join(config.mediaDir, localName(id, contentType, record?.filename));

    await fs.writeFile(localPath, fetched.buffer);
    setAttachmentPath(id, localPath, contentType);

    return { path: localPath, contentType, filename: record?.filename || '' };
  })().finally(() => inflight.delete(id));

  inflight.set(id, job);
  return job;
}

/**
 * Warm the cache right after a message arrives, so the photo is already on disk
 * by the time the user scrolls to it. Runs on the same lane as everything else,
 * but at background priority, so it only uses gaps between real work.
 */
export function prefetchAttachments(attachments = []) {
  for (const att of attachments) {
    if (!att?.id) continue;
    const record = getAttachment(att.id);
    if (record?.local_path) continue;
    cacheAttachment(att.id).catch((err) =>
      log.debug(`prefetch of ${att.id} failed: ${err.message}`)
    );
  }
}
