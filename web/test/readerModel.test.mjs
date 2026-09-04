import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-model-'));
const bundle = path.join(tmp, 'model.mjs');
await build({ stdin: { contents: `export * from './src/lib/readerModel'; export * from './src/lib/readerStore'; export * from './src/components/conversation/exchanges';`, resolveDir: web, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
const { reconcileTrace, ReaderStore, splitExchanges, stepsOf, agentSpawnsOf } = await import(pathToFileURL(bundle));
const turn = (id, role, text, extra = {}) => ({ id, role, ts: 1000, blocks: [{ type: 'text', text }], ...extra });
const call = { id: 'call', type: 'tool_use', name: 'Read', text: '{"path":"file"}' };
const result = { id: 'call', type: 'tool_result', text: 'contents' };
const raw = [
  turn('u', 'user', 'inspect'),
  turn('a', 'assistant', 'thinking', { messageId: 'm', blocks: [{ type: 'thinking', text: 'thinking' }, call] }),
  turn('r', 'user', '', { blocks: [result] }),
  turn('a2', 'assistant', 'finished', { messageId: 'm' }),
  turn('done', 'system', '', { blocks: [], event: { type: 'task-complete', text: 'finished' } }),
];
try {
  const expected = reconcileTrace(raw);
  assert.equal(expected.length, 2, 'fragments and result carrier are not duplicate messages');
  assert.equal(expected[1].kind, 'final');
  assert.deepEqual(expected[1].blocks, [raw[1].blocks[0], call, result, raw[3].blocks[0]]);
  for (let cut = 1; cut < raw.length; cut++) {
    const prefix = reconcileTrace(raw.slice(0, cut));
    assert.deepEqual(reconcileTrace(raw, prefix), expected, `forward join repairs split ${cut}`);
    const suffix = reconcileTrace(raw.slice(cut));
    assert.deepEqual(reconcileTrace(raw, suffix), expected, `backward join repairs split ${cut}`);
  }
  assert.equal(reconcileTrace(raw, expected), expected, 'an unchanged reconciliation preserves all identities');
  assert.equal(stepsOf([raw[1]])[1].pending, true, 'a call without a result is not a green success');
  assert.equal(stepsOf([expected[1]])[1].pending, false);

  const event = (id, operation, text = 'queued') => turn(id, 'system', '', { blocks: [], event: { type: 'queue', operation, text } });
  const queue = [raw[0], event('enqueue', 'enqueue'), turn('work', 'assistant', 'later work'), event('remove', 'remove')];
  const queued = reconcileTrace(queue);
  assert.deepEqual(queued.map((t) => t.id), ['u', 'enqueue', 'work'], 'removed queue prompt stays at enqueue time, not removal time');
  assert.equal(queued[1].queued, true);
  assert.equal(reconcileTrace(queue, queued), queued, 'unchanged queued prompts preserve identity across polls');
  assert.equal(reconcileTrace([event('enqueue', 'enqueue'), event('dequeue', 'dequeue'), event('remove', 'remove')]).length, 0, 'a consumed queue item never reappears');

  const page = (turns, start, end, extra = {}) => ({
    harness: 'test', harnessLabel: 'Test', sessionId: 'fixture', title: '', model: null, cwd: null,
    firstTs: 1, lastTs: 2, total: null, userTurns: null, usage: null, note: null, source: null, sharedBy: null, truncated: false,
    generation: 'g', revision: 'r', activity: 'waiting', turns,
    window: { mode: 'bytes', start, end, atStart: start === 0, atEnd: true, generation: 'g', revision: 'r', ...extra },
  });
  const responses = [page(raw.slice(0, 2), 0, 2), page(raw.slice(2), 2, 5)];
  const requests = [];
  const store = new ReaderStore({ window: (req) => { requests.push(req); return Promise.resolve(responses.shift()); }, summary: () => new Promise(() => {}) });
  await store.loadNewer();
  await store.loadNewer();
  assert.deepEqual(store.getSnapshot().turns, expected);
  assert.equal(requests[0].at, 'tail', 'a cursorless retry reads a tail');
  assert.equal(requests[1].generation, 'g', 'continuations carry source identity');
  responses.push(page([turn('new', 'user', 'replacement')], 0, 1, { generation: 'new', reset: true }));
  await store.loadNewer();
  assert.equal(store.getSnapshot().turns[0].id, 'new');
  assert.match(store.getSnapshot().notice, /replaced/);

  const indexed = [page([turn('index:8','user','ask'), turn('index:9','assistant','partial')], 8, 10, { mode: 'index' }),
    page([turn('index:7','assistant','outside'), turn('index:8','user','ask'), turn('index:9','assistant','complete')], 7, 10, { mode: 'index', replaceFrom: 7 })];
  const db = new ReaderStore({ window: () => Promise.resolve(indexed.shift()), summary: () => new Promise(() => {}) });
  await db.loadNewer(); await db.loadNewer();
  assert.deepEqual(db.getSnapshot().turns.map((t) => t.blocks[0].text), ['ask', 'complete'], 'mutable DB tail replaces in place without importing unloaded older rows');
  assert.equal(db.getSnapshot().cursor.start, 8);

  let fail = true;
  const recover = new ReaderStore({ window: () => fail ? Promise.reject(new Error('offline')) : Promise.resolve(page([raw[0]], 0, 1)), summary: () => new Promise(() => {}) });
  await recover.loadNewer(); assert.equal(recover.getSnapshot().phase, 'error');
  fail = false; await recover.refresh(); assert.equal(recover.getSnapshot().phase, 'ready');
  fail = true; await recover.loadNewer(); assert.equal(recover.getSnapshot().turns.length, 1, 'failed updates retain readable history');

  // A small tail can miss the task lifecycle marker. Its null (or carried)
  // activity must not mask the complete summary for the same source revision.
  for (const activity of [null, 'waiting']) {
    let activityPage = { ...page([raw[0]], 0, 1), activity };
    const activityStore = new ReaderStore({ window: () => Promise.resolve(activityPage),
      summary: () => Promise.resolve({ ...activityPage, activity: 'working' }) });
    const release = activityStore.retain();
    try {
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(activityStore.getSnapshot().head.activity, 'working', 'same-revision summary supplies authoritative lifecycle state');
      activityPage = { ...page([], 1, 1, { revision: 'r2' }), activity: 'waiting', revision: 'r2' };
      await activityStore.loadNewer();
      assert.equal(activityStore.getSnapshot().head.activity, 'waiting', 'a newer window invalidates old summary activity');
    } finally { release(); }
  }

  // Count global scans rather than timing on a shared CI host.
  let scans = 0;
  const many = Array.from({ length: 500 }, (_, i) => [turn('q'+i,'user','question'), turn('a'+i,'assistant','answer')]).flat();
  const exchanges = splitExchanges(many);
  const iterate = many[Symbol.iterator].bind(many);
  many[Symbol.iterator] = function* () { for (const t of iterate()) { scans++; yield t; } };
  for (const x of exchanges) agentSpawnsOf(x, many);
  assert.equal(scans, many.length, 'global outcomes scan once, not once per exchange');
  console.log('reader-model: cross-page joins, queue order, identity, recovery, mutable-index replacement and linear outcome indexing passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
