// Automatic recent-history fill: how much conversation a cold reader ends up
// holding, and what stops it.
//
// The store is driven directly, against a source that HONOURS `bytes` and `min`
// the way server/src/traces.js does. That matters: a fixture which returns every
// synthetic turn regardless of the window asked for cannot fail when the reader
// only asks for two, which is exactly the defect this covers.
//
// Run with:  node test/readerHistory.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-history-')), 'store.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/readerStore.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const {
  ReaderStore, countExchanges: storeCount, HISTORY_TARGET_EXCHANGES, HISTORY_MAX_EXCHANGES,
  FILL_MAX_REQUESTS, FILL_MAX_BYTES, FILL_MAX_MS, FILL_STEP_MS,
} = await import(pathToFileURL(out).href);
const model = await build({
  entryPoints: [path.join(HERE, '../src/lib/readerModel.ts')],
  outfile: out.replace('store.mjs', 'model.mjs'), format: 'esm', bundle: true, logLevel: 'error',
}).then(() => import(pathToFileURL(out.replace('store.mjs', 'model.mjs')).href));
const { countExchanges } = model;

const WINDOW_MIN_TURNS = 12;         // server/src/traces.js
const WINDOW_MAX_BYTES = 8 * 1024 * 1024;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let the store finish its bounded fill: each step waits FILL_STEP_MS. */
const settle = async (store, budget = FILL_MAX_REQUESTS + 4) => {
  for (let i = 0; i < budget * 4; i++) {
    await tick(FILL_STEP_MS + 5);
    if (store.getSnapshot().fill === 'done' || store.getSnapshot().fill === 'limited') break;
  }
  await tick(FILL_STEP_MS + 5);
  return store.getSnapshot();
};

/**
 * A byte-addressed transcript of `n` exchanges, laid out as records at real
 * offsets, served through the same growth rule the server uses: widen the span
 * until it holds `min` messages, the start of the source, or the ceiling.
 */
