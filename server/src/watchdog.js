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
