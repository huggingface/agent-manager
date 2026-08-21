// Reading a trace as WINDOWS: the reader opens on the end of the conversation
// and pages backwards, so none of this may lose a line, repeat one, or run off
// the start of the file. Run with:
//   node test/trace-window.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-window-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.XDG_DATA_HOME = path.join(TMP, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { readTrace, readTraceByPath } = await import('../src/traces.js');

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

// The reader's FIRST paint asks for a strict, small floor. A sparse tail must
// stop as soon as it has enough to render instead of growing to the ordinary
// twelve-message page and putting megabytes in front of the first pixel.
const sparse = path.join(TMP, 'sparse.jsonl');
fs.writeFileSync(sparse, `${Array.from({ length: 20 }, (_, i) => claudeLine(i, 50_000)).join('\n')}\n`);
const firstPaint = await readTraceByPath(sparse, { window: { at: 'tail', bytes: 32 * 1024, min: 2 } });
const ordinary = await readTraceByPath(sparse, { window: { at: 'tail', bytes: 32 * 1024 } });
assert.ok(firstPaint.turns.length >= 2, 'the strict tail still has enough messages to paint');
assert.ok(firstPaint.turns.length < ordinary.turns.length,
  `the first paint stops before an ordinary page (${firstPaint.turns.length} vs ${ordinary.turns.length})`);
assert.ok(firstPaint.window.end - firstPaint.window.start < ordinary.window.end - ordinary.window.start,
  'the strict tail reads a smaller byte range');

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

// ---- codex: a window is cut at a task boundary, never inside one ----
// `task_complete` POINTS BACK at the assistant message it marks. Cut a rollout
// between the two and the pointer dangles — and the normalizer's fallback then
// pushes a verbatim second copy of the answer, so the reader shows a turn the
// conversation does not contain. Windows therefore begin at `task_started`.
const ev = (type, payload, ts) => JSON.stringify({ type, timestamp: ts, payload });
const codexTask = (i) => {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  return [
    ev('event_msg', { type: 'task_started' }, ts),
    ev('turn_context', { model: 'gpt-test', cwd: TMP }, ts),
    ev('response_item', { type: 'message', role: 'user', content: [{ type: 'text', text: `ask ${i} ${'u'.repeat(300)}` }] }, ts),
    ev('response_item', { type: 'function_call', name: 'exec', call_id: `c${i}`, arguments: '{"cmd":"ls"}' }, ts),
    ev('response_item', { type: 'function_call_output', call_id: `c${i}`, output: `out ${i} ${'o'.repeat(300)}` }, ts),
    ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'text', text: `ANSWER ${i} ${'a'.repeat(300)}` }] }, ts),
    ev('event_msg', { type: 'agent_message', message: `ANSWER ${i} ${'a'.repeat(300)}` }, ts),
    ev('event_msg', { type: 'task_complete', last_agent_message: `ANSWER ${i} ${'a'.repeat(300)}` }, ts),
  ].join('\n');
};
const tasks = path.join(TMP, 'rollout-tasks.jsonl');
fs.writeFileSync(tasks, `${[
  ev('session_meta', { cwd: TMP, base_instructions: { text: 'i'.repeat(20 * 1024) } }, new Date().toISOString()),
  ...Array.from({ length: 40 }, (_, i) => codexTask(i)),
].join('\n')}\n`);

const fullCodex = [];
const cHead = await readTraceByPath(tasks, { offset: 0, limit: 500 });
for (let off = 0; off < cHead.total; off += 500) fullCodex.push(...(await readTraceByPath(tasks, { offset: off, limit: 500 })).turns);
const answers = (ts) => ts.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).filter((t) => t.startsWith('ANSWER'));
assert.equal(new Set(answers(fullCodex)).size, answers(fullCodex).length, 'the full parse shows each answer once');