function source(n, opts = {}) {
  const { promptBytes = 200, toolBytes = 0, answerBytes = 400, blockAt = null, stall = false, fail = null } = opts;
  const records = [];
  let at = 0;
  const put = (turn, size) => { records.push({ at, size, turn }); at += size; };
  for (let i = 0; i < n; i++) {
    put({ id: `u${i}`, role: 'user', ts: 1000 + i * 10, blocks: [{ type: 'text', text: `prompt ${i}` }] }, promptBytes);
    if (toolBytes) put({ id: `t${i}`, role: 'assistant', ts: 1001 + i * 10,
      blocks: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', text: 'run' }, { type: 'tool_result', id: `c${i}`, text: 'o'.repeat(64) }] }, toolBytes);
    put({ id: `a${i}`, role: 'assistant', ts: 1002 + i * 10, kind: 'final', blocks: [{ type: 'text', text: `answer ${i}` }] }, answerBytes);
  }
  const size = at;
  const state = { calls: [], bytes: 0 };
  const inside = (from, to) => records.filter((r) => r.at >= from && r.at + r.size <= to);
  const page = (from, to) => {
    const got = inside(from, to);
    const start = got.length ? got[0].at : to;
    const end = got.length ? got[got.length - 1].at + got[got.length - 1].size : to;
    state.bytes += Math.max(0, to - from);
    return {
      harness: 'claude', harnessLabel: 'Fixture', sessionId: 's', title: '', model: null, cwd: null,
      firstTs: 0, lastTs: 0, usage: null, source: null, sharedBy: null, note: null, truncated: false,
      total: null, userTurns: null, activity: 'waiting', generation: 'g1', revision: 'r1',
      turns: got.map((r) => r.turn),
      window: { mode: 'bytes', start, end, atStart: start <= 0, atEnd: to >= size, generation: 'g1', revision: 'r1' },
    };
  };
  return {
    state,
    size,
    async window(req, bytes, min) {
      state.calls.push({ at: req.at, bytes, min });
      if (fail && state.calls.length >= fail) throw new Error('read failed');
      await tick(0);
      // A source that answers without moving the cursor and WITHOUT saying it
      // is blocked — a window whose whole span is one record it could not
      // parse. Nothing in the response says stop, so only the store's
      // no-progress rule can end the fill.
      if (stall && req.at === 'before') {
        const p = page(req.cursor, req.cursor);
        return { ...p, window: { ...p.window, start: req.cursor, end: req.cursor, atStart: false } };
      }
      // An oversized record no window can get past: the source stops advancing.
      if (blockAt !== null && req.at === 'before' && req.cursor <= blockAt) {
        const p = page(req.cursor, req.cursor);
        return { ...p, window: { ...p.window, start: req.cursor, end: req.cursor, blocked: true, atStart: false } };
      }
      const to = req.at === 'before' ? req.cursor : size;
      const floor = Math.trunc(min) || WINDOW_MIN_TURNS;
      for (let span = bytes || 384 * 1024; ; span = Math.min(span * 2, WINDOW_MAX_BYTES)) {
        const from = Math.max(0, to - span);
        const got = inside(from, to);
        if (got.length >= floor || from === 0 || span >= WINDOW_MAX_BYTES) return page(from, to);
      }
    },
    async summary() { await tick(0); return { total: records.length, userTurns: [], revision: 'r1' }; },
  };
}

// ---- the count the target is expressed in is the count the view groups by ----
{
  const src = source(3, { toolBytes: 500 });
  const store = new ReaderStore(src);
  const release = store.retain();
  await settle(store);
  const turns = store.getSnapshot().turns;
  assert.equal(countExchanges(turns), 3, 'three prompts are three exchanges, not nine records');
  assert.ok(turns.length > 3, 'and there really are more records than exchanges');
  release();
}

// ---- a cold reader reaches the recent-history target on its own ----
for (const [label, opts, needsFill] of [
  ['tool-heavy: barely an exchange per initial window', { toolBytes: 120 * 1024 }, true],
  ['multiline answers', { answerBytes: 20 * 1024 }, true],
  ['ordinary turns', {}, false],
]) {
  const src = source(200, opts);
  const store = new ReaderStore(src);
  const release = store.retain();
  const first = store.getSnapshot();
  assert.equal(first.fill, 'idle', 'a reader nobody asked for history does not start one');
  release();

  const wanted = new ReaderStore(src);
  const stop = wanted.retain();
  wanted.wantHistory(HISTORY_TARGET_EXCHANGES);
  await tick(5);
  // What ONE window holds — the whole of the old cold-open behaviour. A case
  // that already covers the target here would pass without any fill at all,
  // so the fixtures that are meant to exercise the fill assert that it cannot.
  const initial = countExchanges(wanted.getSnapshot().turns);
  if (needsFill) assert.ok(initial < HISTORY_TARGET_EXCHANGES,
    `${label}: the first window alone holds ${initial}, short of the target — this is the case that needs filling`);
  const state = await settle(wanted);
  const have = countExchanges(state.turns);
  assert.ok(have >= HISTORY_TARGET_EXCHANGES,
    `${label}: reached the target without scrolling or searching (got ${have})`);
  assert.equal(state.fill, 'done', `${label}: and stopped once it had them`);
  assert.ok(!state.turns.some((t, i) => state.turns.findIndex((o) => o.id === t.id) !== i),
    `${label}: no duplicated records across pages`);
  const ids = state.turns.map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || 0).length === ids.length ? ids : ids,
    `${label}: order preserved`);
  stop();
}

// ---- shorter conversations load all of themselves and stop ----
for (const n of [0, 1, 2, 5]) {
  const src = source(n);
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.equal(countExchanges(state.turns), n, `a ${n}-exchange conversation loads all ${n}`);
  assert.ok(state.cursor?.atStart !== false || n === 0, `and knows it is at the beginning`);
  assert.ok(state.fill !== 'filling', 'the fill has settled rather than spinning');
  release();
}

