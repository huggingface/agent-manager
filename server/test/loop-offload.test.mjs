import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Event-loop wedges seen on the live Space (2026-10-19), each pinned down
// here so it can't quietly come back:
//   1. transcript parsing ran synchronously on the main thread — a heavy file
//      froze every request for seconds, on one core of eight;
//   2. a remote pane's message folder was read one blocking file at a time on
//      first touch — 34s for ~170 messages on the bucket.
// Each case runs in a child process: the pool size and DATA_DIR are read at
// import, so they can't be varied inside one process.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const run = (code, env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 26,
}).trim().split('\n').pop());

test('a heavy transcript parses without stalling the event loop, and parses the same', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-offload-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    // ~11MB of small records: under the 12MB tail cap, so the whole file is
    // parsed — the expensive case the duty cycle exists for.
    const at = Date.parse('2026-10-19T10:00:00Z');
    const rows = [];
    for (let i = 0; i < 60_000; i++) {
      const ts = new Date(at + i * 1000).toISOString();
      rows.push(JSON.stringify(i % 3
        ? { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'shell', arguments: 'x'.repeat(120) } }
        : { type: 'response_item', timestamp: ts, payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{ type: 'output_text', text: `turn ${i} ${'y'.repeat(40)}` }] } }));
    }
    await fs.writeFile(file, rows.join('\n') + '\n');
    const code = `
      const { digestFor } = await import(${JSON.stringify(path.join(SRC, 'traces.js'))});
      let last = Date.now(), maxLag = 0;
      const t = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 5); last = n; }, 5);
      const t0 = Date.now();
      const d = await digestFor({ id: 'x', cli: 'codex', codexRollout: ${JSON.stringify(file)} });
      clearInterval(t);
      console.log(JSON.stringify({ maxLag, took: Date.now() - t0, d }));`;
    const inline = run(code, { AM_TRACE_WORKERS: '0' });
    const pooled = run(code, { AM_TRACE_WORKERS: '2' });
    assert.deepEqual(pooled.d, inline.d, 'worker parse must match the in-process parse');
    assert.ok(pooled.d.lastPromptTs > 0, 'fixture should produce a real digest');
    // The in-process lag is the parse itself; the pooled one must be a small
    // fraction of it (worker startup + structured clone are the only main-
    // thread costs left).
    assert.ok(inline.maxLag > 30, `fixture too light to prove anything (in-process lag ${inline.maxLag}ms)`);
    assert.ok(pooled.maxLag < inline.maxLag / 2,
      `loop still stalls with workers: ${pooled.maxLag}ms vs ${inline.maxLag}ms in-process`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('remote logs preload without blocking reads, and never clobber a live log', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'am-remote-preload-'));
  try {
    const out = run(`
      import fs from 'node:fs';
      const remote = await import(${JSON.stringify(path.join(SRC, 'remote.js'))});
      for (let i = 0; i < 40; i++) remote.append('big', { role: i % 2 ? 'agent' : 'user', text: 'm' + i });
      remote.append('raced', { role: 'user', text: 'on disk' });
      remote.forget('big'); remote.forget('raced');
      // A request reaches 'raced' through the sync path before preload lands,
      // and appends: preload must keep that in-memory log, not the disk copy.
      remote.append('raced', { role: 'agent', text: 'live' });
      let syncReads = 0;
      const orig = fs.readFileSync;
      fs.readFileSync = (...a) => { if (String(a[0]).includes('remote-agents')) syncReads++; return orig(...a); };
      await remote.preloadLogs(['big', 'raced', 'missing']);
      const big = remote.allMessages('big');
      fs.readFileSync = orig;
      console.log(JSON.stringify({ syncReads, n: big.length, seqs: big.map((m) => m.seq), raced: remote.allMessages('raced').map((m) => m.text), next: remote.append('big', { role: 'user', text: 'after' }).seq }));`,
    { DATA_DIR: data });
    assert.equal(out.syncReads, 0, 'preloaded panes must not fall back to blocking reads');
    assert.equal(out.n, 40);
    assert.deepEqual(out.seqs, Array.from({ length: 40 }, (_, i) => i + 1));
    assert.deepEqual(out.raced, ['on disk', 'live']);
    assert.equal(out.next, 41, 'appends continue the preloaded sequence');
  } finally { await fs.rm(data, { recursive: true, force: true }); }
});

test('a main-thread stall is logged with the code that caused it', () => {
  const { stderr: err } = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const w = await import(${JSON.stringify(path.join(SRC, 'watchdog.js'))});
    await w.startStallProfiler();
    function plantedHog() { const t = Date.now(); let x = 0; while (Date.now() - t < 5600) x += Math.sqrt(x + 1); return x; }
    setTimeout(plantedHog, 300);
    setTimeout(() => process.exit(0), 7000).ref();`], { encoding: 'utf8' });
  const line = err.split('\n').find((l) => l.startsWith('[stall]'));
  assert.ok(line, 'no [stall] line logged');
  assert.match(line, /^\[stall\] \d+s on the main thread — \d{4}ms \S* ?plantedHog/, line);
});
