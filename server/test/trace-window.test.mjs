// Reading a trace as WINDOWS: the reader opens on the end of the conversation
// and pages backwards, so none of this may lose a line, repeat one, or run off
// the start of the file. Run with:
//   node test/trace-window.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-window-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { readTraceByPath } = await import('../src/traces.js');

const textOf = (t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
const claudeLine = (i, pad = 0) => JSON.stringify({
  type: i % 2 === 0 ? 'user' : 'assistant',
  cwd: TMP,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  message: {
    role: i % 2 === 0 ? 'user' : 'assistant',
    ...(i % 2 ? { id: `m${i}`, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 } } : {}),
    content: [{ type: 'text', text: `turn ${i}${pad ? ` ${'x'.repeat(pad)}` : ''}` }],
  },
});

// ~600 turns of a few hundred bytes each: several windows at any sane size.
const file = path.join(TMP, 'session.jsonl');
const N = 600;
fs.writeFileSync(file, `${Array.from({ length: N }, (_, i) => claudeLine(i, 200)).join('\n')}\n`);
const SIZE = fs.statSync(file).size;

// ---- the tail is the end of the conversation, and knows it ----
const tail = await readTraceByPath(file, { window: { at: 'tail', bytes: 32 * 1024 } });
assert.equal(tail.window.atEnd, true, 'a tail window reaches the end of the file');
assert.equal(tail.window.end, SIZE, 'and consumed every whole line up to it');
assert.equal(tail.window.atStart, false, '600 turns do not fit in 32 KB');
assert.equal(textOf(tail.turns[tail.turns.length - 1]), `turn ${N - 1} ${'x'.repeat(200)}`, 'the last turn written is the last turn shown');
assert.ok(tail.turns.length >= 12, `a window grows until it holds a readable number of turns (got ${tail.turns.length})`);
// A window that cannot see the start of the trace must not claim to know when
// the conversation began or what the whole of it cost.
assert.equal(tail.firstTs, 0);
assert.equal(tail.usage, null);
assert.equal(tail.total, null);

// ---- paging back reproduces the conversation exactly ----
let page = tail;
let stitched = [];
let hops = 0;
const seen = [];
for (;;) {
  stitched = [...page.turns, ...stitched];
  seen.push([page.window.start, page.window.end]);
  if (page.window.atStart) break;
  assert.ok(++hops < 200, 'paging back terminates');
  const before = page.window.start;
  page = await readTraceByPath(file, { window: { at: 'before', cursor: before, bytes: 32 * 1024 } });
  assert.ok(page.window.end === before, 'each window ends exactly where the one after it began');
  assert.ok(page.window.start < before, 'and makes progress towards the start of the file');
}
assert.equal(seen[seen.length - 1][0], 0, 'the last window reaches byte 0');
assert.deepEqual(stitched.map(textOf), Array.from({ length: N }, (_, i) => `turn ${i} ${'x'.repeat(200)}`),
  'every turn, once, in order');

// Asking for more once the start is reached returns nothing and stays put,
// rather than wrapping around or looping forever.
const past = await readTraceByPath(file, { window: { at: 'before', cursor: 0, bytes: 32 * 1024 } });
assert.equal(past.turns.length, 0);
assert.equal(past.window.atStart, true);

// ---- a trace that grows while the reader is open ----
const before = await readTraceByPath(file, { window: { at: 'tail', bytes: 32 * 1024 } });
fs.appendFileSync(file, `${claudeLine(N)}\n${claudeLine(N + 1)}\n`);
const grown = await readTraceByPath(file, { window: { at: 'after', cursor: before.window.end } });
assert.deepEqual(grown.turns.map(textOf), [`turn ${N}`, `turn ${N + 1}`], 'only what was appended, exactly once');
assert.equal(grown.window.start, before.window.end, 'and it continues from where the reader had got to');
const nothingNew = await readTraceByPath(file, { window: { at: 'after', cursor: grown.window.end } });
assert.equal(nothingNew.turns.length, 0, 'polling an unchanged trace adds nothing');

// A line half-written by the agent is nobody's yet: it must not be parsed, and
// the cursor must stop in front of it so the next poll picks it up whole.
fs.appendFileSync(file, '{"type":"user","message":{"role":"user","conte');
const torn = await readTraceByPath(file, { window: { at: 'after', cursor: grown.window.end } });
assert.equal(torn.turns.length, 0, 'a partial line is not a turn');
assert.equal(torn.window.end, grown.window.end, 'and the cursor waits for it');
fs.appendFileSync(file, 'nt":[{"type":"text","text":"turn 602"}]}}\n');
const healed = await readTraceByPath(file, { window: { at: 'after', cursor: torn.window.end } });
assert.deepEqual(healed.turns.map(textOf), ['turn 602'], 'once whole, the line is read');

// ---- a transcript whose last line has no newline still ends in a turn ----
const noNl = path.join(TMP, 'no-newline.jsonl');
fs.writeFileSync(noNl, [claudeLine(0), claudeLine(1)].join('\n'));
const end = await readTraceByPath(noNl, { window: { at: 'tail' } });
assert.deepEqual(end.turns.map(textOf), ['turn 0', 'turn 1']);
assert.equal(end.window.atStart, true);
assert.equal(end.window.atEnd, true);

