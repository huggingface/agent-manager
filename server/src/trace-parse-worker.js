import { parentPort } from 'node:worker_threads';
import { statsFromFile } from './traces.js';

// Transcript parsing, off the main event loop. traces.js posts
// { id, p, size, kind } and gets back { id, parsed } — the same { stats, digest }
// (or null) that statsFromFile returns in-process. See the pool in traces.js.
//
// Jobs run one at a time: a worker is one thread, and overlapping two parses
// here would only interleave their awaits, not run them in parallel.
let queue = Promise.resolve();
parentPort.on('message', ({ id, p, size, kind, probe }) => {
  // What environment did this thread actually get? Asked by
  // server/test/loop-offload.test.mjs, which cannot read it from outside.
  if (probe === 'env') { parentPort.postMessage({ id, envKeys: Object.keys(process.env) }); return; }
  queue = queue.then(async () => {
    let parsed = null;
    try { parsed = await statsFromFile(p, size, kind); } catch { /* null: unreadable */ }
    // A result that can't cross the thread boundary is answered with a
    // fallback, so the caller parses in-process and this queue keeps running.
    try { parentPort.postMessage({ id, parsed }); }
    catch { parentPort.postMessage({ id, fallback: true }); }
  });
});
