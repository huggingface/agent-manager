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
/** Codex rollout records, in the shape the parser actually reads. */
const codexRows = (n, at = Date.parse('2026-10-19T10:00:00Z')) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ type: 'response_item', timestamp: new Date(at + i * 1000).toISOString(),
    payload: { type: 'message', role: i % 2 ? 'assistant' : 'user',
      content: [{ type: i % 2 ? 'output_text' : 'input_text', text: `turn ${i}` }] } })).join('\n') + '\n';

const run = (code, env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  // A job that never settles would otherwise hang the suite rather than fail
  // it, which is the very shape of the bug these cases are about.
  env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 90_000,
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

test('a message that cannot be read keeps its number', async () => {
  // The failure the review reproduced: one unreadable file was dropped, the
  // pane was published as loaded anyway, and the next append reused the
  // missing message's sequence — writing the same filename and replacing it.
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'am-remote-torn-'));
  try {
    const out = run(`
      import fs from 'node:fs';
      const remote = await import(${JSON.stringify(path.join(SRC, 'remote.js'))});
      for (const t of ['one', 'two', 'three']) remote.append('torn', { role: 'user', text: t });
      remote.forget('torn');
      // The third message cannot be read, once.
      let failures = 0;
      const realRead = fs.promises.readFile;
      const realSync = fs.readFileSync;
      const unreadable = (f) => /0*3-user\\.md$/.test(String(f));
      fs.promises.readFile = async (f, ...rest) => {
        if (unreadable(f)) { failures++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
        return realRead(f, ...rest);
      };
      // The sync fallback cannot read it either, so the in-memory log stays
      // short: only the number on disk can stop the next append reusing it.
      fs.readFileSync = (f, ...rest) => {
        if (unreadable(f)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return realSync(f, ...rest);
      };
      await remote.preloadLogs(['torn']);
      const afterPreload = remote.allMessages('torn').map((m) => m.seq);
      const appended = remote.append('torn', { role: 'user', text: 'new' });
      const onDisk = fs.readdirSync(remote.folderFor('torn')).filter((f) => /^\\d+-/.test(f)).sort();
      fs.readFileSync = realSync;
      // A second pane whose reads fail only during preload: it must not be
      // published as loaded, so the sync path reads the folder again and finds
      // the message. Left marked loaded, it was missing for the life of the
      // process.
      for (const t of ['one', 'two', 'three']) remote.append('recovers', { role: 'user', text: t });
      remote.forget('recovers');
      fs.promises.readFile = async (f, ...rest) => {
        if (String(f).includes('recovers')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return realRead(f, ...rest);
      };
      await remote.preloadLogs(['recovers']);
      fs.promises.readFile = realRead;
      const recovered = remote.allMessages('recovers').map((m) => m.seq);
      console.log(JSON.stringify({ failures, afterPreload, recovered, appended: appended.seq,
        third: realSync(remote.folderFor('torn') + '/' + fs.readdirSync(remote.folderFor('torn')).find((f) => /0*3-user/.test(f)), 'utf8').includes('three'),
        onDisk }));`,
    { DATA_DIR: data });
    assert.ok(out.failures >= 2, 'the read should have been retried before giving up');
    assert.notEqual(out.appended, 3, 'the next append reused the unreadable message\'s sequence');
    assert.equal(out.appended, 4, `appended as ${out.appended}`);
    assert.equal(out.third, true, 'the message that could not be read was overwritten on disk');
    assert.equal(out.onDisk.length, 4, `the folder holds ${JSON.stringify(out.onDisk)}`);
    assert.deepEqual(out.onDisk.map((f) => parseInt(f, 10)), [1, 2, 3, 4]);
    // Not published as loaded: the sync path reads the folder again and finds it.
    assert.ok(out.afterPreload.length < 3 || out.afterPreload.includes(3));
    assert.deepEqual(out.recovered, [1, 2, 3],
      'a folder that could not be read whole was published as loaded, so the message never came back');
  } finally { await fs.rm(data, { recursive: true, force: true }); }
});

test('a worker that stops answering is replaced, and the parse still returns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-worker-stuck-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    await fs.writeFile(file, codexRows(6));
    const code = `
      const { digestFor } = await import(${JSON.stringify(path.join(SRC, 'traces.js'))});
      const t0 = Date.now();
      const d = await digestFor({ id: 'x', cli: 'codex', codexRollout: ${JSON.stringify(file)} });
      console.log(JSON.stringify({ ms: Date.now() - t0, d }));`;
    const inline = run(code, { DATA_DIR: dir, AM_TRACE_WORKERS: '0' });
    // A deadline no worker can meet stands in for one that has stopped
    // answering: the job must settle through the fallback either way, and the
    // stuck slot must be terminated rather than left holding its lane.
    const stuck = run(code, { DATA_DIR: dir, AM_TRACE_WORKERS: '1', AM_TRACE_JOB_DEADLINE_MS: '1' });
    assert.deepEqual(stuck.d, inline.d, 'the fallback did not produce the same digest');
    assert.ok(stuck.d.lastPromptTs > 0, 'fixture should produce a real digest');
    assert.ok(stuck.ms < 20_000, `waited ${stuck.ms}ms on a worker that never answered`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a worker that dies mid-parse falls back, and the next parse is whole', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-worker-crash-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    await fs.writeFile(file, codexRows(6));
    const out = run(`
      const traces = await import(${JSON.stringify(path.join(SRC, 'traces.js'))});
      const session = { id: 'x', cli: 'codex', codexRollout: ${JSON.stringify(file)} };
      const first = await traces.digestFor(session);
      // Killed between parses. The replacement has no append cursor for this
      // file — the cursor lives in the worker's own module state — so it must
      // rescan the file whole rather than resume a delta against one it has
      // never seen.
      await traces.__killWorkersForTest();
      const second = await traces.digestFor(session);
      console.log(JSON.stringify({ first, second }));`,
    { DATA_DIR: dir, AM_TRACE_WORKERS: '1' });
    assert.ok(out.first.lastPromptTs > 0, 'the first parse produced nothing');
    assert.deepEqual(out.second, out.first,
      'after the worker was replaced the parse returned a delta, not the whole file');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a parse worker is not given the server\'s credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-worker-env-'));
  try {
    // Asked of a real pool worker, not of the helper that builds its options:
    // worker threads inherit the parent's whole environment by default, so
    // what matters is that the pool passes something else.
    const out = run(`
      const traces = await import(${JSON.stringify(path.join(SRC, 'traces.js'))});
      const keys = await traces.__workerEnvKeysForTest();
      await traces.__killWorkersForTest();
      console.log(JSON.stringify({ keys, home: process.env.HOME !== undefined }));`,
    { DATA_DIR: dir, AM_TRACE_WORKERS: '1', AM_PARENT_ONLY_CANARY: 'must-not-cross' });
    assert.ok(!out.keys.includes('AM_PARENT_ONLY_CANARY'),
      'a parent-only variable reached the worker');
    assert.ok(!out.keys.some((k) => /TOKEN|KEY|SECRET|PASSWORD/i.test(k)),
      `credential-shaped keys crossed: ${out.keys.filter((k) => /TOKEN|KEY|SECRET|PASSWORD/i.test(k))}`);
    assert.ok(out.keys.includes('DATA_DIR'), 'the worker needs the paths a transcript lives under');
    assert.equal(out.keys.includes('AM_TRACE_WORKERS'), true, 'a worker must not start a pool of its own');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
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
