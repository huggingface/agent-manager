import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// FUSE mounts (including hf-mount) commonly reject fsync on directory fds with
// EINVAL/ENOTSUP/ENOSYS even after the file itself was fsynced and renamed.
// Ignore those non-fatal directory-sync codes unless a caller asks for strictDirSync.
const IGNORABLE_DIR_FSYNC_CODES = new Set([
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EBADF',
  'EPERM',
  'ENOSYS',
  'EISDIR',
]);

/**
 * Leading-dot sibling temporary filename inside `path.dirname(file)`.
 *
 * On hf-mount (#207), any sibling whose name has `path.basename(file)` as a
 * strict prefix (`sessions.json.tmp` or `sessions.json.<uuid>.tmp`) causes an
 * uncached lookup of `sessions.json` to synthesize a phantom directory (`EISDIR`).
 * Starting with `.` guarantees `basename(file)` is never a strict prefix of the
 * temporary filename, while keeping `renameSync` on the same mount.
 */
export function tempPathFor(file, { pid = process.pid, uuid = () => crypto.randomUUID() } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.${pid}-${uuid()}.tmp`);
}

/**
 * Local POSIX shadow path under `$AM_LOCAL/am-control-plane/<hash8>-<basename>`.
 * Keying by a short SHA-256 of `path.resolve(file)` keeps isolated `DATA_DIR`
 * instances from colliding even if they share `AM_LOCAL`.
 */
export function shadowPathFor(file, amLocal = process.env.AM_LOCAL) {
  const root = typeof amLocal === 'string' ? amLocal.trim() : '';
  if (!root) return null;
  const resolved = path.resolve(file);
  const hash8 = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return path.join(path.resolve(root), 'am-control-plane', `${hash8}-${path.basename(resolved)}`);
}

function syncDirectory(dir, { io = fs, strict = false } = {}) {
  let dfd;
  try {
    dfd = io.openSync(dir, 'r');
    io.fsyncSync(dfd);
  } catch (err) {
    if (strict || !IGNORABLE_DIR_FSYNC_CODES.has(err?.code)) throw err;
  } finally {
    if (dfd !== undefined) {
      try { io.closeSync(dfd); } catch {}
    }
  }
}

function writeAtomicFile(file, content, { io = fs, strictDirSync = false, onRenamed, uuid } = {}) {
  const dir = path.dirname(file);
  let tmp;
  let fd;
  let createdTmp = false;
  let renamed = false;
  let primaryError;
  try {
    for (let attempt = 0; ; attempt += 1) {
      tmp = tempPathFor(file, { uuid });
      try {
        fd = io.openSync(tmp, 'wx', 0o600);
        createdTmp = true;
        break;
      } catch (err) {
        if (err?.code === 'EEXIST' && attempt < 4) continue;
        throw err;
      }
    }
    io.writeFileSync(fd, content);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, file);
    renamed = true;
    if (onRenamed) onRenamed();
    syncDirectory(dir, { io, strict: strictDirSync });
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch {}
    }
    if (createdTmp && !renamed && tmp) {
      try {
        io.unlinkSync(tmp);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== 'ENOENT' && !primaryError) throw unlinkErr;
      }
    }
  }
}

function syncShadowFile(file, serialized, { io = fs, amLocal = process.env.AM_LOCAL } = {}) {
  const shadowFile = shadowPathFor(file, amLocal);
  if (!shadowFile || path.resolve(shadowFile) === path.resolve(file)) return false;
  try {
    io.mkdirSync(path.dirname(shadowFile), { recursive: true, mode: 0o700 });
    try {
      if (io.readFileSync(shadowFile, 'utf8') === serialized) return true;
    } catch {
      // Missing or unreadable shadow — write a fresh copy below.
    }
    writeAtomicFile(shadowFile, serialized, { io, strictDirSync: false });
    return true;
  } catch (err) {
    console.error(`[json-store] failed to update local shadow ${shadowFile}:`, err?.message || err);
    return false;
  }
}

function tryReadShadow(file, { validate, io = fs, amLocal = process.env.AM_LOCAL } = {}) {
  const shadowFile = shadowPathFor(file, amLocal);
  if (!shadowFile || path.resolve(shadowFile) === path.resolve(file)) return null;
  try {
    const raw = io.readFileSync(shadowFile, 'utf8');
    const parsed = JSON.parse(raw);
    const value = validate ? validate(parsed) : parsed;
    return { shadowFile, value };
  } catch {
    return null;
  }
}

function quarantineCorruptBytes(file, rawBuffer, { io = fs, now = Date.now } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const stamp = now();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const suffix = attempt === 0 ? `${stamp}` : `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const dest = path.join(dir, `.${base}.corrupt-${suffix}`);
    try {
      const fd = io.openSync(dest, 'wx', 0o600);
      try {
        io.writeFileSync(fd, rawBuffer);
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      syncDirectory(dir, { io, strict: false });
      return dest;
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      console.error(`[json-store] failed to quarantine corrupt ${file}:`, err?.message || err);
      return null;
    }
  }
  return null;
}

