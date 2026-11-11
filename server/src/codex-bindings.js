// Durable attribution, not authentication. This file is owned by AM, never by
// a Codex tool process. All writes use an exclusive lock and atomic replacement.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class CodexBindingError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => new CodexBindingError(code);
export const validThreadId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const validPath = (p) => typeof p === 'string' && path.isAbsolute(p) && !/[\x00-\x1f]/.test(p);
export function endpointIdentity({ socket, home, uid = process.getuid?.() }) {
  if (!validPath(socket) || !validPath(home) || !Number.isSafeInteger(uid)) throw fail('endpoint-invalid');
  return createHash('sha256').update(JSON.stringify([uid, socket, home])).digest('hex');
}
function validate(records) {
  if (!Array.isArray(records) || records.length > 10000) throw fail('bindings-invalid');
  const sessions = new Set(), threads = new Set();
  for (const r of records) {
    if (!r || !validId(r.amSessionId) || !validThreadId(r.amSessionUuid) || !validThreadId(r.threadId)
        || !/^[a-f0-9]{64}$/.test(r.endpointId) || !validPath(r.cwd)
        || !Number.isSafeInteger(r.revision) || r.revision < 1
        || typeof r.boundAt !== 'string' || !Number.isFinite(Date.parse(r.boundAt))) throw fail('bindings-invalid');
    const key = `${r.endpointId}:${r.threadId}`;
    if (sessions.has(r.amSessionId) || threads.has(key)) throw fail('bindings-ambiguous');
    sessions.add(r.amSessionId); threads.add(key);
  }
  return records;
}

// Cached in memory, because read() is on the sidebar's hot path: /api/tree,
// /api/meta and /api/sessions call it on every poll of every tab, and on the
// Space DATA_DIR is a FUSE bucket where one openSync costs the event loop
// 40-115 ms of wall time even when the file does not exist (issue #235, A1).
//
// Freshness has two parts. In-process writes (bind) replace the cache
// themselves: this file is the only writer in AM and holds the lock, so what
// it wrote is what the file holds. Outside writes - an operator repairing or
// removing the file by hand, a bucket restore - are picked up by re-reading
// the file OFF the main thread (fs.promises) at most once per STALE_MS while
// something is still reading, so the hot path makes no sync call at all and a
// hand edit is visible within STALE_MS. The launch gate asks for a fresh read
// (read({ fresh: true })) because that is where a stale answer could start a
// second writer and where "repair the file and retry" must work at once; it
// runs once per launch, not per poll.
const STALE_MS = 5000;

export class CodexBindings {
  constructor(file, io = fs, { staleMs = STALE_MS } = {}) {
    this.file = file; this.io = io; this.staleMs = staleMs;
    this.cache = null;       // { records } | { error }, plus `at`
    this.generation = 0;     // bumped by every cache replacement; a refresh that started before one is discarded
    this.refreshing = null;
  }
  /** Forget what is cached: the next read() goes to the file. Tests and in-process writers. */
  invalidate() { this.cache = null; this.generation++; }
  /**
   * The bindings, from memory. `fresh` reads the file now (one sync round
   * trip) and replaces the cache. The returned array is shared and frozen.
   */
  read({ fresh = false } = {}) {
    if (fresh || !this.cache) this.#store(this.#readSync());
    else if (Date.now() - this.cache.at >= this.staleMs && !this.refreshing) this.#refresh();
    if (this.cache.error) throw this.cache.error;
    return this.cache.records;
  }
  #store(entry) { this.cache = { ...entry, at: Date.now() }; this.generation++; return entry; }
  #parse(st, text) {
    if (!st.isFile() || st.size > 4 * 1024 * 1024) throw fail('bindings-invalid');
    const data = JSON.parse(text);
    if (data?.version !== 1) throw fail('bindings-invalid');
    return Object.freeze(validate(data.bindings));
  }
  #outcome(error) {
    if (error.code === 'ENOENT') return { records: Object.freeze([]) };
    return { error: error instanceof CodexBindingError ? error : fail('bindings-unavailable') };
  }
  #readSync() {
    const io = this.io;
    let fd;
    try {
      fd = io.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      return { records: this.#parse(io.fstatSync(fd), io.readFileSync(fd, 'utf8')) };
    } catch (error) {
      return this.#outcome(error);
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  async #readAsync() {
    const io = this.io.promises || fs.promises;
    let fh;
    try {
      fh = await io.open(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      return { records: this.#parse(await fh.stat(), await fh.readFile('utf8')) };
    } catch (error) {
      return this.#outcome(error);
    } finally { await fh?.close().catch(() => {}); }
  }
  // Stale-while-revalidate: callers keep getting the cached answer; the file is
  // re-read in the thread pool and swapped in unless something (a bind, an
  // invalidate, a fresh read) replaced the cache meanwhile - a late result
  // must never put back what an in-process write already superseded.
  #refresh() {
    const generation = this.generation;
    this.refreshing = this.#readAsync()
      .then((entry) => { if (this.generation === generation) this.#store(entry); }, () => {})
      .finally(() => { this.refreshing = null; });
  }
  forSession(sessionId, options) { return this.read(options).find((r) => r.amSessionId === sessionId) || null; }
  resolve(endpointId, threadId) {
    if (!validThreadId(threadId)) throw fail('thread-invalid');
    return this.read().find((r) => r.endpointId === endpointId && r.threadId === threadId) || null;
  }
  bind({ session, threadId, endpointId, cwd, expectedRevision }) {
    if (session?.cli !== 'codex' || !validId(session.id) || !validThreadId(session.sessionUuid)
        || !validThreadId(threadId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('binding-invalid');
    const io = this.io, lock = `${this.file}.lock`;
    let lockFd, tmp, fd;
    try {
      // A leftover lock is intentionally NOT removed automatically after a crash.
      // The operator must verify that no AM writer is alive before repairing it.
      lockFd = io.openSync(lock, 'wx', 0o600);
      const records = this.read({ fresh: true });
      const current = records.find((r) => r.amSessionId === session.id);
      if (current) {
        if (current.amSessionUuid === session.sessionUuid && current.threadId === threadId
            && current.endpointId === endpointId && current.cwd === cwd
            && (expectedRevision === 0 || expectedRevision === current.revision)) {
          fd = io.openSync(path.dirname(this.file), 'r');
          io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
          return current;
        }
        throw fail('binding-conflict');
      }
      if (expectedRevision !== 0 || records.some((r) => r.endpointId === endpointId && r.threadId === threadId)) throw fail('binding-conflict');
      const record = { amSessionId: session.id, amSessionUuid: session.sessionUuid, endpointId,
        threadId, cwd, revision: 1, boundAt: new Date().toISOString() };
      const next = validate([...records, record]);
      tmp = `${this.file}.${randomUUID()}.tmp`;
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeFileSync(fd, JSON.stringify({ version: 1, bindings: next }, null, 2) + '\n');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(tmp, this.file); tmp = undefined;
      // No success before both the file and directory entry are durable. If the
      // directory sync fails, report uncertainty; retry observes the same tuple.
      fd = io.openSync(path.dirname(this.file), 'r');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      this.#store({ records: next });
      return record;
    } catch (error) {
      // Whatever the file holds now, the cache may not: the next read looks.
      this.invalidate();
      if (error instanceof CodexBindingError) throw error;
      if (error.code === 'EEXIST' && lockFd === undefined) throw fail('bindings-busy');
      throw fail('bindings-write-failed');
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (tmp) { try { io.unlinkSync(tmp); } catch {} }
      if (lockFd !== undefined) { io.closeSync(lockFd); io.unlinkSync(lock); }
    }
  }
}
