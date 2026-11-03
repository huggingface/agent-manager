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
  FILL_MAX_REQUESTS, FILL_MAX_RETAINED_BYTES, FILL_MAX_MS, FILL_STEP_MS,
  HISTORY_MIN_EXCHANGES, FILL_FLOOR_MAX_REQUESTS, FILL_FLOOR_MAX_RETAINED_BYTES,
  FILL_PROMPT_MAX_REQUESTS, FILL_PROMPT_MAX_RETAINED_BYTES,
} = await import(pathToFileURL(out).href);
const model = await build({
  entryPoints: [path.join(HERE, '../src/lib/readerModel.ts')],
  outfile: out.replace('store.mjs', 'model.mjs'), format: 'esm', bundle: true, logLevel: 'error',
}).then(() => import(pathToFileURL(out.replace('store.mjs', 'model.mjs')).href));
const { countExchanges, isOperatorPrompt } = model;
// Written out rather than imported from the branch, so this file can be run
// against a store that predates the guarantee and show it failing there.
const holdsPrompt = (turns) => turns.some((t) => !t.queued && isOperatorPrompt(t));
const MiB = 1024 * 1024;

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
  // `turn`: one long agent turn after the `n` exchanges — `count` tool records
  // of `bytes` each, after one prompt unless `prompt: false`. The shape a cold
  // reader opens on while an agent is deep in a tool-heavy task.
  const { turn = null } = opts;
  const records = [];
  let at = 0;
  const put = (turn, size) => { records.push({ at, size, turn }); at += size; };
  for (let i = 0; i < n; i++) {
    put({ id: `u${i}`, role: 'user', ts: 1000 + i * 10, blocks: [{ type: 'text', text: `prompt ${i}` }] }, promptBytes);
    if (toolBytes) put({ id: `t${i}`, role: 'assistant', ts: 1001 + i * 10,
      blocks: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', text: 'run' }, { type: 'tool_result', id: `c${i}`, text: 'o'.repeat(64) }] }, toolBytes);
    put({ id: `a${i}`, role: 'assistant', ts: 1002 + i * 10, kind: 'final', blocks: [{ type: 'text', text: `answer ${i}` }] }, answerBytes);
  }
  const step = (k) => ({ id: `h${k}`, role: 'assistant', ts: 50_000 + k,
    blocks: [{ type: 'tool_use', id: `hc${k}`, name: 'Bash', text: 'run' }, { type: 'tool_result', id: `hc${k}`, text: 'o'.repeat(64) }] });
  if (turn) {
    if (turn.prompt !== false) put({ id: 'last', role: 'user', ts: 49_999, blocks: [{ type: 'text', text: 'the last prompt' }] }, promptBytes);
    for (let k = 0; k < turn.count; k++) put(step(k), turn.bytes);
  }
  let size = at;
  const state = { calls: [], bytes: 0, spans: [], live: 0 };
  const inside = (from, to) => records.filter((r) => r.at >= from && r.at + r.size <= to);
  const page = (from, to) => {
    const got = inside(from, to);
    const start = got.length ? got[0].at : to;
    const end = got.length ? got[got.length - 1].at + got[got.length - 1].size : to;
    state.bytes += Math.max(0, to - from);
    state.spans.push(Math.max(0, to - from));
    return {
      harness: 'claude', harnessLabel: 'Fixture', sessionId: 's', title: '', model: null, cwd: null,
      firstTs: 0, lastTs: opts.lastTs || 0, usage: null, source: null, sharedBy: null, note: null, truncated: false,
      total: null, userTurns: null, activity: 'waiting', generation: 'g1', revision: 'r1',
      turns: got.map((r) => r.turn),
      window: { mode: 'bytes', start, end, atStart: start <= 0, atEnd: to >= size, generation: 'g1', revision: 'r1' },
    };
  };
  return {
    state,
    get size() { return size; },
    /** The agent writes another record, the way a live turn grows. */
    append(bytes) { put({ ...step(records.length), id: `live${state.live++}` }, bytes); size = at; },
    async window(req, bytes, min) {
      state.calls.push({ at: req.at, bytes, min });
      if (opts.hold && req.at === 'before') await tick(opts.hold);
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
      if (req.at === 'after') return page(req.cursor, size);
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
  // This fixture never reaches the floor of visible exchanges, so it spends the
  // floor's larger allowance rather than the ordinary one — the point of the
  // floor. Bounded either way, which is what this asserts.
  console.log(`  [3 MiB answers] ${countExchanges(state.turns)} exchanges after ${backward} backward pages`);
  assert.ok(backward <= FILL_FLOOR_MAX_REQUESTS,
    `bounded request count (${backward} <= ${FILL_FLOOR_MAX_REQUESTS})`);
  release();
}

// ---- a forward read is never swallowed by speculative history ----
// Latest, an explicit refresh and the live poll all go forward. The single
// request slot is shared with the fill, and returning the fill's promise to a
// forward caller means new output simply does not arrive until some later poll.
{
  const src = source(200, { toolBytes: 120 * 1024, hold: 300 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  // wait until a speculative backward read is actually in flight
  for (let i = 0; i < 60 && store.getSnapshot().loading !== 'before'; i++) await tick(10);
  assert.equal(store.getSnapshot().loading, 'before', 'a speculative page is in flight');
  const before = src.state.calls.filter((c) => c.at === 'after' || c.at === 'tail').length;
  await store.loadNewer();
  const after = src.state.calls.filter((c) => c.at === 'after' || c.at === 'tail').length;
  assert.ok(after > before,
    'asking for the latest while history is loading actually asks the source for it');
  await settle(store);
  assert.ok(countExchanges(store.getSnapshot().turns) >= 2, 'and the transcript survives');
  release();
}

// ---- the byte budget is a budget ----
// A backward page with no floor of its own lets the server grow one response
// until it holds a dozen messages, which on a trace of huge records is
// megabytes per request — and charging for it only after the next step has
// been scheduled lets one more go out on top.
{
  const src = source(200, { answerBytes: 900 * 1024 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.equal(state.fill, 'limited', 'the fill stops');
  const backward = src.state.spans.slice(1);              // spans[0] is the tail
  const total = backward.reduce((n, v) => n + v, 0);
  const biggest = Math.max(0, ...backward);
  const retained = state.cursor ? src.size - state.cursor.start : 0;
  const MiB = (n) => `${(n / 1048576).toFixed(1)} MiB`;
  // Three separate bounds, because they are three separate quantities.
  assert.ok(biggest <= 2 * 1024 * 1024,
    `the server cannot grow one speculative page to megabytes (largest ${MiB(biggest)})`);
  // Every cold run starts below the floor, so the floor's budget is the upper
  // BOUND on what a run can retain, even one that ends above the floor — which
  // this one does, at eight exchanges. It is a ceiling, not the cap in force
  // throughout: crossing the floor lowers the cap to the modest one against the
  // same cumulative spend. That is the floor's cost, paid only by traces whose
  // records are this large.
  const budget = FILL_FLOOR_MAX_RETAINED_BYTES;
  assert.ok(retained <= budget + biggest,
    `retained history stays inside the budget plus the page that crossed it `
    + `(${MiB(retained)} for a ${MiB(budget)} budget, largest page ${MiB(biggest)})`);
  assert.ok(total <= backward.length * 2 * 1024 * 1024,
    `and the whole run's reads stay inside requests x page ceiling (${MiB(total)})`);
  assert.ok(backward.length <= FILL_FLOOR_MAX_REQUESTS, `in ${backward.length} requests`);
  release();
}

// ---- the floor: at least eight VISIBLE exchanges when the trace has them ----
// The operator asked for at least eight, and the fill used to stop at the
// target's modest budget well short of it on tool-heavy traces. Counting is the
// other half: injected context that the reader never draws must not be what
// satisfies the floor.
for (const answerBytes of [4 * 1024, 120 * 1024, 900 * 1024]) {
  const src = source(200, { answerBytes });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  const have = countExchanges(state.turns);
  console.log(`  [floor] ${(answerBytes / 1024).toFixed(0)} KiB answers -> ${have} exchanges`);
  assert.ok(have >= HISTORY_MIN_EXCHANGES,
    `a 200-exchange trace with ${answerBytes} B answers delivers the floor (got ${have})`);
  release();
}

// ---- a short conversation is not padded to the floor ----
{
  const src = source(3);
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store);
  assert.equal(countExchanges(state.turns), 3, 'three exchanges is three, not eight');
  assert.ok(state.cursor?.atStart, 'and the source is exhausted, honestly');
  assert.notEqual(state.fill, 'filling', 'with nothing left to spin for');
  release();
}

// ---- a reader that wants less than the floor is not forced to it ----
{
  const src = source(200);
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(3);
  const state = await settle(store);
  // The first window already holds more than three short exchanges, so what is
  // being checked is the SPENDING: a reader wanting three must not page
  // backward chasing a floor it never asked for.
  const backward = src.state.calls.filter((c) => c.at === 'before').length;
  assert.equal(backward, 0, `a consumer asking for three pages no history (${backward} backward reads)`);
  assert.ok(countExchanges(state.turns) >= 3, 'and still has what it asked for');
  assert.equal(state.fill, 'done', 'and considers itself finished');
  release();
}

// ---- injected context is not an exchange; a prompt about it still is ----
{
  const sys = (id, text) => ({ id, role: 'user', ts: 1000, blocks: [{ type: 'text', text }] });
  // Exactly the shape Codex injects AGENTS.md with: a heading, then the
  // instructions envelope. Synthetic text, same structure.
  const injected = '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n<!-- BEGIN CONTEXT -->\nbe helpful\n</INSTRUCTIONS>';
  assert.equal(isOperatorPrompt(sys('a', injected)), false,
    'the injected AGENTS.md envelope is not an operator prompt');
  assert.equal(isOperatorPrompt(sys('b', '<environment_context>\nstuff')), false,
    'and neither is a tagged environment envelope');
  // The prompts that must survive: a person writing ABOUT the same things.
  for (const real of [
    'can you update AGENTS.md instructions for the new layout?',
    'the skill says to use <INSTRUCTIONS> — should we?',
    '# AGENTS.md instructions\n\nthis heading is mine, there is no envelope here',
    'read the environment skill and tell me what it says about ports',
  ]) {
    assert.equal(isOperatorPrompt(sys('c', real)), true, `a real prompt survives: ${real.slice(0, 40)}`);
  }
  // And counting agrees with drawing: a system turn draws nothing, so it opens
  // no exchange on either side.
  const turns = [
    { id: 's', role: 'system', ts: 1, blocks: [{ type: 'text', text: 'injected' }] },
    { id: 'u', role: 'user', ts: 2, blocks: [{ type: 'text', text: 'a real question' }] },
    { id: 'a', role: 'assistant', ts: 3, blocks: [{ type: 'text', text: 'an answer' }] },
  ];
  assert.equal(countExchanges(turns), 1, 'a leading system turn does not count as an exchange');
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

// ======== the last prompt: never open on half a turn ========
// The exchange counts treat agent output with no prompt above it as one
// exchange, so a single long tool-heavy turn used to exhaust every budget
// before the prompt that started it was loaded.
const PROMPT_BUDGET = (FILL_PROMPT_MAX_REQUESTS ?? FILL_FLOOR_MAX_REQUESTS) + 8;
const backwardOf = (src) => src.state.calls.filter((c) => c.at === 'before').length;

// ---- one huge agent turn after one prompt: the prompt is loaded ----
// 40 x 512 KiB of tool output = 20 MiB, past the floor's 8 MiB and 16 pages.
{
  const src = source(30, { turn: { count: 40, bytes: 512 * 1024 } });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  await tick(5);
  assert.equal(holdsPrompt(store.getSnapshot().turns), false,
    'the first window is the middle of the turn, with no prompt in it — the case this covers');
  const state = await settle(store, PROMPT_BUDGET);
  const retained = src.size - (state.cursor?.start ?? src.size);
  console.log(`  [huge turn] ${(retained / MiB).toFixed(1)} MiB, ${backwardOf(src)} backward pages, `
    + `prompt ${holdsPrompt(state.turns) ? 'loaded' : 'MISSING'}, fill ${state.fill}`);
  assert.ok(state.turns.some((t) => t.id === 'last'),
    `a 20 MiB turn still opens with the prompt that started it (fill ${state.fill}, `
    + `${(retained / MiB).toFixed(1)} MiB loaded after ${backwardOf(src)} backward pages)`);
  assert.notEqual(state.fill, 'filling', 'and the fill settles');
  assert.ok(backwardOf(src) <= FILL_PROMPT_MAX_REQUESTS, `inside the prompt allowance (${backwardOf(src)} pages)`);
  // Having bought the prompt it buys nothing more: the spend is cumulative, so
  // the ordinary caps stop it right there instead of paging the trace.
  assert.ok(retained < 22 * MiB, `and stops near it rather than paging on (${(retained / MiB).toFixed(1)} MiB)`);
  release();
}

// ---- a turn longer than the hard cap: stop, and do not pretend ----
{
  const src = source(5, { turn: { count: 80, bytes: 640 * 1024 } });   // 50 MiB
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  const retained = src.size - state.cursor.start;
  assert.equal(state.fill, 'limited', 'the cap ends the fill');
  assert.equal(holdsPrompt(state.turns), false, 'without the prompt, honestly');
  assert.ok(!state.cursor.atStart && !state.cursor.blocked, 'and Load earlier still works from there');
  assert.ok(backwardOf(src) <= FILL_PROMPT_MAX_REQUESTS, `bounded requests (${backwardOf(src)})`);
  assert.ok(retained <= FILL_PROMPT_MAX_RETAINED_BYTES + 2 * MiB,
    `bounded bytes (${(retained / MiB).toFixed(1)} MiB)`);
  release();
}

// ---- no operator prompt anywhere: stop at the start, honestly ----
{
  const src = source(0, { turn: { count: 30, bytes: 512 * 1024, prompt: false } });   // 15 MiB
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  assert.ok(state.cursor.atStart, 'a conversation with no prompt is read to its start');
  assert.equal(holdsPrompt(state.turns), false, 'and none is invented');
  assert.equal(state.fill, 'limited', 'it settles as a partial view, not as done');
  assert.ok(backwardOf(src) <= FILL_PROMPT_MAX_REQUESTS, `bounded requests (${backwardOf(src)})`);
  release();
}

// ---- a blocked source inside the turn: stop, do not loop ----
{
  const blockAt = source(5, { turn: { count: 40, bytes: 512 * 1024 } }).size - 4 * MiB;
  const blocked = source(5, { turn: { count: 40, bytes: 512 * 1024 }, blockAt });
  const store = new ReaderStore(blocked);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  assert.equal(state.fill, 'limited', 'a record no window can pass ends the hunt');
  assert.ok(state.cursor.blocked, 'and the reader says that is why');
  assert.equal(holdsPrompt(state.turns), false, 'without claiming the prompt');
  assert.ok(backwardOf(blocked) <= 8, `and does not retry it forever (${backwardOf(blocked)} backward reads)`);
  release();
}

// ---- an erroring source mid-hunt: the reader stays usable ----
{
  const src = source(5, { turn: { count: 40, bytes: 512 * 1024 }, fail: 4 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  await tick(50);
  const now = store.getSnapshot();
  assert.ok(now.turns.length > 0, 'what loaded survives a failed read');
  assert.ok(now.error, 'the failure is shown');
  assert.notEqual(now.fill, 'filling', 'and the hunt is not left spinning');
  assert.ok(backwardOf(src) <= 4, `nor retried in a loop (${backwardOf(src)})`);
  release();
}

// ---- live output while hunting does not lose the hunt ----
{
  const src = source(5, { turn: { count: 30, bytes: 512 * 1024 }, hold: 30 });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 40 && store.getSnapshot().loading !== 'before'; j++) await tick(5);
    src.append(64 * 1024);
    await store.loadNewer();
  }
  const state = await settle(store, PROMPT_BUDGET);
  assert.ok(state.turns.some((t) => t.id === 'last'), 'the prompt is still reached');
  const live = state.turns.filter((t) => t.id.startsWith('live')).map((t) => t.id);
  assert.deepEqual(live, ['live0', 'live1', 'live2', 'live3'], 'and the live records are there, once each, in order');
  assert.equal(state.turns.at(-1).id, 'live3', 'at the end');
  release();
}

// ---- a warm return resumes a hunt cut short ----
{
  const src = source(5, { turn: { count: 40, bytes: 512 * 1024 } });
  const store = new ReaderStore(src);
  const first = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  for (let i = 0; i < 200 && backwardOf(src) < 3; i++) await tick(10);
  first();
  await tick(FILL_STEP_MS * 3);
  assert.equal(holdsPrompt(store.getSnapshot().turns), false, 'the first visit was cut short of the prompt');
  const again = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  assert.ok(state.turns.some((t) => t.id === 'last'), 'coming back finishes the job');
  again();
  // ...and a warm store that already has it pages nothing more.
  const spent = backwardOf(src);
  const third = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  await settle(store, 4);
  assert.ok(backwardOf(src) - spent <= 0, `no repeat preload once the prompt is there (${backwardOf(src) - spent})`);
  third();
}

// ---- a reader that asked for no history (child, preview) is left alone ----
{
  const src = source(5, { turn: { count: 40, bytes: 512 * 1024 } });
  const store = new ReaderStore(src);
  const release = store.retain();
  await settle(store, 4);
  assert.equal(backwardOf(src), 0, 'want = 0 still means no speculative reads');
  assert.equal(store.getSnapshot().fill, 'idle');
  release();
}

// ---- an indexed source (opencode / agy DB readers) also reaches the prompt ----
// Pages by message count, `min` read as an exact page size the way
// server/src/traces.js windowIndex does.
function indexedSource(rows) {
  const INDEX_WINDOW_TURNS = 100, INDEX_TAIL_MIN_TURNS = 40;
  const calls = [];
  return {
    calls,
    async window(req, bytes, min) {
      calls.push(req.at);
      await tick(0);
      const total = rows.length;
      const n = Math.max(1, Math.min(500, Math.trunc(min) || INDEX_WINDOW_TURNS));
      let from; let to;
      if (req.at === 'before') { to = req.cursor; from = Math.max(0, to - n); }
      else if (req.at === 'after') { from = req.cursor; to = total; }
      else { to = total; from = Math.max(0, total - Math.max(n, INDEX_TAIL_MIN_TURNS)); }
      return { harness: 'opencode', harnessLabel: 'Fixture', sessionId: 's', title: '', model: null, cwd: null,
        firstTs: 0, lastTs: 0, usage: null, source: null, sharedBy: null, note: null, truncated: false,
        total, userTurns: null, activity: 'waiting', generation: 'g1', revision: 'r1',
        turns: rows.slice(from, to).map((t, i) => ({ ...t, id: `index:${from + i}` })),
        window: { mode: 'index', start: from, end: to, atStart: from <= 0, atEnd: to >= total, generation: 'g1', revision: 'r1',
          ...(req.at === 'after' ? { replaceFrom: from } : {}) } };
    },
    async summary() { await tick(0); return { total: rows.length, userTurns: [], revision: 'r1' }; },
  };
}
const indexedTurn = (steps, block) => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ role: 'user', ts: i, blocks: [{ type: 'text', text: `prompt ${i}` }] });
    rows.push({ role: 'assistant', ts: i, blocks: [{ type: 'text', text: `answer ${i}` }] });
  }
  rows.push({ role: 'user', ts: 100, blocks: [{ type: 'text', text: 'the last prompt' }] });
  for (let k = 0; k < steps; k++) rows.push({ role: 'assistant', ts: 101 + k, blocks: [block(k)] });
  return rows;
};
// 3,000 short rows of one turn is past the floor's 16 pages of 100.
{
  const indexed = indexedSource(indexedTurn(3000, (k) => ({ type: 'text', text: `step ${k}` })));
  const store = new ReaderStore(indexed);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  const back = indexed.calls.filter((c) => c === 'before').length;
  console.log(`  [indexed] ${state.turns.length} rows after ${back} backward pages, prompt ${holdsPrompt(state.turns) ? 'loaded' : 'MISSING'}`);
  assert.ok(holdsPrompt(state.turns), `an indexed source reaches the last prompt too (${state.turns.length} rows, ${back} pages)`);
  assert.ok(back <= FILL_PROMPT_MAX_REQUESTS, 'inside the request cap');
  release();
}

// ---- an indexed source is charged what it adds, not a flat price per row ----
// Full-size rows: the server caps a text block at 20,000 characters, and an
// image is its whole data URL. A flat 4 KiB per row let the prompt hunt retain
// an estimated 186 MiB "within" a 32 MiB budget.
for (const [label, block] of [
  ['20,000-character text blocks', () => ({ type: 'text', text: 'x'.repeat(20_000) })],
  ['200 KB images', () => ({ type: 'image', src: `data:image/png;base64,${'A'.repeat(200_000)}`, mediaType: 'image/png' })],
]) {
  const indexed = indexedSource(indexedTurn(6000, block));
  const store = new ReaderStore(indexed);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  await tick(5);
  const first = store.retainedSize;   // the first window: not the fill's to pay for
  assert.equal(store.getSnapshot().cursor?.mode, 'index', `${label}: the first window has landed`);
  const state = await settle(store, PROMPT_BUDGET);
  const retained = store.retainedSize - first;
  // One page of 100 such rows: what the request that crosses the budget adds.
  const page = 100 * (256 + 2 * (block(0).text || block(0).src).length);
  console.log(`  [indexed, ${label}] ${state.turns.length} rows, fill added ~${(retained / MiB).toFixed(1)} MiB, fill ${state.fill}`);
  assert.equal(state.fill, 'limited', `${label}: the budget stops the hunt`);
  assert.ok(retained <= FILL_PROMPT_MAX_RETAINED_BYTES + page,
    `${label}: what the fill adds stays inside the budget plus the page that crossed it `
    + `(${(retained / MiB).toFixed(1)} MiB for ${FILL_PROMPT_MAX_RETAINED_BYTES / MiB} MiB + ${(page / MiB).toFixed(1)} MiB)`);
  assert.ok(!state.cursor.atStart && !state.cursor.blocked, `${label}: and Load earlier still works from there`);
  release();
}

// ---- Claude's compaction summary is not the prompt (real normalizer) ----
// After a compaction Claude writes the continuation summary as a `user` record
// flagged isCompactSummary. Read as a prompt it satisfied the hunt while the
// real prompt was still 12 MiB back, past the floor's budget.
{
  const { readTraceByPath } = await import('../../server/src/traces.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-compaction-'));
  const file = path.join(dir, 'session.jsonl');
  let n = 0;
  const record = (type, content, extra = {}) => JSON.stringify({ type, uuid: `u${n++}`, sessionId: 's',
    timestamp: new Date(Date.UTC(2026, 10, 3, 9, 0, n)).toISOString(), message: { role: type, content }, ...extra }) + '\n';
  const lines = [record('user', 'THE ACTUAL OPERATOR PROMPT')];
  for (let i = 0; i < 24; i++) lines.push(record('assistant',
    [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'x'.repeat(512 * 1024) } }]));
  lines.push(record('user', 'This session is being continued from a previous conversation that ran out of context.\nSummary: work in progress.',
    { isCompactSummary: true, isVisibleInTranscriptOnly: true }));
  lines.push(record('assistant', [{ type: 'text', text: 'Continuing the work.' }]));
  fs.writeFileSync(file, lines.join(''));
  const calls = [];
  const claude = {
    window: (req, bytes, min) => { calls.push(req.at); return readTraceByPath(file, { window: { version: 2, ...req, bytes, min } }); },
    summary: async () => ({}),
  };
  // What the top row decides from: the tail alone, nothing paged.
  const tailOnly = new ReaderStore(claude);
  const stop = tailOnly.retain();
  await settle(tailOnly, 4);
  const tail = tailOnly.getSnapshot().turns;
  stop();
  const summary = tail.find((t) => t.blocks.some((b) => (b.text || '').includes('being continued')));
  assert.ok(summary, 'the summary is in the tail window');
  assert.notEqual(summary.role, 'user', 'and it is not a user turn');
  assert.equal(summary.blocks[0].type, 'compaction', 'it is a compaction marker, content kept');
  assert.equal(holdsPrompt(tail), false,
    'so a window holding only the summary does not count as holding the prompt — the top row warns');

  calls.length = 0;
  const store = new ReaderStore(claude);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const state = await settle(store, PROMPT_BUDGET);
  const back = calls.filter((c) => c === 'before').length;
  assert.ok(state.turns.some((t) => t.role === 'user' && t.blocks.some((b) => b.text === 'THE ACTUAL OPERATOR PROMPT')),
    `the real prompt is loaded, past the summary (fill ${state.fill}, ${back} backward pages, cursor ${state.cursor.start})`);
  release();
}