/**
 * Read and validate a control-plane JSON store without silently turning FUSE
 * errors into mass data loss:
 *   - ENOENT: fresh directory -> empty(), not poisoned.
 *   - Read I/O error (EIO, EISDIR, ESTALE, EAGAIN, EACCES, etc.): recover from
 *     `$AM_LOCAL/am-control-plane` shadow if valid; otherwise return empty()
 *     with `poisoned: true` so subsequent writes refuse to clobber `file`.
 *   - SyntaxError / invalid shape: recover from shadow if valid; otherwise
 *     quarantine a copy to `.${basename}.corrupt-${Date.now()}` and return empty().
 */
export function readJsonStore(file, {
  validate = (v) => v,
  empty = () => null,
  io = fs,
  amLocal = process.env.AM_LOCAL,
  now = Date.now,
} = {}) {
  let rawBuffer;
  try {
    rawBuffer = io.readFileSync(file);
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      return {
        value: empty(),
        poisoned: false,
        error: null,
        recoveredFromShadow: false,
        quarantinedTo: null,
      };
    }
    const recovered = tryReadShadow(file, { validate, io, amLocal });
    if (recovered) {
      console.error(
        `[json-store] read failed on ${file} (${readErr?.code || readErr?.message}); recovered from local shadow ${recovered.shadowFile}`,
      );
      return {
        value: recovered.value,
        poisoned: false,
        error: null,
        recoveredFromShadow: true,
        quarantinedTo: null,
      };
    }
    console.error(
      `[json-store] read failed on ${file} (${readErr?.code || readErr?.message}) with no valid local shadow; poisoning store to prevent overwrite`,
    );
    return {
      value: empty(),
      poisoned: true,
      error: readErr,
      recoveredFromShadow: false,
      quarantinedTo: null,
    };
  }

  try {
    const parsed = JSON.parse(rawBuffer.toString('utf8'));
    const value = validate(parsed);
    syncShadowFile(file, JSON.stringify(value, null, 2), { io, amLocal });
    return {
      value,
      poisoned: false,
      error: null,
      recoveredFromShadow: false,
      quarantinedTo: null,
    };
  } catch (parseErr) {
    const recovered = tryReadShadow(file, { validate, io, amLocal });
    if (recovered) {
      console.error(
        `[json-store] invalid JSON in ${file} (${parseErr?.message || parseErr}); recovered from local shadow ${recovered.shadowFile}`,
      );
      return {
        value: recovered.value,
        poisoned: false,
        error: null,
        recoveredFromShadow: true,
        quarantinedTo: null,
      };
    }
    const quarantinedTo = quarantineCorruptBytes(file, rawBuffer, { io, now });
    console.error(
      `[json-store] corrupt JSON in ${file} (${parseErr?.message || parseErr})${quarantinedTo ? `; quarantined copy to ${quarantinedTo}` : ''}; using empty default`,
    );
    return {
      value: empty(),
      poisoned: false,
      error: null,
      recoveredFromShadow: false,
      quarantinedTo,
    };
  }
}

/** Atomically write JSON to `file` with fsync, then mirror to `$AM_LOCAL` shadow. */
export function writeJsonStore(file, value, {
  io = fs,
  amLocal = process.env.AM_LOCAL,
  strictDirSync = false,
  onRenamed,
  uuid,
} = {}) {
  const serialized = JSON.stringify(value, null, 2);
  writeAtomicFile(file, serialized, { io, strictDirSync, onRenamed, uuid });
  syncShadowFile(file, serialized, { io, amLocal });
}

/** Stateful wrapper tracking `poisoned` across `load()` and `save()`. */
export function createJsonStore(file, {
  validate = (v) => v,
  empty = () => null,
  io = fs,
  amLocal,
} = {}) {
  let poisoned = false;
  let poisonError = null;

  const resolveAmLocal = () => (amLocal !== undefined ? amLocal : process.env.AM_LOCAL);

  return {
    file,
    isPoisoned() {
      return poisoned;
    },
    poisonError() {
      return poisonError;
    },
    shadowPath() {
      return shadowPathFor(file, resolveAmLocal());
    },
    load() {
      const result = readJsonStore(file, {
        validate,
        empty,
        io,
        amLocal: resolveAmLocal(),
      });
      poisoned = result.poisoned;
      poisonError = result.error;
      return result.value;
    },
    save(value, { strictDirSync = false, onRenamed, uuid } = {}) {
      if (poisoned) {
        const detail = poisonError?.code || poisonError?.message || 'unreadable store';
        const err = new Error(`Refusing to overwrite ${file}: previous load failed (${detail})`);
        err.code = 'EJSONSTOREPOISONED';
        err.cause = poisonError;
        throw err;
      }
      writeJsonStore(file, value, {
        io,
        amLocal: resolveAmLocal(),
        strictDirSync,
        onRenamed,
        uuid,
      });
    },
  };
}
