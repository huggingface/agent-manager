import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-model-'));
const bundle = path.join(tmp, 'model.mjs');
await build({ stdin: { contents: `export * from './src/lib/readerModel'; export * from './src/lib/readerStore'; export * from './src/components/conversation/exchanges';`, resolveDir: web, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
const { reconcileTrace, ReaderStore, readerFor, splitExchanges, stepsOf, agentSpawnsOf } = await import(pathToFileURL(bundle));
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

  const event = (id, operation, text = 'queued', reason) => turn(id, 'system', '', {
    blocks: [], event: { type: 'queue', operation, text, ...(reason ? { reason } : {}) } });
  const queue = [raw[0], event('enqueue', 'enqueue'), turn('work', 'assistant', 'later work'), event('remove', 'remove')];
  const queued = reconcileTrace(queue);
  // The prompt goes in where the queue says it was CONSUMED, not where it was
  // typed. The enqueue's position is in the middle of the turn that was still
  // running, and a user turn there opens an exchange that takes the rest of
  // that turn's answer with it — measured on a real transcript, where the
  // output either side of an enqueue is timestamped seconds BEFORE it.
  //
  // Its identity comes from the removal, which is the only record in the
  // lifecycle that names the queue entry.
  assert.deepEqual(queued.map((t) => t.id), ['u', 'work', 'remove'], 'removed queue prompt lands where it was consumed');
  assert.equal(queued[2].queued, false, 'a removal is terminal: nothing is waiting any more');

  // Still in the queue: waiting, so it says so — and at the end, where waiting
  // is, rather than inside the answer it was typed into.
  const waiting = reconcileTrace([raw[0], event('enqueue', 'enqueue'), turn('work', 'assistant', 'later work')]);
  assert.deepEqual(waiting.map((t) => t.id), ['u', 'work', 'enqueue'], 'a queued prompt is on screen, after the answer in flight');
  assert.equal(waiting[2].queued, true, 'a prompt still in the queue is the case the badge is for');

  // A window that begins after the enqueue still has the removal, and the
  // removal carries the text. The prompt used to vanish here while its reply
  // stayed, which is why a reload and the live view disagreed.
  const cold = reconcileTrace([turn('mid', 'assistant', 'answer to the previous prompt'),
    event('remove', 'remove', 'queued', 'absorbed_mid_turn'), turn('reply', 'assistant', 'the reply')]);
  assert.deepEqual(cold.map((t) => t.id), ['mid', 'remove', 'reply'], 'a cold window loses the prompt');
  assert.equal(cold[1].role, 'user');
  assert.equal(cold[1].queued, false);
  const coldExchanges = splitExchanges(cold);
  assert.equal(coldExchanges.length, 2, 'the reply fell into the previous exchange');
  assert.ok(coldExchanges[1].steps.concat(coldExchanges[1].answer).some((t) => t.id === 'reply'));

  // Two identical messages: the enqueues are indistinguishable, so only the
  // removals can say which is which.
  const dupText = 'do the thing';
  const dupEvent = (id, operation, cmd) => turn(id, 'system', '', { blocks: [],
    event: { type: 'queue', operation, text: dupText, ...(cmd ? { commandUuid: cmd } : {}) } });
  const dup = reconcileTrace([
    dupEvent('e1', 'enqueue'), dupEvent('e2', 'enqueue'),
    dupEvent('r2', 'remove', 'cmd-2'), turn('between', 'assistant', 'between'), dupEvent('r1', 'remove', 'cmd-1'),
  ]);
  assert.deepEqual(dup.map((t) => t.id), ['r2', 'between', 'r1'],
    'each removal places a message of its own, with its own identity');
  assert.ok(dup.every((t) => t.queued !== true));

  // The removal and the delivery record are two records of one prompt.
  const twice = reconcileTrace([
    dupEvent('e1', 'enqueue'),
    dupEvent('r1', 'remove', 'cmd-1'),
    dupEvent('d1', 'delivered', 'cmd-1'),
  ]);
  assert.deepEqual(twice.map((t) => t.id), ['r1'], 'the delivery record placed a second copy');
  // …and on its own it is enough.
  const deliveredOnly = reconcileTrace([dupEvent('d1', 'delivered', 'cmd-1'), turn('after', 'assistant', 'after')]);
  assert.deepEqual(deliveredOnly.map((t) => t.id), ['d1', 'after'], 'a window with only the delivery record shows nothing');
  assert.equal(reconcileTrace(queue, queued), queued, 'unchanged queued prompts preserve identity across polls');
  assert.equal(reconcileTrace([event('enqueue', 'enqueue'), event('dequeue', 'dequeue'), event('remove', 'remove')]).length, 0, 'a consumed queue item never reappears');

  // Delivered into the running turn: answered, so not waiting for anything.
  const absorbedPage = [raw[0], event('enqueue', 'enqueue'), turn('prev', 'assistant', 'answer to the PREVIOUS prompt'),
    event('remove', 'remove', 'queued', 'absorbed_mid_turn'), turn('reply', 'assistant', 'answer to the queued prompt')];
  const absorbed = reconcileTrace(absorbedPage);
  assert.deepEqual(absorbed.map((t) => t.id), ['u', 'prev', 'remove', 'reply'],
    'an absorbed prompt does not split the turn it was delivered into');
  assert.equal(absorbed[2].queued, false, 'a delivered prompt is not labelled as waiting in the queue');
  // What the operator actually sees: the earlier answer stays with the prompt it
  // belongs to, and the new prompt gets the reply that followed it.
  const [first, second] = splitExchanges(absorbed);
  assert.equal(first.prompt.id, 'u');
  assert.ok(first.steps.concat(first.answer).some((t) => t.id === 'prev'),
    'the previous answer was taken into the mid-turn prompt\'s exchange');
  assert.equal(second.prompt.id, 'remove');
  assert.ok(second.steps.concat(second.answer).some((t) => t.id === 'reply'),
    'the reply to the mid-turn prompt is not in its exchange');
  // The live tail delivers the enqueue and the remove in different fetches.
  for (let cut = 1; cut < absorbedPage.length; cut++) {
    assert.deepEqual(reconcileTrace(absorbedPage, reconcileTrace(absorbedPage.slice(0, cut))).map((t) => t.id),
      ['u', 'prev', 'remove', 'reply'], `tail join keeps the order across split ${cut}`);
  }
  const markup = turn('markup', 'user', '<div>Please review this markup</div>');
  assert.equal(splitExchanges([markup])[0].prompt, markup, 'operator markup starts an exchange, not a hidden work step');
  assert.equal(splitExchanges([turn('harness', 'user', '<task-notification>completed</task-notification>')])[0].prompt, null, 'known harness envelopes remain non-operator messages');

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
  indexed.push(page([turn('index:10', 'user', 'after revert')], 10, 11, { mode: 'index', replaceFrom: 10 }));
  await db.loadNewer();
  indexed.push(page([turn('index:0', 'user', 'surviving')], 0, 1, { mode: 'index', reset: true }));
  await db.loadNewer();
  assert.deepEqual(db.getSnapshot().turns.map(t => t.blocks[0].text), ['surviving'], 'shrink reset discards every deleted row');
  indexed.push(page([turn('index:0', 'user', 'surviving')], 0, 1, { mode: 'index', replaceFrom: 0 }));
  await db.loadNewer();
  assert.equal(db.getSnapshot().turns.length, 1, 'the next poll does not duplicate the surviving row');
  indexed.push(page([], 0, 0, { mode: 'index', reset: true }));
  await db.loadNewer();
  assert.equal(db.getSnapshot().phase, 'empty');
  assert.deepEqual(db.getSnapshot().turns, []);

  let fail = true;
  const recover = new ReaderStore({ window: () => fail ? Promise.reject(new Error('offline')) : Promise.resolve(page([raw[0]], 0, 1)), summary: () => new Promise(() => {}) });
  await recover.loadNewer(); assert.equal(recover.getSnapshot().phase, 'error');
  fail = false; await recover.refresh(); assert.equal(recover.getSnapshot().phase, 'ready');
  fail = true; await recover.loadNewer(); assert.equal(recover.getSnapshot().turns.length, 1, 'failed updates retain readable history');

  const pagingCalls = [];
  let finishPoll, pollSignal;
  const pagingStore = new ReaderStore({ window: (req, bytes, min, signal) => {
    pagingCalls.push(req);
    if (req.at === 'tail') return Promise.resolve(page([turn('recent', 'user', 'recent')], 1, 2));
    if (req.at === 'before') return Promise.resolve(page([turn('older', 'user', 'older')], 0, 1));
    pollSignal = signal;
    return new Promise((resolve) => { finishPoll = () => resolve(page([turn('late', 'user', 'late response')], 2, 3)); });
  }, summary: () => new Promise(() => {}) });
  await pagingStore.loadNewer();
  const poll = pagingStore.loadNewer();
  await new Promise((resolve) => setImmediate(resolve));
  const paging = pagingStore.loadOlder();
  await new Promise((resolve) => setImmediate(resolve));
  const issuedBefore = pagingCalls.some((req) => req.at === 'before');
  finishPoll(); await poll; await paging;
  assert.ok(issuedBefore, 'explicit backward paging is not swallowed by a background poll');
  assert.ok(pollSignal.aborted, 'backward paging cancels the lower-priority poll');
  assert.deepEqual(pagingStore.getSnapshot().turns.map((t) => t.id), ['older', 'recent'], 'late canceled responses cannot overwrite backward paging');
  assert.equal(pagingStore.getSnapshot().cursor.end, 2, 'the next forward poll still starts at the last accepted cursor');

  // A small tail can miss the task lifecycle marker. Its null (or carried)
  // activity must not mask the complete summary for the same source revision.
  for (const activity of [null, 'waiting']) {
    let activityPage = { ...page([raw[0]], 0, 1), activity };
    let serializations = 0;
    const userTurns = Array.from({ length: 10_000 }, (_, i) => i);
    userTurns.toJSON = () => { serializations++; return []; };
    const activityStore = new ReaderStore({ window: () => Promise.resolve(activityPage),
      summary: () => Promise.resolve({ ...activityPage, userTurns, activity: 'working' }) });
    const release = activityStore.retain();
    try {
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(activityStore.getSnapshot().head.activity, 'working', 'same-revision summary supplies authoritative lifecycle state');
      assert.equal(serializations, 0, 'metadata equality does not serialize an unbounded prompt index');
      activityPage = { ...page([], 1, 1, { revision: 'r2' }), activity: 'waiting', revision: 'r2' };
      await activityStore.loadNewer();
      assert.equal(activityStore.getSnapshot().head.activity, 'waiting', 'a newer window invalidates old summary activity');
    } finally { release(); }
  }

  let liveResponse = { ...page([raw[0]], 0, 1), activity: 'working' };
  const warm = new ReaderStore({ window: () => Promise.resolve(liveResponse), summary: () => new Promise(() => {}) });
  const releaseWarm = warm.retain();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warm.getSnapshot().activityConfirmed, true);
  releaseWarm();
  assert.equal(warm.getSnapshot().activityConfirmed, false, 'inactive retained status is not proof of current activity');
  assert.equal(warm.getSnapshot().head.activity, 'working', 'retained content is not erased to hide stale activity');
  liveResponse = { ...page([], 1, 1), activity: 'waiting' };
  const returnWarm = warm.retain();
  assert.equal(warm.getSnapshot().activityConfirmed, false, 'returning does not flash the old working line before refresh');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warm.getSnapshot().activityConfirmed, true);
  assert.equal(warm.getSnapshot().head.activity, 'waiting');
  returnWarm();

  const cacheSource = { window: () => Promise.resolve(page([], 0, 0)), summary: () => new Promise(() => {}) };
  const inactive = readerFor('cache-warm', cacheSource);
  const releases = Array.from({ length: 9 }, (_, i) => readerFor('cache-active-'+i, cacheSource).retain());
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readerFor('cache-warm', cacheSource), inactive, 'active stores do not consume the inactive entry budget');
  releases.forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  const candidates = Array.from({ length: 10 }, (_, i) => readerFor('cache-candidate-'+i, cacheSource));
  const trim = readerFor('cache-trim', cacheSource).retain(); trim();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(readerFor('cache-candidate-0', cacheSource), candidates[0], 'old inactive entries are still evicted');
  assert.equal(readerFor('cache-candidate-9', cacheSource), candidates[9], 'recent inactive entries survive eviction');

  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  let summaries = 0, revision = 0;
  const cadence = new ReaderStore({ window: () => Promise.resolve({ ...page([], 0, 0),
    lastTs: Date.now(), revision: String(++revision), activity: 'working' }),
  summary: () => { summaries++; return Promise.resolve({ ...page([], 0, 0), revision: String(revision) }); } });
  const releaseCadence = cadence.retain();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(500);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 120; i++) {
      mock.timers.tick(5000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(summaries, 3, 'ten minutes of live writes cost one initial summary plus two refreshes, not twenty');
    await cadence.refresh();
    mock.timers.tick(500);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(summaries, 4, 'explicit refresh can request fresh summary metadata without waiting five minutes');
  } finally { releaseCadence(); mock.timers.reset(); }

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