// Every window size, including ones whose boundaries land between an assistant
// message and its task_complete.
for (const bytes of [16 * 1024, 32 * 1024, 64 * 1024]) {
  let stitched = [];
  let page = await readTraceByPath(tasks, { window: { at: 'tail', bytes } });
  let hops = 0;
  const firstLines = [];
  for (;;) {
    firstLines.push(page.window.start);
    stitched = [...page.turns, ...stitched];
    if (page.window.atStart || page.window.blocked) break;
    assert.ok(++hops < 200, 'paging back terminates');
    const before = page.window.start;
    page = await readTraceByPath(tasks, { window: { at: 'before', cursor: before, bytes } });
    assert.equal(page.window.end, before, 'windows still abut exactly');
  }
  const a = answers(stitched);
  assert.equal(new Set(a).size, a.length, `no answer is shown twice (bytes=${bytes})`);
  assert.deepEqual(a, answers(fullCodex), `the same answers, in the same order (bytes=${bytes})`);
  assert.equal(stitched.length, fullCodex.length, `and the same number of turns (bytes=${bytes})`);
  assert.equal(
    stitched.filter((t) => t.kind === 'final').length,
    fullCodex.filter((t) => t.kind === 'final').length,
    `the final-answer accent lands the same number of times (bytes=${bytes})`,
  );
  // Every window except the one holding byte 0 begins ON a task boundary.
  const buf = fs.readFileSync(tasks);
  for (const at of firstLines) {
    if (at === 0) continue;
    const nl = buf.indexOf(0x0a, at);
    const first = JSON.parse(buf.toString('utf8', at, nl < 0 ? buf.length : nl));
    assert.equal(first.payload.type, 'task_started', `a window starts a task, not the middle of one (at ${at})`);
  }
}

// ---- SQLite readers invalidate on WAL writes, including in-place streaming ----
const ocDir = path.join(process.env.XDG_DATA_HOME, 'opencode');
fs.mkdirSync(ocDir, { recursive: true });
const ocPath = path.join(ocDir, 'opencode.db');
const oc = new DatabaseSync(ocPath);
oc.exec(`
  pragma journal_mode = WAL;
  pragma wal_autocheckpoint = 0;
  create table session (
    id text primary key, directory text, title text, model text,
    tokens_input integer, tokens_output integer, tokens_cache_read integer
  );
  create table message (id text primary key, session_id text, time_created integer, data text);
  create table part (id text primary key, message_id text, time_created integer, data text);
`);
oc.prepare('insert into session values (?, ?, ?, ?, 0, 0, 0)').run(
  'ses_reader', TMP, 'Reader test', JSON.stringify({ id: 'test-model' }),
);
oc.prepare('insert into message values (?, ?, ?, ?)').run(
  'msg_1', 'ses_reader', 1, JSON.stringify({ role: 'assistant' }),
);
oc.prepare('insert into part values (?, ?, ?, ?)').run(
  'part_1', 'msg_1', 1, JSON.stringify({ type: 'text', text: 'streaming first' }),
);

const ocSession = { id: 'oc-reader', cli: 'opencode', path: 'reader', opencodeSessionId: 'ses_reader' };
const ocFirst = await readTrace(ocSession, { window: { at: 'tail', min: 2 } });
assert.equal(textOf(ocFirst.turns.at(-1)), 'streaming first');
const mainBefore = fs.statSync(ocPath);
oc.prepare('update part set data = ? where id = ?').run(
  JSON.stringify({ type: 'text', text: 'streaming second' }), 'part_1',
);
const mainAfter = fs.statSync(ocPath);
assert.equal(mainAfter.mtimeMs, mainBefore.mtimeMs, 'the main db does not move while WAL receives the update');
assert.equal(mainAfter.size, mainBefore.size, 'nor does its size');
const ocSecond = await readTrace(ocSession, { window: { at: 'tail', min: 2 } });
assert.equal(textOf(ocSecond.turns.at(-1)), 'streaming second', 'the Reader memo follows the WAL');
oc.close();

fs.rmSync(TMP, { recursive: true, force: true });
console.log('trace-window: ok');