// ---- live output is not held back by the hunt ----
// Real timers, no explicit loadNewer: the reader's own poll must bring new
// output in while backward pages are still arriving faster than its cadence.
{
  // ~45 MiB of 1 MiB records behind a slow source: the hunt runs to its cap,
  // several seconds, longer than one 3 s poll interval.
  const src = source(2, { turn: { count: 45, bytes: 1024 * 1024 }, hold: 150, lastTs: Date.now() });
  const store = new ReaderStore(src);
  const release = store.retain();
  store.wantHistory(HISTORY_TARGET_EXCHANGES);
  const t0 = Date.now();
  await tick(300);
  src.append(4 * 1024);
  let seenAt = null; let fillEnded = null;
  for (let i = 0; i < 1200 && (seenAt === null || fillEnded === null); i++) {
    await tick(25);
    const snap = store.getSnapshot();
    if (seenAt === null && snap.turns.some((t) => t.id === 'live0')) seenAt = Date.now() - t0;
    if (fillEnded === null && snap.fill !== 'filling' && snap.fill !== 'idle') fillEnded = Date.now() - t0;
  }
  const forward = src.state.calls.filter((c) => c.at === 'after').length;
  console.log(`  [live poll] new output shown at ${seenAt} ms, hunt ended at ${fillEnded} ms, ${forward} forward reads`);
  assert.ok(fillEnded > 4000, `the hunt is long enough to matter (${fillEnded} ms)`);
  assert.ok(seenAt !== null && seenAt < fillEnded,
    `output written during the hunt appears before it ends (shown at ${seenAt} ms, hunt ended at ${fillEnded} ms)`);
  release();
}

assert.ok(FILL_MAX_MS > 0 && FILL_MAX_RETAINED_BYTES > 0, 'the documented budgets exist');
assert.equal(storeCount, undefined, 'the store does not re-export a second counter');
console.log('reader-history: ok');
