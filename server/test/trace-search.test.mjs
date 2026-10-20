// Searching the WHOLE conversation, as opposed to the stretch a reader loaded.
//
// The case that matters is the one the reader cannot answer for itself: a term
// that appears ONLY near the beginning of a transcript far larger than anything
// the reader retains. If this suite can be satisfied by searching a tail, it is
// not testing the feature.
//
// Run with:  node test/trace-search.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-search-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true });

const { readTraceByPath, searchTrace, searchTraceByPath } = await import('../src/traces.js');

// ---------- a Claude transcript far larger than any reader window ----------
const N = 400;
const file = path.join(tmp, 'session.jsonl');
const line = (i, text, extra = {}) => JSON.stringify({
  type: i % 2 === 0 ? 'user' : 'assistant',
  cwd: tmp,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  message: {
    role: i % 2 === 0 ? 'user' : 'assistant',
    ...(i % 2 ? { id: `m${i}`, model: 'claude-test' } : {}),
    content: [{ type: 'text', text }],
    ...extra,
  },
});
const lines = [];
// The needle, in the very first exchange, then ~3 MB of unrelated conversation.
lines.push(line(0, 'please check the ZEPHYRQUARTZ deployment before anything else'));
lines.push(line(1, 'Looking at ZEPHYRQUARTZ now.'));
for (let i = 2; i < N; i++) lines.push(line(i, `turn ${i} ${'padding '.repeat(1000)}`));
// A tool call and its output near the middle, so tool text is covered too.
lines.push(JSON.stringify({ type: 'assistant', cwd: tmp, timestamp: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  message: { role: 'assistant', id: 'tool-msg', content: [
    { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'grep OBSIDIANFERN src' } }] } }));
