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

export class CodexBindings {
  constructor(file, io = fs) { this.file = file; this.io = io; }
  read() {
    const io = this.io;
    let fd;
    try {
      fd = io.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = io.fstatSync(fd);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) throw fail('bindings-invalid');
      const data = JSON.parse(io.readFileSync(fd, 'utf8'));
      if (data?.version !== 1) throw fail('bindings-invalid');
      return validate(data.bindings);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error instanceof CodexBindingError) throw error;
      throw fail('bindings-unavailable');
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  forSession(sessionId) { return this.read().find((r) => r.amSessionId === sessionId) || null; }
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
      return record;
    } catch (error) {
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
