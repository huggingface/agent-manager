// Is this Space's data going to survive a restart?
//
// entrypoint.sh tries the bucket mount at /data first. On a freshly duplicated
// Space there is no bucket, and /data is either missing or an ordinary folder
// on the container's own disk: if it cannot be written, entrypoint falls back
// to $HOME/data ("running EPHEMERAL"); if it can, the app runs there and the
// folder vanishes with the container all the same. So "DATA_DIR is /data" is
// not enough — /data has to be a mount, and only /proc/mounts says that.
//
// Off a Space (a laptop, a server) the disk is the operator's own and durable,
// so it counts as persistent and the app never asks about a bucket.
import fs from 'node:fs';
import path from 'node:path';

export const BUCKET_MOUNT = '/data';
// Filesystems that live in memory: a mount at /data of one of these is still
// gone after a restart.
const VOLATILE = new Set(['tmpfs', 'ramfs']);

/** The mount points listed in /proc/mounts text (octal escapes undone). */
export function mountPoints(text) {
  const points = new Map();
  for (const line of String(text).split('\n')) {
    const [, where, type] = line.split(' ');
    if (!where) continue;
    points.set(where.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))), type);
  }
  return points;
}

/**
 * { persistent, dataDir, reason }. `reason` is one of:
 *   not-a-space         no SPACE_ID: local install, its disk is durable
 *   mounted             DATA_DIR is /data and a bucket is mounted there
 *   fallback            DATA_DIR is not /data (entrypoint fell back to $HOME/data)
 *   not-mounted         DATA_DIR is /data but nothing is mounted there
 *   volatile-mount      /data is mounted, but in memory (tmpfs)
 *   mounts-unreadable   /proc/mounts could not be read
 */
export function storageStatus({ env = process.env, dataDir, readMounts = () => fs.readFileSync('/proc/mounts', 'utf8') } = {}) {
  const dir = path.resolve(dataDir);
  if (!env.SPACE_ID) return { persistent: true, dataDir: dir, reason: 'not-a-space' };
  if (dir !== BUCKET_MOUNT) return { persistent: false, dataDir: dir, reason: 'fallback' };
  let points;
  try { points = mountPoints(readMounts()); } catch { return { persistent: false, dataDir: dir, reason: 'mounts-unreadable' }; }
  if (!points.has(BUCKET_MOUNT)) return { persistent: false, dataDir: dir, reason: 'not-mounted' };
  if (VOLATILE.has(points.get(BUCKET_MOUNT))) return { persistent: false, dataDir: dir, reason: 'volatile-mount' };
  return { persistent: true, dataDir: dir, reason: 'mounted' };
}

// A mount only appears or disappears across a restart (attaching a bucket
// restarts the Space), and /api/info is polled by every open tab, so the answer
// is read once per process.
let cached = null;
export function storage(dataDir) {
  cached ??= storageStatus({ dataDir });
  return cached;
}