// ---- the summary is the whole-trace view the windows can't give ----
const sum = await readTraceByPath(file, { summary: true });
assert.equal(sum.total, N + 3, 'every turn in the file');
assert.equal(sum.userTurns.length, (N + 3 + 1) / 2 | 0 || sum.userTurns.length, 'prompt indices are whole-trace');
assert.ok(sum.usage.in > 0, 'and so is the token total');
assert.ok(sum.firstTs > 0);
assert.equal(sum.turns, undefined, 'a summary carries no turns');

// ---- index paging is untouched ----
const p0 = await readTraceByPath(file, { offset: 0, limit: 5 });
assert.deepEqual(p0.turns.map(textOf).slice(0, 2), [`turn 0 ${'x'.repeat(200)}`, `turn 1 ${'x'.repeat(200)}`]);
assert.equal(p0.total, N + 3);
assert.equal(p0.window, undefined);

// ---- one turn bigger than the window still arrives ----
const huge = path.join(TMP, 'huge.jsonl');
fs.writeFileSync(huge, `${[
  claudeLine(0),
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', id: 'big', content: [{ type: 'text', text: `big ${'y'.repeat(300_000)}` }] },
  }),
].join('\n')}\n`);
const big = await readTraceByPath(huge, { window: { at: 'tail', bytes: 32 * 1024 } });
assert.equal(big.turns.length, 2, 'the window grew past a 300 KB turn');
assert.equal(big.window.atStart, true);

// ---- a codex guardian rollout is refused, however big its first line ----
// `session_meta` carries base_instructions and runs to tens of KB in the real
// thing; a guard that reads a fixed slab and parses what it got back parses
// nothing at all, and "I could not tell" must never read as "not a subagent".
const rollout = (subagent, padKb) => [
  JSON.stringify({
    type: 'session_meta', timestamp: new Date().toISOString(),
    payload: { cwd: TMP, ...(subagent ? { thread_source: 'subagent' } : {}), base_instructions: { text: 'x'.repeat(padKb * 1024) } },
  }),
  ...Array.from({ length: 400 }, (_, i) => JSON.stringify({
    type: 'response_item', timestamp: new Date().toISOString(),
    payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `codex turn ${i} ${'q'.repeat(500)}` }] },
  })),
].join('\n');

for (const padKb of [0, 20, 48]) {
  const guardian = path.join(TMP, `guardian-${padKb}.jsonl`);
  fs.writeFileSync(guardian, `${rollout(true, padKb)}\n`);
  await assert.rejects(
    () => readTraceByPath(guardian, { window: { at: 'tail', bytes: 32 * 1024 } }),
    (e) => e.code === 'trace-not-user-conversation',
    `a guardian rollout with a ${padKb} KB session_meta is refused a window`,
  );
  await assert.rejects(
    () => readTraceByPath(guardian, { offset: 0, limit: 10 }),
    (e) => e.code === 'trace-not-user-conversation',
    `and refused an index page (${padKb} KB)`,
  );
  const real = path.join(TMP, `real-${padKb}.jsonl`);
  fs.writeFileSync(real, `${rollout(false, padKb)}\n`);
  const okWin = await readTraceByPath(real, { window: { at: 'tail', bytes: 32 * 1024 } });
  assert.ok(okWin.turns.length > 0, `the operator's own rollout still opens (${padKb} KB)`);
}

// ---- a line larger than any window blocks, and does not read as the start ----
const wall = path.join(TMP, 'wall.jsonl');
fs.writeFileSync(wall, `${[
  claudeLine(0),
  JSON.stringify({ type: 'file-history-snapshot', blob: 'z'.repeat(9 * 1024 * 1024) }),
  ...Array.from({ length: 40 }, (_, i) => claudeLine(i + 1, 200)),
].join('\n')}\n`);
const beyond = await readTraceByPath(wall, { window: { at: 'tail', bytes: 64 * 1024 } });
const stuck = await readTraceByPath(wall, { window: { at: 'before', cursor: beyond.window.start, bytes: 64 * 1024 } });
assert.equal(stuck.turns.length, 0);
assert.equal(stuck.window.atStart, false, 'a wall is not the beginning of the conversation');
assert.equal(stuck.window.blocked, true, 'and the reader is told why it cannot get past it');

// ---- a torn final line does not cost the last answer its accent ----
const half = path.join(TMP, 'half-written.jsonl');
fs.writeFileSync(half, `${[claudeLine(0), claudeLine(1)].join('\n')}\n{"type":"assistant","mess`);
const t = await readTraceByPath(half, { window: { at: 'tail' } });
assert.equal(t.window.atEnd, true, 'reading to EOF is being at the end, fragment or no fragment');
assert.equal(t.turns[t.turns.length - 1].kind, 'final', 'so the last answer keeps its accent');
assert.ok(t.window.end < fs.statSync(half).size, 'while the cursor still waits in front of the fragment');

// ---- a partial window claims nothing about the whole session ----
const partial = await readTraceByPath(file, { window: { at: 'tail', bytes: 32 * 1024 } });
assert.equal(partial.note, null, 'a per-window count is not a fact about the session');
assert.equal(partial.usage, null);
assert.equal(partial.firstTs, 0);

fs.rmSync(TMP, { recursive: true, force: true });
console.log('trace-window: ok');
