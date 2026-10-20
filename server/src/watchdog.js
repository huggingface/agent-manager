import { Worker } from 'node:worker_threads';

// Observability that survives a BLOCKED event loop. When the main thread wedges
// on synchronous work (the FUSE/SQLite class of bug), in-process HTTP dies and
// main-thread timers can't fire — so nothing gets logged until/unless the loop
// recovers, and it may never. A worker thread has its OWN event loop and keeps
// watching regardless: it reports the stall to stderr (→ the Space's run logs)
// in real time, with the last activity breadcrumb and current RSS, so an
// incident is a labelled event instead of a sudden silence.
//
// Mechanism: the main thread stamps the time into a SharedArrayBuffer every
// beat and records a small integer "current activity" code; the worker reads
// both and, when the stamp goes stale, reports how long the loop has been
// unresponsive, what it was doing, and process memory (RSS is process-wide, so
// the worker can read it even while the main thread is frozen).

// Activity breadcrumbs. The worker maps code → name (order defines the code).
export const PHASE = {
  idle: 0,
  buildTraces: 1,
  readOpencode: 2,
  readHermes: 3,
  buildUsage: 4,
  readTrace: 5,
};
const PHASE_NAMES = Object.keys(PHASE);

const BEAT_MS = 1000;
const STALL_MS = 5000; // report once the loop has missed ~5 beats

let shared = null; // { hb: BigInt64Array, meta: Int32Array }
let worker = null;

export function startWatchdog() {
  if (worker || process.env.AM_NO_WATCHDOG) return;
  // BigInt64 for the heartbeat (Atomics needs an integer view; ms-since-epoch
  // overflows Int32), Int32 for the phase code — 8-byte aligned so both are
  // valid Atomics targets.
  const sab = new SharedArrayBuffer(16);
  const hb = new BigInt64Array(sab, 0, 1);
  const meta = new Int32Array(sab, 8, 2);
  Atomics.store(hb, 0, BigInt(Date.now()));
  shared = { hb, meta };
  const beat = setInterval(() => Atomics.store(hb, 0, BigInt(Date.now())), BEAT_MS);
  if (beat.unref) beat.unref();
  try {
    worker = new Worker(new URL('./watchdog-worker.js', import.meta.url), {
      workerData: { sab, beatMs: BEAT_MS, stallMs: STALL_MS, phases: PHASE_NAMES },
    });
    worker.unref();
    worker.on('error', () => {}); // the watchdog must never take down the app
  } catch { worker = null; }
}

// Cheap breadcrumb: record what the main thread is about to do, so a stall
// report can name the culprit. Returns the PREVIOUS code so callers can restore
// it — breadcrumbs then nest correctly (a build that dips into a db read shows
// the read while it runs, the build again after). A safe no-op (returns idle)
// before startWatchdog() runs.
export function mark(code) {
  return shared ? Atomics.exchange(shared.meta, 0, code | 0) : PHASE.idle;
}

// Run fn under a breadcrumb, restoring the previous one even on throw. Works for
// sync or async fn; the breadcrumb is what the worker reports if fn wedges.
export async function tracked(code, fn) {
  const prev = mark(code);
  try { return await fn(); } finally { mark(prev); }
}

// ---------- what was the stall? ----------
// The breadcrumb above says which async operation was IN FLIGHT when the loop
// wedged — not what wedged it. tracked() holds 'buildTraces' for a whole build,
// awaits included, so any synchronous work elsewhere that lands during one is
// reported as buildTraces. On 2026-10-19 that sent a diagnosis after the wrong
// code. This names the code that actually held the loop.
//
// V8's sampling profiler runs continuously at a coarse interval (10ms: a few
// samples per stall second is plenty, and the cost is noise). A main-thread
// timer notices when it fired late by more than STALL_MS, i.e. the loop just
// came back from a stall; the profile so far is stopped, the samples from the
// stall window are attributed to the nearest frame in OUR source (so a stall
// inside JSON.parse is charged to whoever called it), and the top few are
// logged. The profile is restarted every ROTATE_MS regardless, so memory stays
// bounded on a Space that never stalls.
const PROFILE_INTERVAL_US = 10_000;
const ROTATE_MS = 60_000;
const OWN_SRC = new URL('.', import.meta.url).href;

export async function startStallProfiler() {
  if (process.env.AM_STALL_PROFILE === '0') return;
  let session;
  try {
    const { Session } = await import('node:inspector');
    session = new Session();
    session.connect();
  } catch { return; }
  const post = (method, params) => new Promise((resolve, reject) =>
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: PROFILE_INTERVAL_US });
    await post('Profiler.start');
  } catch { return; }

  let startedAt = Date.now();
  let last = Date.now();
  let busy = false;
  const t = setInterval(async () => {
    const now = Date.now();
    const gap = now - last - 250;
    last = now;
    const stalled = gap > STALL_MS;
    if (busy || (!stalled && now - startedAt < ROTATE_MS)) return;
    busy = true;
    try {
      const { profile } = await post('Profiler.stop');
      if (stalled) console.error(`[stall] ${Math.round(gap / 1000)}s on the main thread — ${summarize(profile, gap)}`);
      await post('Profiler.start');
      startedAt = Date.now();
    } catch { /* profiling is best-effort */ }
    finally { busy = false; last = Date.now(); }
  }, 250);
  t.unref();
}

// Self time over the last `windowMs` of the profile, charged to the innermost
// frame from this app's own source; "(native/lib)" when no app frame is on the
// stack (GC, or a stack that is all node internals).
function summarize(profile, windowMs) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const ownFrame = (id) => {
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = byId.get(cur)?.callFrame;
      if (f?.url?.startsWith(OWN_SRC)) return `${f.functionName || '(anonymous)'} ${f.url.slice(OWN_SRC.length)}:${f.lineNumber + 1}`;
    }
    const leaf = byId.get(id)?.callFrame;
    return leaf?.functionName ? `(native/lib) ${leaf.functionName}` : '(native/lib)';
  };
  // Sample timestamps run forward from startTime; the stall is the tail.
  const times = [];
  let ts = profile.startTime;
  for (const d of profile.timeDeltas) times.push((ts += d));
  const from = profile.endTime - (windowMs + 1000) * 1000;
  const cost = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    if (times[i] < from) continue;
    const prev = i ? times[i - 1] : profile.startTime;
    const leaf = byId.get(profile.samples[i])?.callFrame.functionName;
    if (leaf === '(idle)' || leaf === '(program)') continue; // waiting, not working
    const key = ownFrame(profile.samples[i]);
    cost.set(key, (cost.get(key) || 0) + (times[i] - prev) / 1000);
  }
  const top = [...cost].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return top.length ? top.map(([k, ms]) => `${Math.round(ms)}ms ${k}`).join(' | ') : 'no samples';
}
