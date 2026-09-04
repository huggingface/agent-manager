// v2 fragments/cursors, real JSONL and live WAL fixtures. No running agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-protocol-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true });
const { readTraceByPath, readTrace } = await import('../src/traces.js');
const { cachedTrace } = await import('../src/trace-revision.js');
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const event = (type, payload) => ({ type, timestamp: '2026-09-04T00:00:00Z', payload });
const message = (role, text) => event('response_item', { type: 'message', role, content: [{ type: 'text', text }] });
const claude = (id, role, content, extra = {}) => ({ type: role, timestamp: '2026-09-04T00:00:00Z', message: { id, role, content, ...extra } });
const text = (p) => p.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text));
const read = (file, window = {}) => readTraceByPath(file, { window: { version: 2, at: 'tail', bytes: 32 * 1024, min: 1, ...window } });
let db;
try {
  const file = path.join(tmp, 'rollout.jsonl');
  fs.writeFileSync(file, jsonl([event('session_meta', { id: 'test', cwd: tmp }), event('event_msg', { type: 'task_started' }), message('user', 'first prompt'), message('assistant', 'first answer')]));
  const first = await read(file);
  assert.equal(first.activity, 'working');
  assert.equal(first.turns.at(-1).kind, undefined, 'an open task is not guessed final');
  fs.appendFileSync(file, jsonl([event('event_msg', { type: 'task_complete', last_agent_message: 'first answer' }), event('event_msg', { type: 'task_started' }), message('user', 'second prompt'), message('assistant', 'second answer'), event('event_msg', { type: 'task_complete', last_agent_message: 'second answer' })]));
  const after = await read(file, { at: 'after', cursor: first.window.end, generation: first.generation });
  assert.equal(after.generation, first.generation, 'append is the same source generation');
  assert.equal(after.window.start, first.window.end);
  assert.equal(after.turns[0].event.type, 'task-complete', 'the prior task completion is not discarded by alignment to the next task');
  assert.equal(after.turns[0].event.text, 'first answer');
  assert.equal(after.activity, 'waiting');
  assert.ok(after.turns.every((t) => t.id));
  assert.ok(!text(after).includes('first answer'), 'a completion marker is not a duplicate answer');
  const legacy = await readTraceByPath(file, { window: { at: 'after', cursor: first.window.end } });
  assert.ok(text(legacy).includes('second prompt'), 'legacy consumers remain supported');

  // A large backlog stays continuous and respects the requested forward page.
  const cursor = after.window.end;
  fs.appendFileSync(file, jsonl(Array.from({ length: 1000 }, (_, i) => message('user', `backlog-${i} ${'x'.repeat(9000)}`))));
  let offset = cursor, pages = 0, collected = [];
  do {
    const page = await read(file, { at: 'after', cursor: offset, generation: first.generation });
    assert.equal(page.window.start, offset);
    assert.ok(page.window.end > offset);
    assert.ok(page.window.end - offset <= 32 * 1024);
    assert.equal(page.window.gap, undefined);
    collected.push(...text(page)); offset = page.window.end; pages++;
    if (page.window.atEnd) break;
    assert.ok(pages < 500);
  } while (true);
  assert.equal(collected.length, 1000);
  assert.equal(new Set(collected).size, 1000);
  assert.ok(pages > 10);
  fs.writeFileSync(file, jsonl([event('session_meta', { id: 'replacement', cwd: tmp }), message('user', 'replacement prompt')]));
  const replaced = await read(file, { at: 'after', cursor: offset, generation: first.generation });
  assert.equal(replaced.window.reset, true);
  assert.notEqual(replaced.generation, first.generation);
  assert.deepEqual(text(replaced), ['replacement prompt']);

  const fragments = path.join(tmp, 'claude.jsonl');
  fs.writeFileSync(fragments, jsonl([claude('u', 'user', '<div>Please review this markup</div>'), claude('a', 'assistant', [{ type: 'thinking', thinking: 'inspect' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'file' } }])]));
  const c1 = await read(fragments);
  assert.equal(c1.turns[0].role, 'user', 'operator markup is not harness metadata');
  fs.appendFileSync(fragments, jsonl([claude('r', 'user', [{ type: 'tool_result', tool_use_id: 'tool', content: 'result' }]), claude('a', 'assistant', [{ type: 'text', text: 'done' }], { stop_reason: 'end_turn' }), { type: 'queue-operation', operation: 'enqueue', content: 'queued prompt' }]));
  const c2 = await read(fragments, { at: 'after', cursor: c1.window.end });
  assert.equal(c1.turns[1].messageId, c2.turns.find((t) => t.role === 'assistant').messageId, 'cross-request fragments retain the native message id');
  assert.ok(c2.turns.some((t) => t.blocks.some((b) => b.type === 'tool_result' && b.id === 'tool')));
  assert.ok(c2.turns.some((t) => t.event?.type === 'queue'));
  assert.equal(c2.activity, 'waiting');

  // Backward child paging stops at the handoff, not the start of inherited history.
  const child = path.join(tmp, 'child.jsonl');
  fs.writeFileSync(child, jsonl([
    event('session_meta', { id: 'child', cwd: tmp }),
    ...Array.from({ length: 100 }, () => message('user', 'PARENT '.repeat(300))),
    event('response_item', { type: 'agent_message', author: '/root', recipient: '/root/child', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/child\nPayload: child task' }] }),
    ...Array.from({ length: 100 }, () => message('assistant', 'CHILD '.repeat(200))),
  ]));
  let cp = await readTraceByPath(child, { window: { version: 2, at: 'tail', bytes: 32 * 1024, min: 1 } }, true);
  let childPages = 0;
  while (!cp.window.atStart) {
    assert.ok(!text(cp).some((t) => t.includes('PARENT')));
    assert.ok(++childPages < 20);
    cp = await readTraceByPath(child, { window: { version: 2, at: 'before', cursor: cp.window.start, bytes: 32 * 1024, min: 1 } }, true);
  }
  assert.ok(cp.window.start > 0, 'the logical conversation begins after inherited bytes');
  assert.ok(!text(cp).some((t) => t.includes('PARENT')));

  const dbFile = path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db');
  db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
    INSERT INTO session VALUES ('session','/fixture','Fixture');
    INSERT INTO message VALUES ('message','session',1000,'{"role":"assistant"}');
    INSERT INTO part VALUES ('part','message',1000,'{"type":"text","text":"partial"}');
    PRAGMA wal_checkpoint(TRUNCATE);`);
  const session = { id: 'fixture', cli: 'opencode', path: 'fixture', opencodeSessionId: 'session' };
  const dbRead = (window = {}) => readTrace(session, { window: { version: 2, at: 'tail', ...window } });
  const d1 = await dbRead();
  const before = fs.statSync(dbFile);
  db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({ type: 'text', text: 'finished' }), 'part');
  const unchanged = fs.statSync(dbFile);
  assert.equal(before.mtimeMs, unchanged.mtimeMs, 'the main database has not changed');
  assert.equal(before.size, unchanged.size);
  const d2 = await dbRead({ at: 'after', cursor: d1.window.end, generation: d1.generation });
  assert.notEqual(d2.revision, d1.revision, 'a WAL-only write invalidates cached parses');
  assert.equal(d2.generation, d1.generation);
  assert.equal(d2.window.replaceFrom, 0);
  assert.deepEqual(text(d2), ['finished']);
  assert.equal(d2.turns[0].id, d1.turns[0].id, 'mutable index records retain their row identity');

  let parses = 0;
  const parse = async () => { parses++; await new Promise((resolve) => setImmediate(resolve)); return { parsed: true }; };
  const [a, b] = await Promise.all([cachedTrace('fixture-a', 100, parse), cachedTrace('fixture-a', 100, parse)]);
  assert.equal(parses, 1); assert.equal(a, b, 'concurrent summaries share one parse');
  await cachedTrace('fixture-b', 100, parse); await cachedTrace('fixture-a', 100, parse);
  assert.equal(parses, 2, 'switching A/B/A does not evict A');
  console.log('reader-protocol: continuous v2 windows, lifecycle/message/queue fragments, source reset, child boundary, WAL updates and parse cache passed');
} finally { db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
