// Experimental observation only. Never start/resume a thread, execute a command,
// pair Remote, or manage the daemon from this adapter.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

const PAGE_SIZE = 20;
const MAX_MESSAGE = 2 * 1024 * 1024;
const METHODS = new Set(['initialize', 'thread/list', 'thread/read']);
export const CONTEXT_GATE = 'Thread context must survive reconnect and server restart before shared launch is enabled.';

export class CodexObservationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => new CodexObservationError(code);

export function observationConfig(env = process.env) {
  const socket = env.AM_CODEX_SHARED_SOCKET;
  const home = env.AM_CODEX_SHARED_HOME;
  if (!socket && !home) return null;
  // Explicit configuration only: no probing other users' homes or starting a daemon.
  if (!socket || !home || !path.isAbsolute(socket) || !path.isAbsolute(home)
      || /[\x00-\x1f]/.test(socket + home)) throw fail('configuration');
  return { socket, home };
}

export async function verifiedSocket(config) {
  const socket = await fs.realpath(config.socket);
  const home = await fs.realpath(config.home);
  const stat = await fs.stat(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw fail('socket-permissions');
  return { socket, home, dev: stat.dev, ino: stat.ino };
}

export class ObservationClient {
  constructor(ws, timeoutMs = 3000) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { this.close('protocol'); return; }
      if (!msg || typeof msg !== 'object') { this.close('protocol'); return; }
      // A read-only client must never answer an approval/tool request.
      if (msg.method) {
        if (msg.id !== undefined) this.close('unexpected-request');
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id); clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(fail('rpc-error'));
      else if (!Object.hasOwn(msg, 'result')) waiter.reject(fail('protocol'));
      else waiter.resolve(msg.result);
    });
    ws.on('error', () => this.close('unavailable'));
    ws.on('close', () => this.close('unavailable'));
  }

  static async connect(config, { timeoutMs = 3000, signal } = {}) {
    if (signal?.aborted) throw fail('cancelled');
    const before = await verifiedSocket(config);
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => net.connect(before.socket),
      handshakeTimeout: timeoutMs, maxPayload: MAX_MESSAGE, followRedirects: false,
    });
    const client = new ObservationClient(ws, timeoutMs);
    const abort = () => client.close('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    client.cleanup = () => signal?.removeEventListener('abort', abort);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { client.close('timeout'); reject(fail('timeout')); }, timeoutMs);
        const done = (fn, value) => { clearTimeout(timer); fn(value); };
        ws.once('open', () => done(resolve));
        ws.once('error', () => done(reject, fail('unavailable')));
        ws.once('close', () => done(reject, fail('unavailable')));
        if (signal?.aborted) abort();
      });
      const after = await verifiedSocket(config);
      if (before.socket !== after.socket || before.dev !== after.dev || before.ino !== after.ino) throw fail('socket-changed');
      const init = await client.call('initialize', {
        clientInfo: { name: 'agent_manager_observer', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      if (typeof init?.codexHome !== 'string' || await fs.realpath(init.codexHome) !== before.home) throw fail('home-mismatch');
      client.version = /\/(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\s|$)/.exec(init.userAgent || '')?.[1] || null;
      ws.send(JSON.stringify({ method: 'initialized' }));
      return client;
    } catch (error) { client.close(); throw error; }
  }

  call(method, params) {
    if (!METHODS.has(method)) return Promise.reject(fail('read-only'));
    if (method === 'thread/read' && params?.includeTurns !== false) return Promise.reject(fail('read-only'));
    if (method === 'thread/list' && (params?.useStateDbOnly !== true || params?.limit !== PAGE_SIZE)) return Promise.reject(fail('read-only'));
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(fail('unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => { if (error) this.close('unavailable'); });
    });
  }

  close(code = 'unavailable') {
    if (this.closed) return;
    this.closed = true;
    this.cleanup?.();
    for (const { timer, reject } of this.pending.values()) { clearTimeout(timer); reject(fail(code)); }
    this.pending.clear();
    this.ws.terminate();
  }
}

export function taskStatus(status) {
  if (status?.type === 'active') {
    if (!Array.isArray(status.activeFlags)) return 'unknown';
    if (status.activeFlags.includes('waitingOnApproval') || status.activeFlags.includes('waitingOnUserInput')) return 'needs-input';
    return 'working';
  }
  return ({ idle: 'idle', notLoaded: 'unloaded', systemError: 'error' })[status?.type] || 'unknown';
}

export async function observeSharedCodex({ config, cursor = null, sessions = [], signal, timeoutMs = 8000 } = {}) {
  const base = { launchEnabled: false, launchBlockedReason: CONTEXT_GATE, observedAt: new Date().toISOString() };
  if (!config) return { ...base, connection: 'not-configured', tasks: [], nextCursor: null };
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096)) throw fail('cursor');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let client;
  try {
    client = await ObservationClient.connect(config, { signal: controller.signal });
    const page = await client.call('thread/list', { limit: PAGE_SIZE, cursor, useStateDbOnly: true });
    if (!Array.isArray(page?.data) || page.data.length > PAGE_SIZE
        || (page.nextCursor != null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4096))) throw fail('protocol');
    const tasks = [];
    // Bounded concurrency. These reads do not load or subscribe to threads.
    for (let i = 0; i < page.data.length; i += 4) {
      tasks.push(...await Promise.all(page.data.slice(i, i + 4).map(async (summary) => {
        if (typeof summary?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.id)) throw fail('protocol');
        let thread;
        try {
          const read = await client.call('thread/read', { threadId: summary.id, includeTurns: false });
          if (read?.thread?.id !== summary.id) throw fail('protocol');
          thread = read.thread;
        } catch { thread = null; }
        return {
          id: summary.id,
          name: typeof summary.name === 'string' ? summary.name.slice(0, 160) : null,
          cwd: typeof summary.cwd === 'string' ? summary.cwd.slice(0, 1024) : null,
          status: thread ? taskStatus(thread.status) : 'unknown',
          // Exact pins only. A shared CWD or matching title never proves ownership.
          amSessions: sessions.filter((s) => s.cli === 'codex' && s.codexSessionId === summary.id)
            .map((s) => ({ id: s.id, name: s.name })),
        };
      })));
    }
    if (controller.signal.aborted || client.closed) throw fail('unavailable');
    return { ...base, connection: 'connected', serverVersion: client.version, tasks, nextCursor: page.nextCursor ?? null };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); client?.close();
  }
}

// Limit observation work independently of how many browser refreshes arrive.
let inFlight = false;
export async function sharedCodexSnapshot(options = {}) {
  if (inFlight) throw fail('busy');
  inFlight = true;
  try { return await observeSharedCodex({ ...options, config: observationConfig() }); }
  finally { inFlight = false; }
}
