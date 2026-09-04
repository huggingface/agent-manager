import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Revision changes on append (including SQLite WAL writes); generation changes
// on replacement. Neither exposes a source path in a client cursor.
const identities = new Map();
export async function traceRevision(file, stat, database = false) {
  const wal = database ? await fs.stat(`${file}-wal`).catch(() => null) : null;
  const revision = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${wal?.mtimeMs || 0}:${wal?.size || 0}`;
  const prior = identities.get(file);
  if (prior?.revision === revision && prior.ino === stat.ino) return prior;
  const handle = await fs.open(file, 'r');
  let prefix;
  try {
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  // A SQLite header is mutable; its file identity, not its header contents,
  // identifies a generation. Shrinking is checked against the cursor separately.
  let generation = createHash('sha256').update(file).update(String(stat.ino))
    .update(database ? '' : prefix).digest('hex').slice(0, 24);
  const fingerprint = generation;
  if (!database && prior && prior.fingerprint === fingerprint) {
    generation = stat.size <= prior.size
      ? createHash('sha256').update(prior.generation + revision).digest('hex').slice(0, 24)
      : prior.generation;
  }
  const value = { generation, fingerprint, revision, size: stat.size, ino: stat.ino };
  identities.delete(file);
  identities.set(file, value);
  while (identities.size > 128) identities.delete(identities.keys().next().value);
  return value;
}

const cache = new Map();
const pending = new Map();
const MAX_BYTES = 64 * 1024 * 1024;
let retainedBytes = 0;

/** Bounded per-revision LRU plus single flight; rejection never poisons a key. */
export async function cachedTrace(key, bytes, read) {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit.value; }
  if (pending.has(key)) return pending.get(key);
  const promise = Promise.resolve().then(read).then((value) => {
    if (bytes <= MAX_BYTES) {
      while (cache.size && (cache.size >= 8 || retainedBytes + bytes > MAX_BYTES)) {
        const oldest = cache.keys().next().value;
        retainedBytes -= cache.get(oldest).bytes;
        cache.delete(oldest);
      }
      cache.set(key, { value, bytes }); retainedBytes += bytes;
    }
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
