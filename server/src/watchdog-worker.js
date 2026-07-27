import { workerData } from 'node:worker_threads';

// Runs on its own event loop, so it keeps ticking while the MAIN thread is
// blocked. Reads the heartbeat + phase the main thread writes to shared memory
// and logs to stderr — the one channel that survives a wedge (the Space's run
// logs). See watchdog.js for the contract.

const { sab, beatMs, stallMs, phases } = workerData;
const hb = new BigInt64Array(sab, 0, 1);
const meta = new Int32Array(sab, 8, 2);

const mb = (b) => Math.round(b / 1048576);
const phaseName = (c) => phases[c] || `#${c}`;
const now = () => Date.now();

let stalling = false;
let stallStart = 0;
let lastStallLog = 0;
let maxLag = 0;
let lastOk = now();

setInterval(() => {
  const t = now();
  const last = Number(Atomics.load(hb, 0));
  const age = t - last;
  if (age > maxLag) maxLag = age;

  if (age > stallMs) {
    // Loop is stuck. Log on onset, then at most every 10s while it stays stuck,
    // so a long wedge leaves a trail without flooding.
    if (!stalling) { stalling = true; stallStart = last; lastStallLog = 0; }
    if (lastStallLog === 0 || t - lastStallLog >= 10000) {
      lastStallLog = t;
      console.error(`[watchdog] main loop STALLED ${Math.round(age / 1000)}s`
        + ` — activity=${phaseName(Atomics.load(meta, 0))} rss=${mb(process.memoryUsage().rss)}MB`);
    }
    return;
  }

  if (stalling) {
    stalling = false;
    console.error(`[watchdog] main loop recovered after ~${Math.round((t - stallStart) / 1000)}s`);
  }
  // Baseline heartbeat every 30s: a steady "ok" line means alive; a GAP in
  // these lines is itself the alarm, and rss/maxLag give a cheap trend.
  if (t - lastOk >= 30000) {
    lastOk = t;
    console.error(`[watchdog] ok rss=${mb(process.memoryUsage().rss)}MB maxLag=${maxLag}ms`);
    maxLag = 0;
  }
}, beatMs);