lines.push(JSON.stringify({ type: 'user', cwd: tmp, timestamp: new Date(Date.UTC(2026, 0, 2, 0, 1)).toISOString(),
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call-1', content: 'src/a.ts: LAPISTHISTLE = 1' }] } }));
for (let i = N; i < N + 40; i++) lines.push(line(i, `turn ${i} ${'padding '.repeat(1000)}`));
lines.push(line(N + 40, 'and finally, a quoted "phrase (with punctuation)" plus héllo Ünicode'));
fs.writeFileSync(file, `${lines.join('\n')}\n`);
const SIZE = fs.statSync(file).size;
assert.ok(SIZE > 3 * 1024 * 1024, `the fixture is bigger than any reader budget (${(SIZE / 1048576).toFixed(1)} MiB)`);

// The reader's own cold open cannot see the needle: that is the premise.
const cold = await readTraceByPath(file, { window: { version: 2, at: 'tail', bytes: 128 * 1024, min: 2 } });
const coldText = cold.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
assert.ok(!coldText.includes('ZEPHYRQUARTZ'), 'the needle is outside the loaded window');
assert.equal(cold.window.atStart, false);

const run = (opts) => searchTraceByPath(file, opts);

// ---- a term only at the very beginning is found ----
const first = await run({ q: 'ZEPHYRQUARTZ' });
assert.ok(first.hits.length >= 2, `found the needle far outside the tail (${first.hits.length} hits)`);
assert.equal(first.complete, true, 'and scanned to the beginning of the conversation');
assert.equal(first.next, null);
assert.ok(first.hits.every((h) => h.snippet.text.toLowerCase().includes('zephyrquartz')),
  'every hit carries an excerpt containing the match');
assert.ok(first.hits[0].snippet.length > 0 && first.hits[0].snippet.at >= 0,
  'with the match located inside the excerpt rather than marked up');
assert.ok(first.hits.every((h) => h.window && h.window.at === 'before' && h.window.cursor > 0 && h.window.bytes > 0),
  'and a complete window locator to open it with');

// ---- case-insensitive, literal, and honest about punctuation/unicode ----
assert.equal((await run({ q: 'zephyrquartz' })).hits.length, first.hits.length, 'matching is case-insensitive');
assert.ok((await run({ q: '"phrase (with punctuation)"' })).hits.length >= 1, 'punctuation is literal, not a pattern');
assert.ok((await run({ q: 'héllo Ünicode' })).hits.length >= 1, 'non-ASCII text matches');
assert.equal((await run({ q: 'NOTHINGLIKETHISEXISTS' })).hits.length, 0, 'a term that is not there has no hits');
assert.equal((await run({ q: 'NOTHINGLIKETHISEXISTS' })).complete, true,
  'and the scan says it covered the conversation, which is what makes "no matches" true');

// ---- tool names, tool input and tool output are conversation text ----
// A tool call and its result reconcile into one turn, so each of these is one
// hit — which is also why they need separate needles to be told apart.
assert.equal((await run({ q: 'OBSIDIANFERN' })).hits.length, 1, "a tool call's input is searched");
assert.equal((await run({ q: 'LAPISTHISTLE' })).hits.length, 1, 'and its output');
assert.ok((await run({ q: 'Bash' })).hits.length >= 1, 'and the tool name');

// ---- the locator really opens a window containing the match ----
const target = first.hits[first.hits.length - 1];
// Exactly the locator the search handed back — no guessed page size.
const around = await readTraceByPath(file, { window: { version: 2, ...target.window } });
const aroundText = around.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
assert.ok(aroundText.includes('ZEPHYRQUARTZ'),
  'the window a hit points at contains the match, without loading everything in between');
assert.ok(around.window.end <= Number(target.window.cursor), 'and stops at the hit rather than running to the tail');
assert.ok(around.window.end < SIZE, 'so the live tail was never fetched to get there');

// ---- paging is bounded, deterministic and non-overlapping ----
const paged = [];
let cursor;
for (let i = 0; ; i++) {
  assert.ok(i < 60, 'paging terminates');
  const page = await run({ q: 'padding', limit: 5, cursor });
  paged.push(...page.hits.map((h) => `${h.ts}:${h.snippet.at}`));
  if (!page.next) { assert.equal(page.complete, true, 'the last page reports a completed scan'); break; }
  assert.notEqual(page.next, cursor, 'each page advances the cursor');
  cursor = Number(page.next);
}
assert.equal(new Set(paged).size, paged.length, 'no hit is returned by two pages');
assert.ok(paged.length > 100, `paging reaches the whole conversation (${paged.length} hits)`);

// ---- a bad query is refused, not guessed at ----
for (const bad of ['', '   ']) {
  await assert.rejects(() => run({ q: bad }), (e) => e.code === 'bad-query', `refuses ${JSON.stringify(bad)}`);
}
await assert.rejects(() => run({ q: 'x'.repeat(500) }), (e) => e.code === 'bad-query', 'refuses an oversized query');

// ---- an indexed source searches its own conversation and no other ----
const dbFile = path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db');
const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  INSERT INTO session VALUES ('mine','/fixture','Mine');
  INSERT INTO session VALUES ('other','/fixture','Other');
  INSERT INTO message VALUES ('o1','other',1,'{"role":"user"}');
  INSERT INTO part VALUES ('o1p','o1',1,'{"type":"text","text":"MARMALADEHILL belongs to the other conversation"}');`);
const addM = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
const addP = db.prepare('INSERT INTO part VALUES (?,?,?,?)');
addM.run('m0', 'mine', 0, JSON.stringify({ role: 'user' }));
addP.run('p0', 'm0', 0, JSON.stringify({ type: 'text', text: 'the oldest prompt mentions CINNABARWELL once' }));
for (let i = 1; i < 80; i++) {
  addM.run(`m${i}`, 'mine', i, JSON.stringify({ role: i % 2 ? 'assistant' : 'user' }));
  addP.run(`p${i}`, `m${i}`, i, JSON.stringify({ type: 'text', text: `ordinary message ${i}` }));
}
db.close();
const dbSession = { id: 'db-fixture', cli: 'opencode', path: 'fixture', opencodeSessionId: 'mine' };
const dbHits = await searchTrace(dbSession, { q: 'CINNABARWELL' });
assert.equal(dbHits.mode, 'index');
assert.equal(dbHits.hits.length, 1, 'the oldest message in a database conversation is searchable');
assert.equal(dbHits.complete, true);
assert.equal((await searchTrace(dbSession, { q: 'MARMALADEHILL' })).hits.length, 0,
  'and a conversation beside it in the same database is never searched');

console.log('trace-search: ok');
