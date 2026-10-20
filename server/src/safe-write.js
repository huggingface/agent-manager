import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const destinationLocks = new Map();
const replacementSecret = crypto.randomBytes(32);

export function fileWriteError(statusCode, code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  Object.assign(error, details);
  return error;
}

/** Serialize only operations that publish to the same resolved destination. */
export async function withDestinationLock(destination, task) {
  const key = path.resolve(destination);
  const previous = destinationLocks.get(key) || Promise.resolve();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => hold);
  destinationLocks.set(key, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (destinationLocks.get(key) === tail) destinationLocks.delete(key);
  }
}

const lstatOrNull = async (file) => {
  try { return await fs.promises.lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};

/** A full content identity, streamed so a large existing file is never buffered. */
export async function fileRevision(file) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw fileWriteError(400, 'unsafe-destination', 'the destination is a symbolic link');
  if (!stat.isFile()) throw fileWriteError(409, 'destination-not-file', 'the destination is not a file');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha256:${stat.size}:${hash.digest('hex')}`;
}

const tokenFor = (destination, revision) => crypto.createHmac('sha256', replacementSecret)
  .update(path.resolve(destination)).update('\0').update(revision).digest('hex');

const matchesToken = (provided, expected) => {
  if (!/^[a-f0-9]{64}$/.test(String(provided || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
};

const collision = async (destination, displayPath, stale = false) => {
  const revision = await fileRevision(destination);
  if (!revision) {
    throw fileWriteError(409, 'replacement-stale', `"${path.basename(displayPath)}" no longer exists — upload it again`, {
      path: displayPath, name: path.basename(displayPath), revision: null, replaceToken: null,
    });
  }
  throw fileWriteError(409, stale ? 'replacement-stale' : 'file-exists', stale
    ? `"${path.basename(displayPath)}" changed after replacement was confirmed`
    : `"${path.basename(displayPath)}" already exists`, {
    path: displayPath,
    name: path.basename(displayPath),
    revision,
    replaceToken: tokenFor(destination, revision),
  });
};

async function openOwnedTemporary(destination, randomBytes = crypto.randomBytes) {
  const dir = path.dirname(destination);
  const base = path.basename(destination).slice(0, 80) || 'upload';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporary = path.join(dir, `.${base}.am-upload-${randomBytes(8).toString('hex')}.part`);
    try {
      const handle = await fs.promises.open(temporary, 'wx');
      return { temporary, handle };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw fileWriteError(503, 'temporary-collision', 'could not reserve a temporary upload file — retry');
}

async function stage(readable, destination, options = {}) {
  const { temporary, handle } = await openOwnedTemporary(destination, options.randomBytes);
  try {
    await pipeline(readable, handle.createWriteStream());
    return temporary;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

// Hard-link publication gives create-only uploads an atomic no-replace commit.
// Some storage adapters do not implement links; COPYFILE_EXCL is the bounded
// fallback. It still refuses a competing creator and Node removes its own
// partial destination if copying fails, but it cannot promise atomic visibility.
async function publishCreate(temporary, destination, options = {}) {
  try {
    await (options.link || fs.promises.link)(temporary, destination);
  } catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error?.code)) throw error;
    await (options.copyFile || fs.promises.copyFile)(temporary, destination, fs.constants.COPYFILE_EXCL);
  }
  await fs.promises.unlink(temporary).catch(() => {});
}

/**
 * Stream a workspace upload beside its destination, then conditionally publish.
 * A replacement token is an HMAC over this exact resolved path and the full
 * current content hash. Tokens die with the server process; after a restart the
 * safe answer is to ask again.
 */
export async function receiveWorkspaceFile(readable, destination, {
  displayPath = path.basename(destination), replaceToken = '', validate = async () => {},
  publishReplacement = fs.promises.rename, publishOptions = {}, randomBytes,
} = {}) {
  return withDestinationLock(destination, async () => {
    const before = await fileRevision(destination);
    if (before) {
      if (!replaceToken) await collision(destination, displayPath);
      if (!matchesToken(replaceToken, tokenFor(destination, before))) await collision(destination, displayPath, true);
    } else if (replaceToken) {
      await collision(destination, displayPath, true);
    }

    await validate();
    let temporary = await stage(readable, destination, { randomBytes });
    try {
      await validate();
      const current = await fileRevision(destination);
      if (!replaceToken) {
        if (current) await collision(destination, displayPath);
        await publishCreate(temporary, destination, publishOptions);
        temporary = null;
      } else {
        if (!current || !matchesToken(replaceToken, tokenFor(destination, current))) {
          await collision(destination, displayPath, true);
        }
        await publishReplacement(temporary, destination);
        temporary = null;
      }
      const after = await fs.promises.stat(destination);
      return { size: after.size, mtime: after.mtimeMs };
    } finally {
      if (temporary) await fs.promises.unlink(temporary).catch(() => {});
    }
  });
}

/** The editor keeps its existing content-tag check but shares owned temp files. */
export async function replaceWorkspaceText(destination, text, validate = async () => {}, options = {}) {
  return withDestinationLock(destination, async () => {
    await validate();
    let temporary = await stage(Readable.from([Buffer.from(text, 'utf8')]), destination, options);
    try {
      await validate();
      await (options.publishReplacement || fs.promises.rename)(temporary, destination);
      temporary = null;
      const after = await fs.promises.stat(destination);
      return { size: after.size, mtime: after.mtimeMs };
    } finally {
      if (temporary) await fs.promises.unlink(temporary).catch(() => {});
    }
  });
}
