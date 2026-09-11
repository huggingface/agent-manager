// How much conversation the FIRST window of an indexed (database) source holds.
//
// `min` means different things to the two window kinds, and that difference is
// what a cold reader on a database session saw: a byte window grows its span
// until it holds `min` messages, so a small `min` buys a cheap first paint,
// while an index window has the whole conversation parsed already and `min` only
// chooses how many rows to return. Taken literally, the reader's first-paint
// floor of 2 produced two transport records — one exchange — out of any
// conversation, and asking for fewer rows saved nothing.
//
// Run with:  node test/trace-index-history.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-index-history-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true });

const { readTrace } = await import('../src/traces.js');

const EXCHANGES = 40;
const dbFile = path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db');
const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  INSERT INTO session VALUES ('session','/fixture','Fixture');
  -- A second conversation in the same database: a window must never reach into it.
  INSERT INTO session VALUES ('short','/fixture','Short');
  INSERT INTO message VALUES ('one','short',1,'{"role":"user"}');
  INSERT INTO part VALUES ('one-p','one',1,'{"type":"text","text":"short prompt"}');
  INSERT INTO message VALUES ('two','short',2,'{"role":"assistant"}');
  INSERT INTO part VALUES ('two-p','two',2,'{"type":"text","text":"short answer"}');`);
const addMessage = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
const addPart = db.prepare('INSERT INTO part VALUES (?,?,?,?)');
for (let i = 0; i < EXCHANGES; i++) {
  addMessage.run(`m${i}u`, 'session', i * 10, JSON.stringify({ role: 'user' }));
  addPart.run(`p${i}u`, `m${i}u`, i * 10, JSON.stringify({ type: 'text', text: `prompt ${i}` }));
  addMessage.run(`m${i}a`, 'session', i * 10 + 1, JSON.stringify({ role: 'assistant' }));
  // A tool call and its result: the records a reader must not mistake for turns.
  addPart.run(`p${i}t`, `m${i}a`, i * 10 + 1, JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { cmd: `check ${i}` }, output: `ok ${i}` } }));
  addPart.run(`p${i}a`, `m${i}a`, i * 10 + 2, JSON.stringify({ type: 'text', text: `answer ${i}` }));
}
db.close();

const session = { id: 'fixture', cli: 'opencode', path: 'fixture', opencodeSessionId: 'session' };
const read = (window) => readTrace(session, { window: { version: 2, ...window } });
const promptsIn = (page) => page.turns.filter((t) => t.role === 'user'
  && t.blocks.some((b) => b.type === 'text' && b.text.startsWith('prompt '))).length;

// ---- the reader's own first-paint request must arrive readable ----
// 128 KiB / min 2 is what web/src/lib/readerStore.ts asks for on a cold open.
const first = await read({ at: 'tail', bytes: 128 * 1024, min: 2 });
assert.equal(first.window.mode, 'index', 'an opencode session is an indexed source');
assert.ok(promptsIn(first) >= 20,
  `a cold open sees a readable stretch of conversation, not two records (got ${promptsIn(first)} prompts in ${first.turns.length} messages)`);
assert.equal(first.window.atEnd, true, 'and it is the end of the conversation');
assert.equal(first.window.atStart, false, '40 exchanges are not all of it');
assert.equal(first.window.end, EXCHANGES * 2, 'the tail ends at the last message');

// A floor, not an override: asking for MORE than the floor still gets more.
const wide = await read({ at: 'tail', bytes: 128 * 1024, min: 500 });
assert.equal(wide.turns.length, EXCHANGES * 2, 'a large min still returns the whole conversation');
assert.equal(wide.window.atStart, true);

// ---- backward paging keeps honouring `min` exactly ----
// That is a caller walking the conversation a page at a time; its page size is
// its own business, and rounding it up would hand back rows it already has.
const back = await read({ at: 'before', cursor: first.window.start, min: 6 });
assert.equal(back.turns.length, 6, 'a backward page is exactly the size asked for');
assert.equal(back.window.end, first.window.start, 'and it abuts the window it came from');
assert.equal(back.window.start, first.window.start - 6);

const tiny = await read({ at: 'before', cursor: back.window.start, min: 1 });
assert.equal(tiny.turns.length, 1, 'including a single-row page');

// ---- paging back from the first window reaches the beginning exactly once ----
const seen = [];
let cursor = first.window.start;
for (let hops = 0; cursor > 0; hops++) {
  assert.ok(hops < 100, 'paging back terminates');
  const page = await read({ at: 'before', cursor, min: 8 });
  seen.unshift(...page.turns);
  assert.equal(page.window.end, cursor, 'no gap between pages');
  cursor = page.window.start;
}
const whole = [...seen, ...first.turns];
assert.equal(whole.length, EXCHANGES * 2, 'every message appears exactly once across the pages');
assert.deepEqual(
  whole.filter((t) => t.role === 'user').map((t) => t.blocks.find((b) => b.type === 'text')?.text),
  Array.from({ length: EXCHANGES }, (_, i) => `prompt ${i}`),
  'in the order the conversation happened',
);

// ---- a conversation shorter than the floor is not padded, clipped, or mixed
// with the other conversation sitting in the same database ----
const short = await readTrace({ id: 'short', cli: 'opencode', path: 'fixture', opencodeSessionId: 'short' },
  { window: { version: 2, at: 'tail', bytes: 128 * 1024, min: 2 } });
assert.equal(short.turns.length, 2, 'a two-message conversation returns two messages');
assert.equal(short.window.atStart, true, 'and reports the beginning honestly');
assert.equal(short.window.atEnd, true);
assert.deepEqual(short.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)),
  ['short prompt', 'short answer'], 'and only its own messages, not the 40-exchange conversation beside it');
assert.ok(!first.turns.some((t) => t.blocks.some((b) => b.type === 'text' && b.text.startsWith('short '))),
  'nor the other way round');

console.log('trace-index-history: ok');