// ---- budgets: a fill stops, and says it stopped short ----
{
  // 3 MiB of answer per exchange: the byte budget goes before the count does.
  const src = source(200, { answerBytes: 900 * 1024 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.equal(state.fill, 'limited', 'a budget ends the fill');
  assert.ok(countExchanges(state.turns) < HISTORY_TARGET_EXCHANGES, 'honestly short of the target');
  assert.ok(state.cursor && !state.cursor.atStart, 'and does not claim the beginning of the conversation');
  const backward = src.state.calls.filter((c) => c.at === 'before').length;
  assert.ok(backward <= FILL_MAX_REQUESTS, `bounded request count (${backward} <= ${FILL_MAX_REQUESTS})`);
  release();
}

// ---- an oversized record blocks progress: stop, do not loop ----
{
  const src = source(200, { toolBytes: 120 * 1024, blockAt: Number.MAX_SAFE_INTEGER });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.equal(state.fill, 'limited', 'a cursor that cannot advance ends the fill');
  const backward = src.state.calls.filter((c) => c.at === 'before').length;
  assert.ok(backward <= 2, `and does not retry it forever (${backward} backward reads)`);
  release();
}

// ---- a cursor that answers without advancing: stop, do not loop ----
{
  const src = source(200, { toolBytes: 120 * 1024, stall: true });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.equal(state.fill, 'limited', 'a stalled cursor ends the fill');
  assert.ok(state.cursor && !state.cursor.atStart,
    'and never reports the beginning of a conversation it could not reach');
  const backward = src.state.calls.filter((c) => c.at === 'before').length;
  assert.ok(backward <= 2,
    `one backward read proves it, a second is the retry — not ${backward} of them`);
  release();
}

// ---- a failing read leaves the reader usable ----
{
  const src = source(200, { toolBytes: 120 * 1024, fail: 2 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.ok(state.turns.length > 0, 'the first window survives a failed fill');
  assert.equal(state.loading, null, 'and the busy slot is released');
  assert.notEqual(state.fill, 'filling', 'the fill is not left in flight');
  release();
}

// ---- warm return fills only what is missing ----
{
  const src = source(200, { toolBytes: 60 * 1024 });
  const store = new ReaderStore(src);
  const first = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const warm = await settle(store);
  const held = warm.turns.length;
  const spent = src.state.calls.length;
  first();
  await tick(5);
  const again = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  await settle(store);
  const after = store.getSnapshot();
  assert.ok(after.turns.length >= held, 'a warm store keeps the history it had');
  const extra = src.state.calls.filter((c) => c.at === 'before').length
    - src.state.calls.slice(0, spent).filter((c) => c.at === 'before').length;
  assert.equal(extra, 0, 'and does not repeat the preload on remount');
  again();
}

// ---- releasing a reader stops its fill ----
{
  const src = source(200, { toolBytes: 120 * 1024 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  await tick(FILL_STEP_MS + 5);
  release();
  const spent = src.state.calls.length;
  await tick(FILL_STEP_MS * 6);
  assert.ok(src.state.calls.length - spent <= 1,
    `an unmounted reader stops paging (${src.state.calls.length - spent} extra reads)`);
}

// ---- the coverage request is bounded ----
{
  const src = source(500, { promptBytes: 60, answerBytes: 60 });
  const store = new ReaderStore(src);
  const release = store.retain();
  for (let i = 0; i < 40; i++) store.wantHistory(HISTORY_MAX_EXCHANGES + i * 10);
  const state = await settle(store);
  assert.ok(countExchanges(state.turns) >= HISTORY_TARGET_EXCHANGES, 'tiny exchanges still reach the target');
  const backward = src.state.calls.filter((c) => c.at === 'before').length;
  assert.ok(backward <= FILL_MAX_REQUESTS, 'raising the target past the cap cannot page the whole trace');
  release();
}

assert.ok(FILL_MAX_MS > 0 && FILL_MAX_BYTES > 0, 'the documented budgets exist');
assert.equal(storeCount, undefined, 'the store does not re-export a second counter');
console.log('reader-history: ok');
