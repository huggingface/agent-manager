// Bucket-like latency for one directory tree, loaded with `node --import <this> src/index.js`.
//
// A test fixture, not a suite: helpers/ is below the two depths run-suites scans.
// test/hot-path-sync-fs.test.mjs counts with it (FAKEFS_MS=0); the echo-latency
// bench behind issue #235 times with it.
//
// WHY THIS SHAPE. /data on the Space is a FUSE mount where every round trip to the
// daemon costs 40-115ms and the kernel caches lookups/attrs for ~1s. The cost that
// hurts is the SYNC one: the main thread sleeps in the kernel for the whole call.
// Atomics.wait reproduces exactly that (the thread is parked, uses no CPU, nothing
// else on the loop runs), so a sync call under FAKEFS_ROOT costs FAKEFS_MS of wall
// time on the event loop, like the bucket. Async calls are delayed by a timer
// instead: they cost the caller latency but never block the loop - also like the
// bucket (modulo libuv pool exhaustion, which this does not model).
//
// Every app module does `import fs from 'node:fs'` (or fs/promises default), and
// calls fs.x at call time, so patching the fs object here is seen by all of them,
// exactly as slowfs.js relies on. syncBuiltinESMExports() also covers named imports.
//
// It also COUNTS sync calls under the root, attributed with AsyncLocalStorage to the
// HTTP request (method+path) or ws frame ('ws:i' etc.) that caused them, else to
// 'background'. The parent asks for the tally over IPC: child.send('fakefs-report').
//
// Env:
//   FAKEFS_ROOT       directory whose descendants are "on the bucket" (default DATA_DIR)
//   FAKEFS_MS         cost of one round trip (default 60; 0 = count only, no delay);
//                     changeable at runtime: child.send('fakefs-set:60') (boot fast, then go slow)
//   FAKEFS_CACHE_MS   metadata (stat/lstat/exists/access) of a path answered from
//                     "kernel cache" for this long after a real lookup (default 1000)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isMainThread } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import http from 'node:http';

const ROOT = path.resolve(process.env.FAKEFS_ROOT || process.env.DATA_DIR || '/nonexistent');
let MS = Number(process.env.FAKEFS_MS ?? 60);
const CACHE_MS = Number(process.env.FAKEFS_CACHE_MS ?? 1000);
const META = new Set(['statSync', 'lstatSync', 'existsSync', 'accessSync', 'stat', 'lstat', 'exists', 'access']);

const als = new AsyncLocalStorage();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const metaSeen = new Map(); // path -> last real lookup
const fdsUnder = new Set(); // fds opened under ROOT, so writeSync(fd) etc. count too
const tally = new Map();    // `${ctx}\t${method}\t${rel}` -> { n, ms }
let depth = 0;              // writeFileSync -> openSync/writeSync/closeSync is ONE round trip here

const under = (p) => {
  if (typeof p === 'number') return fdsUnder.has(p);
  if (p instanceof URL) p = p.pathname;
  if (Buffer.isBuffer(p)) p = p.toString();
  if (typeof p !== 'string') return false;
  const abs = path.resolve(p);
  return abs === ROOT || abs.startsWith(ROOT + path.sep);
};
const rel = (p) => (typeof p === 'number' ? `fd` : path.relative(ROOT, path.resolve(String(p instanceof URL ? p.pathname : p))) || '.');
const cost = (method, p) => {
  if (!MS) return 0;
  if (META.has(method) && typeof p !== 'number') {
    const k = path.resolve(String(p)), last = metaSeen.get(k) || 0, now = Date.now();
    if (now - last < CACHE_MS) return 0;
    metaSeen.set(k, now);
  }
  return MS;
};
const count = (method, p, ms) => {
  const key = `${als.getStore() || 'background'}\t${method}\t${rel(p)}`;
  const t = tally.get(key) || { n: 0, ms: 0 };
  t.n++; t.ms += ms; tally.set(key, t);
};

