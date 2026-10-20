// The rules behind the dispatched-sessions strip (src/lib/dispatches.ts).
//
// What it pins, in the operator's own decisions:
//  - "done is not succeeded": a turn that ended is `finished`, never a verdict
//    of success; `failed` only for what the records prove (an error turn, a
//    refused call, no final message, a prompt that never started);
//  - one icon per session, however many times this turn prompted it, and the
//    preview reads the LATEST prompt;
//  - running on the left, finished to their right, failed at the very right;
//  - a dispatch belongs to the turn that made it, and to the tool call that
//    made it — which becomes its own step instead of folding into `Bash ×3`.
// Run with:  node test/dispatches.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
for (const [name, entry] of [['d.mjs', '../src/lib/dispatches.ts'], ['v.mjs', '../src/lib/dispatchView.ts'], ['x.mjs', '../src/components/conversation/exchanges.ts']]) {
  await build({ entryPoints: [path.join(HERE, entry)], outfile: path.join(dir, name), format: 'esm', bundle: true, logLevel: 'error' });
}
const { resultOf, byExchange, dispatchBlocks } = await import(pathToFileURL(path.join(dir, 'd.mjs')).href);
const { iconsOf, ordered, placeCard, within } = await import(pathToFileURL(path.join(dir, 'v.mjs')).href);
const { splitExchanges, stepsOf } = await import(pathToFileURL(path.join(dir, 'x.mjs')).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) { failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`); }
};

const NOW = 1_759_165_000_000;
const user = (ts, text, extra = {}) => ({ role: 'user', ts, blocks: [{ type: 'text', text }], ...extra });
const said = (ts, text, extra = {}) => ({ role: 'assistant', ts, blocks: [{ type: 'text', text }], usage: { in: 10, out: 5 }, ...extra });
const call = (ts, text = '') => ({ role: 'assistant', ts, blocks: [{ type: 'tool_use', name: 'Bash', text }, { type: 'tool_result', text: 'ok' }] });
let n = 0;
const disp = (o = {}) => ({
  id: `d${++n}`, at: NOW - 600_000, kind: 'launch', status: 201, ok: true, prompt: 'Build the canvas format',
  target: { id: 'canvas-1', name: 'canvas', cli: 'claude', color: '#d97757', exists: true, state: 'waiting' },
  exchange: { turns: [user(NOW - 590_000, 'Build the canvas format'), call(NOW - 580_000), said(NOW - 570_000, 'Built; draft PR #32.')], ended: true, truncated: false },
  ...o,
});

console.log('what became of one dispatch');
check('a turn that ended with a message is finished — not "succeeded"', () => {
  const r = resultOf(disp(), NOW);
  assert.equal(r.outcome, 'finished');
  assert.equal(r.answer, 'Built; draft PR #32.');
  assert.equal(r.x.toolCalls, 1);
});
check('a turn still going is running', () => {
  assert.equal(resultOf(disp({ exchange: { turns: [user(NOW - 1000, 'go'), call(NOW - 500)], ended: false, truncated: false } }), NOW).outcome, 'running');
});
check('"Login expired" is a failure, though it reads like an answer', () => {
  const r = resultOf(disp({ exchange: { turns: [user(NOW - 9000, 'go'), said(NOW - 8000, 'Login expired · Please run /login', { error: 'authentication_failed' })], ended: true, truncated: false } }), NOW);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.why, 'login expired');
});
check('a turn that ended on a tool call, with no final message, failed', () => {
  const r = resultOf(disp({ exchange: { turns: [user(NOW - 9000, 'go'), said(NOW - 8500, 'I’ll read the plan, then…'), call(NOW - 8000)], ended: true, truncated: false } }), NOW);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.why, 'no final message');
});
check('a refused call failed', () => {
  const r = resultOf(disp({ ok: false, status: 400, exchange: null }), NOW);
  assert.deepEqual([r.outcome, r.why], ['failed', 'refused (400)']);
});
check('not in the transcript yet: queued while the peer is busy or booting, failed once it has sat idle', () => {
  assert.equal(resultOf(disp({ exchange: null, target: { ...disp().target, state: 'working' } }), NOW).outcome, 'queued');
  assert.equal(resultOf(disp({ exchange: null, at: NOW - 30_000 }), NOW).outcome, 'queued');
  const idle = resultOf(disp({ exchange: null, at: NOW - 600_000 }), NOW);
  assert.deepEqual([idle.outcome, idle.why], ['failed', 'never started']);
});
check('a deleted session is gone, not failed', () => {
  assert.equal(resultOf(disp({ exchange: null, target: { ...disp().target, exists: false } }), NOW).outcome, 'gone');
});

console.log('\none icon per session, in the decided order');
{
  const t = (id, name) => ({ ...disp().target, id, name });
  const running = { turns: [user(NOW - 1000, 'go')], ended: false, truncated: false };
  const doneAt = (ts) => ({ turns: [user(ts - 1000, 'go'), said(ts, 'done')], ended: true, truncated: false });
  const list = [
    disp({ target: t('a', 'a'), exchange: doneAt(NOW - 50_000) }),
    disp({ target: t('b', 'b'), exchange: running, at: NOW - 400_000 }),
    disp({ target: t('c', 'c'), exchange: doneAt(NOW - 10_000) }),
    disp({ target: t('d', 'd'), ok: false, status: 400, exchange: null }),
    disp({ target: t('e', 'e'), exchange: running, at: NOW - 500_000 }),
    disp({ target: t('a', 'a'), kind: 'prompt', prompt: 'heads-up', exchange: doneAt(NOW - 5_000) }),
  ];
  const icons = iconsOf(list, NOW);
  check('a session prompted twice is one icon, and its preview reads the latest prompt', () => {
    assert.equal(icons.length, 5);
    const a = icons.find((p) => p.key === 'a');
    assert.equal(a.results.length, 2);
    assert.equal(a.latest.d.prompt, 'heads-up');
  });
  check('running first (in the order reached), then finished (latest nearest), failed at the very right', () => {
    assert.deepEqual(ordered(icons).map((p) => p.key), ['e', 'b', 'a', 'c', 'd']);
  });
  check('frames: running animates, finished is the ordinary frame, failed is red by side, not by frame', () => {
    const by = Object.fromEntries(icons.map((p) => [p.key, p]));
    assert.equal(by.b.frame, 'working');
    assert.equal(by.c.frame, 'waiting');
    assert.equal(by.d.side, 'failed');
  });
}

console.log('\nwhich turn, and which tool call');
{
  const T = NOW - 3_600_000;
  const turns = [
    user(T, 'launch the format workers'),
    call(T + 10_000, 'git fetch'),
    call(T + 20_000, 'for f in canvas sheet wiki; do curl -X POST "$AM/api/agents?name=$f&from=$AM_ID"; done'),
    call(T + 30_000, 'git log'),
    call(T + 40_000, 'curl -X POST "$AM/api/agents/sheet-1/prompt?from=$AM_ID"'),
    said(T + 50_000, 'Three workers are running.'),
    user(T + 100_000, 'next thing'),
    said(T + 110_000, 'ok'),
  ];
  const xs = splitExchanges(turns);
  const ds = [
    disp({ at: T + 20_500 }), disp({ at: T + 20_800 }), disp({ at: T + 21_000 }),
    disp({ at: T + 41_000, kind: 'prompt' }),
    disp({ at: T + 100_500 }),           // made by the next turn
    disp({ at: T - 500_000 }),           // before anything loaded
  ];
  const by = byExchange(xs, ds);
  check('each dispatch lands on the turn that had started by then; older ones on none', () => {
    assert.equal(by.get(xs[0].key).length, 4);
    assert.equal(by.get(xs[1].key).length, 1);
  });
  const placed = dispatchBlocks(xs[0].steps, by.get(xs[0].key));
  check('a loop that launched three is one call carrying three', () => {
    const counts = [...placed.byBlock.values()].map((l) => l.length);
    assert.deepEqual(counts, [3, 1]);
    assert.equal(placed.loose.length, 0);
  });
  check('those calls become their own steps instead of folding into Bash ×N', () => {
    const steps = stepsOf(xs[0].steps, (b) => placed.byBlock.has(b));
    assert.deepEqual(steps.map((s) => (s.kind === 'tools' ? `${s.name}×${s.count}` : s.kind)), ['Bash×1', 'dispatch', 'Bash×1', 'dispatch']);
    const plain = stepsOf(xs[0].steps);
    assert.deepEqual(plain.map((s) => `${s.name}×${s.count}`), ['Bash×4'], 'and without dispatches nothing changes');
  });
  check('a dispatch no call in the window can be tied to comes back loose', () => {
    const p = dispatchBlocks(xs[0].steps.slice(0, 1), [disp({ at: T + 5_000 })]);
    assert.equal(p.loose.length, 1);
  });
}

console.log('\nwhere the preview card goes');
{
  const vp = { left: 0, top: 0, width: 1100, height: 800 };
  const card = { width: 440, height: 300 };
  check('below the icon when it fits', () => {
    const p = placeCard({ left: 200, top: 100, bottom: 120 }, card, vp);
    assert.deepEqual([p.side, p.top, p.maxHeight], ['below', 126, null]);
  });
  check('above when there is not room below', () => {
    const p = placeCard({ left: 200, top: 700, bottom: 720 }, card, vp);
    assert.deepEqual([p.side, p.top + card.height, p.maxHeight], ['above', 694, null]);
  });
  check('neither: the roomier side, height capped to it, never past the viewport', () => {
    const short = { ...vp, height: 360 };
    const p = placeCard({ left: 200, top: 220, bottom: 240 }, card, short);
    assert.equal(p.side, 'above');
    assert.equal(p.top, 8);
    assert.ok(p.top + p.maxHeight <= 220 - 6, JSON.stringify(p));
  });
  check('kept on screen at the right edge and narrowed on a phone', () => {
    const edge = placeCard({ left: 1050, top: 100, bottom: 120 }, card, vp);
    assert.equal(edge.left + edge.width, 1100 - 8);
    const phone = placeCard({ left: 300, top: 100, bottom: 120 }, card, { left: 0, top: 0, width: 390, height: 844 });
    assert.deepEqual([phone.left, phone.width], [8, 374]);
  });
}

check('the bound is the reader\'s history, clipped to what the window shows', () => {
  assert.deepEqual(within({ left: 10, top: 83, right: 1090, bottom: 273 }, { left: 0, top: 0, width: 1100, height: 800 }),
    { left: 10, top: 83, width: 1080, height: 190 });
  assert.deepEqual(within({ left: -50, top: -20, right: 400, bottom: 2000 }, { left: 0, top: 0, width: 390, height: 844 }),
    { left: 0, top: 0, width: 390, height: 844 });
});
check('a short history caps the card to the room beside the icon inside it', () => {
  const p = placeCard({ left: 200, top: 105, bottom: 125 }, { width: 440, height: 284 }, { left: 10, top: 83, width: 1080, height: 190 });
  assert.equal(p.side, 'below');
  assert.equal(p.top, 131);
  assert.equal(p.top + p.maxHeight, 83 + 190 - 8);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
