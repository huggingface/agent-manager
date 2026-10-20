// The sessions a session handed work to (server/src/dispatches.js): which
// operations-log rows are dispatches, and which turn of the TARGET's transcript
// each one started — only that turn, never the peer's other history.
//
// Pinned here, each from a real case on the Space this was built on:
//  - a launch and a prompt both count, and only the caller's own;
//  - the same heads-up sent twice finds two turns, not one twice;
//  - a prompt that lands while the peer is busy is a queue event, not a user
//    message, and still finds its place;
//  - "Login expired" reads like an answer, and is flagged as the error it is;
//  - a refused call has no turn;
//  - the timestamp bisection starts BEFORE the prompt on a large transcript.
// Run with:  node test/dispatches.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatches-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.HOME = path.join(TMP, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.CODEX_HOME = path.join(TMP, 'codex');
const PROJECT = path.join(TMP, 'claude', 'projects', '-tmp-x');
fs.mkdirSync(PROJECT, { recursive: true });

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n').slice(0,6).join(' | ')}`);
  }
};

const T0 = Date.UTC(2026, 8, 29, 17, 0, 0);
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();

// ---- the sessions ----
const sessions = [
  { id: 'boss-1', name: 'boss', cli: 'claude', path: 'boss', sessionUuid: 'u-boss' },
  { id: 'canvas-1', name: 'canvas', cli: 'claude', path: 'w', sessionUuid: 'u-canvas' },
  { id: 'sheet-1', name: 'sheet', cli: 'claude', path: 'w', sessionUuid: 'u-sheet' },
  { id: 'design-1', name: 'design', cli: 'claude', path: 'w', sessionUuid: 'u-design' },
  { id: 'long-1', name: 'long', cli: 'claude', path: 'w', sessionUuid: 'u-long' },
];
fs.writeFileSync(path.join(DATA, 'sessions.json'), JSON.stringify(sessions));

// ---- the operations log ----
let opn = 0;
const op = (sec, { origin = 'boss-1', path: p, query = {}, text, status = 200, result = {}, target }) => JSON.stringify({
  version: 2, id: `op-${++opn}`, at: iso(sec), origin: { id: origin, type: 'agent', name: origin.split('-')[0] },
  ...(target ? { target } : {}), method: 'POST', path: p, query,
  request: text.length > 500 ? { present: true, chars: text.length, sha256: 'x', text } : text,
  status, ok: status < 400, durationMs: 5, result,
});
const TASK = '# Implement the Canvas page format\n\nYou are a worker. ' + 'Build it. '.repeat(80);
const HEADS = 'Heads-up from the orchestrator, no reply needed: feat/format-foundation moved again.';
fs.writeFileSync(path.join(DATA, 'operations.jsonl'), [
  op(10, { path: '/api/agents', query: { cli: 'claude', name: 'canvas' }, text: TASK, status: 201, result: { id: 'canvas-1', name: 'canvas', cli: 'claude' } }),
  op(20, { path: '/api/agents', query: { cli: 'claude', name: 'design' }, text: 'Build three design options.', status: 201, result: { id: 'design-1', name: 'design', cli: 'claude' } }),
  op(30, { path: '/api/agents/sheet-1/prompt', text: HEADS, target: { id: 'sheet-1', name: 'sheet', cli: 'claude' } }),
  op(40, { path: '/api/agents/canvas-1/prompt', text: HEADS, target: { id: 'canvas-1', name: 'canvas', cli: 'claude' } }),
  op(50, { path: '/api/agents/canvas-1/prompt', text: HEADS, target: { id: 'canvas-1', name: 'canvas', cli: 'claude' } }),
  op(60, { path: '/api/agents/sheet-1/prompt', text: 'refused one', status: 400, target: { id: 'sheet-1', name: 'sheet', cli: 'claude' } }),
  // not the caller's: the operator, and another agent
  op(70, { origin: 'canvas-1', path: '/api/agents/sheet-1/prompt', text: HEADS, target: { id: 'sheet-1', name: 'sheet', cli: 'claude' } }),
  // two other sessions send a long-lived peer the SAME words a second apart
  op(39, { origin: 'bravo-1', path: '/api/agents/long-1/prompt', text: 'Run the suite and report.', target: { id: 'long-1', name: 'long', cli: 'claude' } }),
  op(40, { origin: 'alpha-1', path: '/api/agents/long-1/prompt', text: 'Run the suite and report.', target: { id: 'long-1', name: 'long', cli: 'claude' } }),
  // …and again through the shared-Codex envelope, which stamps the sender's id
  op(61, { origin: 'alpha-1', path: '/api/agents/long-1/prompt', text: 'Second identical ask.', target: { id: 'long-1', name: 'long', cli: 'claude' } }),
  op(62, { origin: 'bravo-1', path: '/api/agents/long-1/prompt', text: 'Second identical ask.', target: { id: 'long-1', name: 'long', cli: 'claude' } }),
  // not a dispatch
  JSON.stringify({ version: 2, id: 'op-x', at: iso(80), origin: { id: 'boss-1' }, method: 'POST', path: '/api/groups', request: {}, status: 201, ok: true }),
].join('\n') + '\n');