if (isMainThread && ROOT !== '/nonexistent') {
  for (const name of Object.keys(fs).filter((k) => k.endsWith('Sync'))) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    const wrapped = function (...args) {
      if (depth || !(under(args[0]) || (name === 'renameSync' && under(args[1])) || (name === 'copyFileSync' && under(args[1])))) {
        return orig.apply(this, args);
      }
      depth++;
      const t0 = performance.now();
      try {
        const ms = cost(name, args[0]);
        if (ms) Atomics.wait(sleeper, 0, 0, ms);
        const out = orig.apply(this, args);
        if (name === 'openSync' && typeof out === 'number') fdsUnder.add(out);
        if (name === 'closeSync') fdsUnder.delete(args[0]);
        return out;
      } finally {
        depth--;
        count(name, args[0], performance.now() - t0);
      }
    };
    Object.assign(wrapped, orig);
    Object.defineProperty(wrapped, 'name', { value: name });
    fs[name] = wrapped;
  }
  // Async: delay, never block. Promise API and the callback API both.
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const [name, orig] of Object.entries(fs.promises)) {
    if (typeof orig !== 'function') continue;
    fs.promises[name] = async function (...args) {
      if (under(args[0])) { const ms = cost(name, args[0]); if (ms) await delay(ms); }
      return orig.apply(this, args);
    };
  }
  for (const name of ['readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'readdir', 'open', 'rename', 'unlink', 'mkdir', 'rm', 'access', 'copyFile']) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    const wrapped = function (...args) {
      if (!under(args[0])) return orig.apply(this, args);
      const ms = cost(name, args[0]);
      if (!ms) return orig.apply(this, args);
      setTimeout(() => orig.apply(this, args), ms);
    };
    Object.assign(wrapped, orig);
    fs[name] = wrapped;
  }
  syncBuiltinESMExports();

  // Attribution: HTTP requests by route, ws frames by message type.
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (ev, req, ...rest) {
    if (ev === 'request') return als.run(`http ${req.method} ${String(req.url).split('?')[0].replace(/\/[0-9a-f-]{8,}/g, '/:id')}`, () => emit.call(this, ev, req, ...rest));
    return emit.call(this, ev, req, ...rest);
  };
  try {
    const req = createRequire(new URL('../../package.json', import.meta.url));
    const WS = req('ws');
    const wemit = WS.prototype.emit;
    WS.prototype.emit = function (ev, data, ...rest) {
      if (ev !== 'message') return wemit.call(this, ev, data, ...rest);
      let t = '?'; try { t = JSON.parse(String(data)).t; } catch {}
      return als.run(`ws:${t}`, () => wemit.call(this, ev, data, ...rest));
    };
  } catch (e) { console.error('[fakefs] ws attribution unavailable:', e.message); }

  // FAKEFS_PROFILE_MS=100: name the code behind every block over that many ms
  // (V8 sampling profiler, 1ms; the same attribution as watchdog.js summarize()).
  const PROFILE_OVER = Number(process.env.FAKEFS_PROFILE_MS || 0) || Infinity;
  let prof = null;
  if (PROFILE_OVER !== Infinity) {
    const { Session } = await import('node:inspector');
    const session = new Session(); session.connect();
    const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start');
    let busy = false;
    prof = async (gap) => {
      if (busy) return 'busy'; busy = true;
      try {
        const { profile } = await post('Profiler.stop');
        await post('Profiler.start');
        const byId = new Map(profile.nodes.map((n) => [n.id, n])), parent = new Map();
        for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
        const own = (id) => { const chain = []; for (let c = id; c !== undefined; c = parent.get(c)) { const f = byId.get(c)?.callFrame; if (f?.url?.includes('/src/') && !f.url.includes('node_modules')) chain.push(`${f.functionName || '(anon)'} ${f.url.split('/src/')[1]}:${f.lineNumber + 1}`); if (chain.length >= 2) break; } return chain.join(' < ') || `(native) ${byId.get(id)?.callFrame.functionName || ''}`; };
        let ts = profile.startTime; const times = profile.timeDeltas.map((d) => (ts += d));
        const from = profile.endTime - (gap + 20) * 1000, cost = new Map();
        for (let i = 0; i < profile.samples.length; i++) {
          if (times[i] < from) continue;
          const leaf = byId.get(profile.samples[i])?.callFrame.functionName;
          if (leaf === '(idle)' || leaf === '(program)') continue;
          const k = own(profile.samples[i]); cost.set(k, (cost.get(k) || 0) + (times[i] - (times[i - 1] ?? profile.startTime)) / 1000);
        }
        return [...cost].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, ms]) => `${Math.round(ms)}ms ${k}`).join(' | ') || 'no samples (blocked in a syscall)';
      } finally { busy = false; }
    };
  }

  // Event-loop view from inside the server: histogram + discrete blocks >= 50ms.
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const blocks = [];
  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), gap = now - last - 10;
    last = now;
    if (gap >= 50) {
      const b = { at: Date.now(), ms: Math.round(gap) };
      blocks.push(b);
      if (gap >= PROFILE_OVER && prof) prof(gap).then((top) => { b.top = top; }, () => {});
    }
  }, 10).unref();

  process.on('message', (m) => {
    if (typeof m === 'string' && m.startsWith('fakefs-set:')) { MS = Number(m.slice(11)); metaSeen.clear(); process.send?.({ fakefs: 'set', ms: MS }); }
    if (m === 'fakefs-reset') { tally.clear(); blocks.length = 0; h.reset(); process.send?.({ fakefs: 'reset' }); }
    if (m !== 'fakefs-report') return;
    const pct = (q) => Math.round(h.percentile(q) / 1e6 * 10) / 10;
    process.send?.({ fakefs: 'report', loop: { p50: pct(50), p99: pct(99), max: Math.round(h.max / 1e6), count: h.count },
      blocks: blocks.slice(), sync: [...tally].map(([k, v]) => { const [ctx, method, file] = k.split('\t'); return { ctx, method, file, n: v.n, ms: Math.round(v.ms) }; }) });
  });
  console.error(`[fakefs] ${ROOT} costs ${MS}ms per round trip (meta cache ${CACHE_MS}ms)`);
}
