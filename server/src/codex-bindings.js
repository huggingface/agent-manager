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

// read() reads the file, every time, as it always did: it is what every
// identity check and every write runs on, and a stale answer there could let a
// message, approval or interrupt reach a thread whose binding an operator has
// just removed by hand. The one reader that may be stale is the ROSTER:
// /api/tree, /api/meta and /api/sessions consult the bindings on every poll of
// every tab, once for the list and again per Codex row, and on the Space
// DATA_DIR is a FUSE bucket where one openSync parks the event loop for
// 40-115 ms even when the file does not exist (issue #235, A1). snapshot()
// serves that caller from memory.
//
// The snapshot's freshness has two parts. Writes from this process (bind)
// replace the memory copy as they land: this class is the only writer in AM
// and holds the lock. Writes from outside - an operator repairing or removing
// the file, a bucket restore - are picked up by re-reading the file OFF the
// main thread (fs.promises) at most once per STALE_MS while something still
// polls, so the roster can show such an edit up to STALE_MS late and never
// pays a sync round trip for it.
const STALE_MS = 5000;

export class CodexBindings {
  constructor(file, io = fs, { staleMs = STALE_MS } = {}) {
    this.file = file; this.io = io; this.staleMs = staleMs;
    this.cache = null;       // { records } | { error }, plus `at`: what snapshot() answers from
    this.generation = 0;     // bumped by every cache replacement; a refresh that started before one is discarded
    this.refreshing = null;
  }
  /** The bindings as the file holds them now. One sync round trip. The array is frozen. */
  read() {
    const entry = this.#store(this.#readSync());
    if (entry.error) throw entry.error;
    return entry.records;
  }
  forSession(sessionId) { return this.read().find((r) => r.amSessionId === sessionId) || null; }
  /**
   * One indexed view for a whole roster pass, from memory: the same shape as
   * this store (file, read, forSession, resolve) so display helpers take
   * either, but the lookups are Map hits and nothing here touches the file
   * after the first read. An unreadable file throws from every call, as read() would.
   * Display only: never for a decision that sends, binds, launches or stops.
   */
  snapshot() {
    const entry = this.#cached();
    const byId = new Map(entry.records?.map((r) => [r.amSessionId, r]));
    const byThread = new Map(entry.records?.map((r) => [`${r.endpointId}:${r.threadId}`, r]));
    const value = () => { if (entry.error) throw entry.error; return entry.records; };
    return { file: this.file, read: value, forSession: (id) => (value(), byId.get(id) || null),
      resolve: (endpointId, threadId) => { if (!validThreadId(threadId)) throw fail('thread-invalid'); return value(), byThread.get(`${endpointId}:${threadId}`) || null; } };
  }
  #cached() {
    if (!this.cache) this.#store(this.#readSync());
    else if (Date.now() - this.cache.at >= this.staleMs && !this.refreshing) this.#refresh();
    return this.cache;
  }
  #store(entry) { this.cache = { ...entry, at: Date.now() }; this.generation++; return entry; }
  #drop() { this.cache = null; this.generation++; }
  // The stat is checked before any content is read: a file that is not a
  // regular file, or is over 4 MiB, is refused without reading it.
  #admit(st) { if (!st.isFile() || st.size > 4 * 1024 * 1024) throw fail('bindings-invalid'); }
  #parse(text) {
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
      this.#admit(io.fstatSync(fd));
      return { records: this.#parse(io.readFileSync(fd, 'utf8')) };
    } catch (error) {
      return this.#outcome(error);
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  async #readAsync() {
    const io = this.io.promises || fs.promises;
    let fh;
    try {
      fh = await io.open(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      this.#admit(await fh.stat());
      return { records: this.#parse(await fh.readFile('utf8')) };
    } catch (error) {
      return this.#outcome(error);
    } finally { await fh?.close().catch(() => {}); }
  }
  // Stale-while-revalidate: snapshots keep getting the cached answer; the file
  // is re-read in the thread pool and swapped in unless something (a bind, a
  // read, a dropped cache) replaced the cache meanwhile - a late result must
  // never put back what an in-process write already superseded.
  #refresh() {
    const generation = this.generation;
    this.refreshing = this.#readAsync()
      .then((entry) => { if (this.generation === generation) this.#store(entry); }, () => {})
      .finally(() => { this.refreshing = null; });
  }
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
      const records = this.read();
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
      // Whatever the file holds now, the memory copy may not: the next snapshot looks.
      this.#drop();
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