// ---- the peers' transcripts ----
let uuid = 0;
const user = (sec, text) => JSON.stringify({ type: 'user', uuid: `m${++uuid}`, timestamp: iso(sec), message: { role: 'user', content: text } });
const said = (sec, text, extra = {}) => JSON.stringify({ type: 'assistant', uuid: `m${++uuid}`, timestamp: iso(sec),
  message: { id: `msg${uuid}`, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }, ...extra });
const tool = (sec) => JSON.stringify({ type: 'assistant', uuid: `m${++uuid}`, timestamp: iso(sec),
  message: { id: `msg${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${uuid}`, name: 'Bash', input: { command: 'ls' } }] } });
const queue = (sec, op, text) => JSON.stringify({ type: 'queue-operation', operation: op, timestamp: iso(sec), content: text });
const env = (t) => `[message from boss:] ${t}`;

// canvas: a long history BEFORE the launch (so bisection has to skip it),
// then the launch, then two heads-ups as two turns of their own.
const filler = [];
for (let i = 0; i < 4000; i++) filler.push(said(-3600 + i * 0.5, `older work ${i} `.padEnd(400, '.')));
fs.writeFileSync(path.join(PROJECT, 'u-canvas.jsonl'), [
  ...filler,
  user(-100, 'an operator prompt from before'),
  said(-90, 'operator answer'),
  user(11, env(TASK)),
  tool(12), tool(13),
  said(14, 'The canvas format is built and open as draft PR #32.'),
  user(41, env(HEADS)),
  tool(42),
  said(43, 'Rebased onto the new foundation.'),
  user(51, env(HEADS)),
  said(52, 'Noted, already on it.'),
  user(90, 'the operator, later, about something else'),
  said(91, 'unrelated'),
].join('\n') + '\n');

// sheet: busy when the heads-up arrives — it is queued, then handed to the
// running turn (`remove`), which ends with the sheet's answer.
fs.writeFileSync(path.join(PROJECT, 'u-sheet.jsonl'), [
  user(1, 'the operator started this one'),
  tool(25),
  queue(31, 'enqueue', env(HEADS)),
  queue(33, 'remove', env(HEADS)),
  tool(35),
  said(36, 'Spreadsheet done; picked up the foundation change too.'),
].join('\n') + '\n');

// design: the CLI could not log in, and said so in an "answer".
fs.writeFileSync(path.join(PROJECT, 'u-design.jsonl'), [
  user(21, env('Build three design options.')),
  said(22, 'Login expired · Please run /login', { isApiErrorMessage: true, error: 'authentication_failed' }),
].join('\n') + '\n');

// long: bravo's prompt lands first, alpha's identical one a second later
const stamp = (id, name) => `[message from ${name}:] [AM source ${JSON.stringify({ amSessionId: id, threadId: 't' })}]\n`;
fs.writeFileSync(path.join(PROJECT, 'u-long.jsonl'), [
  user(39.5, '[message from bravo:] Run the suite and report.'),
  said(40, 'BRAVO WORK: 12 passed.'),
  user(41, '[message from alpha:] Run the suite and report.'),
  said(42, 'ALPHA WORK: 14 passed.'),
  user(62.2, stamp('bravo-1', 'bravo') + 'Second identical ask.'),
  said(62.5, 'BRAVO AGAIN.'),
  user(63, stamp('alpha-1', 'alpha') + 'Second identical ask.'),
  said(63.5, 'ALPHA AGAIN.'),
].join('\n') + '\n');

const store = await import('../src/sessions.js');
store.init();
const { dispatchesOf, offsetBefore, dispatchOf, senderOf, _resetForTest, _indexSizeForTest } = await import('../src/dispatches.js');

const list = await dispatchesOf('boss-1', { stateOf: () => 'waiting', colorOf: () => '#d97757' });
const answerOf = (d) => d.exchange.turns.filter((t) => t.role === 'assistant').flatMap((t) => t.blocks).filter((b) => b.type === 'text').map((b) => b.text).join(' ');

console.log('which rows are dispatches');
await check('the caller\'s launches and prompts, in order, refused one included', () => {
  assert.deepEqual(list.map((d) => [d.kind, d.target.name, d.status]), [
    ['launch', 'canvas', 201], ['launch', 'design', 201], ['prompt', 'sheet', 200],
    ['prompt', 'canvas', 200], ['prompt', 'canvas', 200], ['prompt', 'sheet', 400],
  ]);
});
await check('another agent\'s dispatch and non-dispatch calls are not here', () => {
  assert.equal(dispatchOf({ method: 'POST', path: '/api/groups', origin: { id: 'boss-1' } }), null);
  assert.equal(list.length, 6);
});
await check('the target carries its live name, cli and colour', () => {
  assert.deepEqual(list[0].target, { id: 'canvas-1', name: 'canvas', cli: 'claude', color: '#d97757', exists: true, state: 'waiting' });
});

console.log('\nthe turn each one started, and only that turn');
await check('the launch finds the task turn, past an hour of earlier history', () => {
  const d = list[0];
  assert.ok(d.exchange, 'no exchange');
  assert.match(d.exchange.turns[0].blocks[0].text, /Implement the Canvas page format/);
  assert.match(answerOf(d), /draft PR #32/);
  assert.equal(d.exchange.ended, true);
  assert.doesNotMatch(answerOf(d), /older work|operator answer|Rebased/);
});
await check('tool bodies are not shipped, the calls still count', () => {
  const calls = list[0].exchange.turns.flatMap((t) => t.blocks).filter((b) => b.type === 'tool_use');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, '');
});
await check('the same heads-up sent twice finds two turns', () => {
  assert.match(answerOf(list[3]), /Rebased/);
  assert.match(answerOf(list[4]), /already on it/);
  assert.doesNotMatch(answerOf(list[4]), /unrelated/);
});
await check('a prompt queued into a running turn is found at the queue event', () => {
  const d = list[2];
  assert.ok(d.exchange, 'no exchange');
  assert.equal(d.exchange.turns[0].queued, true);
  assert.match(answerOf(d), /Spreadsheet done/);
});
await check('a harness error turn is flagged, not taken for an answer', () => {
  const d = list[1];
  assert.equal(d.exchange.turns.find((t) => t.role === 'assistant').error, 'authentication_failed');
});
await check('a refused call has no turn', () => assert.equal(list[5].exchange, null));

console.log('\nthe last turn of a busy peer');
await check('is open while the peer works, ended once it stops', async () => {
  const busy = await dispatchesOf('boss-1', { stateOf: () => 'working' });
  assert.equal(busy[4].exchange.ended, true, 'a later prompt closes it regardless');
  assert.equal(busy[2].exchange.ended, false, 'the last turn in the file is still running');
  const idle = await dispatchesOf('boss-1', { stateOf: () => 'waiting' });
  assert.equal(idle[2].exchange.ended, true);
});

console.log('\nmany senders, one peer: the envelope says whose turn it is');
await check('the same words from two sessions: each gets its own turn, not the other\'s', async () => {
  const alpha = await dispatchesOf('alpha-1', { stateOf: () => 'waiting' });
  const bravo = await dispatchesOf('bravo-1', { stateOf: () => 'waiting' });
  assert.match(answerOf(alpha[0]), /ALPHA WORK/);
  assert.doesNotMatch(answerOf(alpha[0]), /BRAVO/);
  assert.match(answerOf(bravo[0]), /BRAVO WORK/);
  assert.match(alpha[0].exchange.turns[0].blocks[0].text, /^\[message from alpha:\]/);
});
await check('the shared-Codex envelope is matched on the stamped session id', async () => {
  const alpha = await dispatchesOf('alpha-1', { stateOf: () => 'waiting' });
  const bravo = await dispatchesOf('bravo-1', { stateOf: () => 'waiting' });
  assert.match(answerOf(alpha[1]), /ALPHA AGAIN/);
  assert.match(answerOf(bravo[1]), /BRAVO AGAIN/);
});
await check('a prompt with no envelope is nobody\'s dispatch', () => {
  assert.equal(senderOf('Run the suite and report.'), null);
  assert.deepEqual(senderOf(stamp('alpha-1', 'alpha') + 'x'), { name: 'alpha', sessionId: 'alpha-1' });
});

console.log('\nthe index, under concurrent readers');
{
  const LOG = path.join(TMP, 'concurrent.jsonl');
  const row = (id, sec) => JSON.stringify({ version: 2, id, at: iso(sec), origin: { id: 'caller-1', name: 'caller' }, method: 'POST',
    path: '/api/agents/nobody-1/prompt', request: 'hello', status: 200, ok: true, result: {} });
  fs.writeFileSync(LOG, row('one-operation', 1) + '\n');
  _resetForTest(LOG);
  await check('two first reads at once index each operation once', async () => {
    const [a, b] = await Promise.all([dispatchesOf('caller-1'), dispatchesOf('caller-1'), dispatchesOf('caller-1')]);
    assert.deepEqual(a.map((d) => d.id), ['one-operation']);
    assert.deepEqual(b.map((d) => d.id), ['one-operation']);
    assert.equal(_indexSizeForTest(), 1);
  });
  await check('and reads racing an append do too', async () => {
    fs.appendFileSync(LOG, row('two-operation', 2) + '\n');
    const all = await Promise.all([dispatchesOf('caller-1'), dispatchesOf('caller-1'), dispatchesOf('caller-1')]);
    for (const list of all) assert.deepEqual(list.map((d) => d.id), ['one-operation', 'two-operation']);
    assert.equal(_indexSizeForTest(), 2);
  });
}

console.log('\nbisection');
await check('starts at a line boundary before the prompt, not at the top of the file', async () => {
  const file = path.join(PROJECT, 'u-canvas.jsonl');
  const off = await offsetBefore(file, T0 + 11_000 - 60_000);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(off > 1_000_000, `started at ${off}`);
  assert.equal(text[off - 1], '\n');
  assert.ok(text.indexOf('Implement the Canvas') > off);
});

fs.rmSync(TMP, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
