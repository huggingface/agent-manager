// The Antigravity CLI (`agy`) conversation reader: decoding, digest,
// attribution, the reader's blocks, and a database still being written.
//
// agy keeps one SQLite database per conversation, each step a protobuf. The
// steps below are real agy 1.4.10 output (fixtures/antigravity-steps.json, made
// by fixtures/antigravity-scrub.mjs: only the fields the reader uses, paths
// replaced by @WS@), re-encoded into a database with agy's own schema.
// Run with: node test/antigravity-reader.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reader-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'no-claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
process.env.AM_TRACE_WORKERS = '0';
const WORKSPACES = path.join(process.env.DATA_DIR, 'workspaces');
for (const f of ['work', 'work2', 'delta']) fs.mkdirSync(path.join(WORKSPACES, f), { recursive: true });
const CONV = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'conversations');
fs.mkdirSync(CONV, { recursive: true });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = Object.is(got, want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

// ---- protobuf encoding of the fixture's [field, value] trees ----
function varint(n) {
  const out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
function encode(tree, ws) {
  const parts = [];
  for (const [f, v] of tree) {
    if (typeof v === 'number') { parts.push(varint(f * 8), varint(v)); continue; }
    const body = typeof v === 'string' ? Buffer.from(v.split('@WS@').join(ws)) : encode(v, ws);
    parts.push(varint(f * 8 + 2), varint(body.length), body);
  }
  return Buffer.concat(parts);
}
// agy's own schema (the tables the reader touches, as agy creates them).
const SCHEMA = 'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));';
function writer(id) {
  const db = new DatabaseSync(path.join(CONV, `${id}.db`));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  const put = db.prepare('insert or replace into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)');
  return { db, put: (s, ws) => put.run(s.idx, s.step_type, s.status, encode(s.payload, ws)) };
}
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/antigravity-steps.json', import.meta.url), 'utf8'));
const [TOOLS, MATH] = FIX.conversations;
const ws = (f) => path.join(WORKSPACES, f);
// The fixture's work2 conversation ran in a folder named work2.
const IDS = { a: '79cd3d9b-b387-44da-91c0-2df98a2ae37e', b: '444e8f28-c546-4573-848d-24cd51eb3afc', d: '0d0d0d0d-0000-4000-8000-000000000001' };
for (const [id, conv, root] of [[IDS.a, TOOLS, WORKSPACES], [IDS.b, MATH, WORKSPACES]]) {
  const w = writer(id); for (const s of conv.steps) w.put(s, root); w.db.close();
}
// The same conversation again, in a folder two panes share.
{
  const moved = JSON.parse(JSON.stringify(MATH.steps).replaceAll('@WS@/work2', ws('delta')));
  const w = writer(IDS.d); for (const s of moved) w.put(s, WORKSPACES); w.db.close();
}

const agy = await import('../src/antigravity.js');

console.log('decoding real steps');
const steps = agy.readAgySteps(path.join(CONV, `${IDS.a}.db`));
check('every step decodes', steps.length, TOOLS.steps.length);
check('a prompt carries its folder', steps[0].cwd, ws('work'));
check('the prompt is the operator\'s text, without agy\'s wrappers', steps[0].text, 'Read notes.txt and list the files in this folder. Reply with one short sentence.');
check('a planner step names its tool calls', steps[1].calls.map((c) => c.name).join(), 'read_file,run_command');
check('a tool step names the call it answers', steps[2].call.id, steps[1].calls[0].id);
check('a tool step carries its output', steps[2].output, 'Showing lines 1-1 of 1\n1: hello world');
check('a refused tool step carries the error', steps[3].status === agy.STATUS.ERROR && steps[3].error.startsWith('permission check failed'), true);
check('timestamps are epoch ms', steps[0].ts, 1793292927496);
check('usage is read from the step metadata', JSON.stringify(steps[6].usage), '{"in":2541,"out":38,"cacheRead":4814}');
{
  const bad = agy.decodeStep({ idx: 4, step_type: 15, status: 3, step_payload: Buffer.from([0x0a, 0x7f, 1]) });
  check('a malformed payload is a marker, not fatal', bad.unreadable, true);
  check('the marker keeps its row\'s index, type and status', `${bad.idx}:${bad.type}:${bad.status}`, '4:15:3');
}

console.log('\nwhich conversation is whose');
check('newest conversation in a folder', agy.captureAgyConversation(ws('work'), 0, null)?.id, IDS.a);
check('another pane\'s claim is skipped', agy.captureAgyConversation(ws('work'), 0, new Set([IDS.a])), null);
check('nothing written since launch is not adopted', agy.captureAgyConversation(ws('work'), Date.now() + 60_000, null), null);
check('a different folder does not match', agy.captureAgyConversation(ws('nowhere'), 0, null), null);

fs.writeFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), JSON.stringify([
  { id: 'am-a', name: 'a', cli: 'antigravity', path: 'work', antigravityConversationId: IDS.a },
  { id: 'am-b', name: 'b', cli: 'antigravity', path: 'work2' },
  { id: 'am-d1', name: 'd1', cli: 'antigravity', path: 'delta' },
  { id: 'am-d2', name: 'd2', cli: 'antigravity', path: 'delta' },
  { id: 'am-gone', name: 'gone', cli: 'antigravity', path: 'work', antigravityConversationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
  { id: 'am-i', name: 'i', cli: 'antigravity', path: 'inter' },
]));
const store = await import('../src/sessions.js');
store.init();
const traces = await import('../src/traces.js');

console.log('\na conversation whose folder is only in agy\'s cache');
// A prompt seeded at launch (`agy -i`) carries no folder in its step, so
// cache/last_conversations.json ({ cwd: id }, what `agy -c` resumes) is the
// only record until a later prompt. Thinking is kept.
const IID = '1a1a1a1a-0000-4000-8000-000000000002';
{
  const w = writer(IID);
  const T0 = 1793294017;
  const st = (idx, type, body, md = []) => w.put({ idx, step_type: type, status: 3, payload: [[1, type], [4, 3], [5, [[1, [[1, T0 + idx], [2, 0]]], ...md]], ...body] }, WORKSPACES);
  st(0, 14, [[19, [[2, 'what is in hello.txt?']]]]);
  st(1, 15, [[20, [[3, '**Reading the file**\n\nI will read it.'], [7, [[1, 'call_1'], [2, 'read_file'], [3, `{"Path":"${ws('inter')}/hello.txt"}`]]]]]]);
  st(2, 132, [[140, [[2, [[1, 'PELICAN-42']]]]]], [[4, [[1, 'call_1'], [2, 'read_file'], [3, '{}']]]]);
  st(3, 15, [[20, [[1, 'It says PELICAN-42.']]]]);
  w.db.close();
  fs.mkdirSync(path.join(CONV, '..', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(CONV, '..', 'cache', 'last_conversations.json'), JSON.stringify({ [ws('inter')]: IID }));
  fs.mkdirSync(ws('inter'), { recursive: true });
}
check('the cache names the folder', agy.listAgyConversations().find((c) => c.id === IID)?.cwd, ws('inter'));
check('so the pane\'s conversation is found', agy.captureAgyConversation(ws('inter'), 0, null)?.id, IID);
check('thinking is decoded', agy.readAgySteps(path.join(CONV, `${IID}.db`))[1].thinking.startsWith('**Reading the file**'), true);

console.log('\nthe Overview digest');
const digests = await traces.traceDigests();
const A = digests.get('am-a');
check('last prompt', A?.lastPromptText, 'Now run ls -la, and answer with the file count in a short markdown bullet list.');
check('last answer', A?.lastAssistantText, '* **Regular files**: 1 ([`notes.txt`](file://' + ws('work') + '/notes.txt)) * **Total entries** (including `.` and `..`): 3');
check('tool calls since the prompt', A?.sinceToolCalls, 1);
check('tool names since the prompt', A?.sinceTools.run_command, 1);
check('tokens since the prompt', A?.sinceTokens, 2541 + 38 + 2221 + 51);
check('a finished turn is not running', A?.running, false);
check('the previous answer is not this turn\'s', A?.turnsLog.length, 0);
check('an unpinned pane alone in its folder is matched by folder', digests.get('am-b')?.lastAssistantText, '391');
check('panes sharing a folder get nothing rather than a guess', digests.get('am-d1') || digests.get('am-d2') || null, null);
check('a pin to a deleted conversation shows nothing', digests.get('am-gone') || null, null);
check('an interactive conversation is matched through the cache', digests.get('am-i')?.lastAssistantText, 'It says PELICAN-42.');
check('the file it read is listed', digests.get('am-i')?.sinceFiles.join(), ws('inter') + '/hello.txt');
check('the targeted digest agrees', (await traces.digestFor(store.get('am-a')))?.lastPromptText, A?.lastPromptText);
const usage = (await traces.buildTraces()).sessions.find((s) => s.id === 'am-a');
check('session totals: prompts', usage.prompts, 2);
check('session totals: tool calls', usage.toolCalls, 3);
check('session totals: tokens in', usage.tokensIn, 6858 + 2541 + 2221);

console.log('\nthe reader');
const t = await traces.readTrace(store.get('am-a'), { offset: 0, limit: 100 });
check('labelled as Antigravity CLI', t.harnessLabel, 'Antigravity CLI');
check('roles in order', t.turns.map((m) => m.role).join(), 'user,assistant,user,assistant,assistant');
const first = t.turns[1].blocks;
check('each result sits right after its call', first.map((b) => b.type).join(), 'tool_use,tool_result,tool_use,tool_result');
check('the call carries its arguments', JSON.parse(first[0].text).Path, ws('work') + '/notes.txt');
check('a refused call reads as failed', first[3].failed, true);
const sh = t.turns[3].blocks[0];
check('a finished command reads as a shell block', sh.type, 'shell');
check('with its command line', sh.command, 'ls -la');
check('its exit code', sh.exitCode, 0);
check('and its output, without agy\'s preamble', sh.stdout.startsWith('total 1\n'), true);
check('agy\'s notices to the model are not shown', t.turns.some((m) => m.blocks.some((b) => /subagents and background tasks/.test(b.text || ''))), false);
check('the answer is marked final', t.turns[4].kind, 'final');
check('the folder is reported', t.cwd, ws('work'));
check('idle after a finished turn', t.activity, 'waiting');
check('trace location is the conversation database', (await traces.traceLocation(store.get('am-a')))?.path, path.join(CONV, `${IDS.a}.db`));
check('no location for a deleted conversation', await traces.traceLocation(store.get('am-gone')), null);
const ti = await traces.readTrace(store.get('am-i'), { offset: 0, limit: 100 });
check('thinking is shown before the call', ti.turns[1].blocks.map((b) => b.type).join(), 'thinking,tool_use,tool_result');
let err = null;
try { await traces.readTrace(store.get('am-d1'), {}); } catch (e) { err = e.code; }
check('a shared folder has no trace to guess at', err, 'no-trace');
const win = await traces.readTrace(store.get('am-a'), { window: { at: 'tail', version: 2 } });
check('the reader window serves the tail by index', win.window.mode === 'index' && win.window.atEnd, true);

console.log('\na turn being written (WAL, writer still open)');
const live = new DatabaseSync(path.join(CONV, `${IDS.a}.db`));
const T = Math.floor(Date.now() / 1000);
const step = (idx, type, status, body) => live.prepare('insert or replace into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)')
  .run(idx, type, status, encode([[1, type], [4, status], [5, [[1, [[1, T + idx], [2, 0]]]]], ...body], WORKSPACES));
step(9, 14, 3, [[19, [[2, 'and now?'], [12, [[12, `file://${ws('work')}`]]]]]]);
step(10, 15, 8, [[20, [[1, 'Half an ans']]]]);
const busy = await traces.digestFor(store.get('am-a'));
check('the new prompt shows while the writer holds the WAL', busy?.lastPromptText, 'and now?');
check('a generating step reads as running', busy?.running, true);
check('the reader says working', (await traces.readTrace(store.get('am-a'), { offset: 0, limit: 100 })).activity, 'working');
step(10, 15, 3, [[20, [[1, 'Half an answer, finished.']]]]);
const done = await traces.digestFor(store.get('am-a'));
check('the finished step replaces the partial one', done?.lastAssistantText, 'Half an answer, finished.');
check('and the turn is over', done?.running, false);
const full = agy.readAgySteps(path.join(CONV, `${IDS.a}.db`));
const before = full.slice(0, 6);
check('a refresh from an earlier read equals a full read', JSON.stringify(agy.readAgySteps(path.join(CONV, `${IDS.a}.db`), before)), JSON.stringify(full));
live.prepare('delete from steps where idx >= 9').run();
check('a conversation that lost rows is read whole', agy.readAgySteps(path.join(CONV, `${IDS.a}.db`), full).length, TOOLS.steps.length);
live.close();

console.log('\na long conversation is re-read from its tail');
{
  const LID = '2b2b2b2b-0000-4000-8000-000000000003';
  const w = writer(LID);
  const st = (idx, status, text) => w.put({ idx, step_type: 15, status, payload: [[1, 15], [4, status], [5, [[1, [[1, 1793290000 + idx], [2, 0]]]]], [20, [[1, text]]]] }, WORKSPACES);
  for (let i = 0; i < 50; i++) st(i, 3, `step ${i}`);
  st(50, 2, 'still going');
  const p = path.join(CONV, `${LID}.db`);
  const prev = agy.readAgySteps(p);
  st(50, 3, 'done now'); st(51, 3, 'and one more');
  const next = agy.readAgySteps(p, prev);
  check('the settled head is kept as it was', next[0] === prev[0] && next[18] === prev[18], true);
  check('the margin before the tail is read again', next[19] === prev[19], false);
  check('the in-flight step is replaced', next[50].text, 'done now');
  check('new steps are appended', next.length, 52);
  check('and the result equals a full read', JSON.stringify(next), JSON.stringify(agy.readAgySteps(p)));
  w.db.close();
}

console.log('\none bad step costs that step, not the conversation');
{
  const BID = '3c3c3c3c-0000-4000-8000-000000000004';
  const w = writer(BID);
  const T1 = 1793295000;
  const md = (idx) => [5, [[1, [[1, T1 + idx], [2, 0]]]]];
  const raw = w.db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)');
  w.put({ idx: 0, step_type: 14, status: 3, payload: [[1, 14], [4, 3], md(0), [19, [[2, 'first']]]] }, WORKSPACES);
  // A valid step whose metadata holds a truncated varint (Codex's case).
  raw.run(1, 15, 3, Buffer.from([0x2a, 0x01, 0x80]));
  // Type 14, then metadata whose bytes hold wire type 4 (Claude Code's case).
  raw.run(2, 14, 3, Buffer.from([0x08, 0x0e, 0x2a, 0x01, 0x0c]));
  // A planner response cut short inside its text.
  raw.run(3, 15, 3, Buffer.concat([encode([[1, 15], [4, 3], md(3)], WORKSPACES), Buffer.from([0xa2, 0x01, 0x03, 0x0a, 0x09, 0x41])]));
  // A tool step whose call (metadata 4) has a field with the wrong wire type.
  raw.run(4, 132, 3, Buffer.concat([Buffer.from([0x08, 0x84, 0x01]), Buffer.from([0x2a, 0x04, 0x22, 0x02, 0x0b, 0x00])]));
  // A timestamp beyond year 9999.
  w.put({ idx: 5, step_type: 15, status: 3, payload: [[1, 15], [4, 3], [5, [[1, [[1, 2 ** 52], [2, 0]]]]], [20, [[1, 'from the far future']]]] }, WORKSPACES);
  // Not a protobuf at all.
  raw.run(6, 15, 3, Buffer.from([0x0a, 0x7f, 1]));
  w.put({ idx: 7, step_type: 14, status: 3, payload: [[1, 14], [4, 3], md(7), [19, [[2, 'second'], [12, [[12, `file://${ws('work')}`]]]]]] }, WORKSPACES);
  w.put({ idx: 8, step_type: 15, status: 3, payload: [[1, 15], [4, 3], md(8), [20, [[1, 'still here']]]] }, WORKSPACES);
  w.db.close();
  const p = path.join(CONV, `${BID}.db`);
  let got = null, e = null;
  try { got = agy.readAgySteps(p); } catch (x) { e = x.message; }
  check('the conversation still reads', e, null);
  check('every row is a step', got?.length, 9);
  check('a bad nested field keeps the step, with its type and status', `${got?.[1].type}:${got?.[1].status}:${!!got?.[1].unreadable}`, '15:3:false');
  check('so does a wrong wire type inside the metadata', `${got?.[2].type}:${got?.[2].unreadable ? 'x' : got?.[2].text}`, '14:');
  check('a truncated planner response reads as no text', got?.[3].text, '');
  check('a call with a bad field is dropped, the step kept', `${got?.[4].type}:${got?.[4].call ?? null}`, '132:null');
  check('an impossible timestamp reads as none', got?.[5].ts, 0);
  check('and its text is kept', got?.[5].text, 'from the far future');
  check('a payload that is not a protobuf is a marker', got?.[6].unreadable, true);
  check('the steps after them are read', `${got?.[7].text}|${got?.[8].text}`, 'second|still here');
  const shown = await traces.readTrace({ id: 'am-bad', cli: 'antigravity', antigravityConversationId: BID }, { offset: 0, limit: 100 }).catch((x) => ({ error: x.message }));
  check('the reader opens it', shown.error, undefined);
  check('the unreadable step is a marker in the reader', shown.turns?.some((m) => m.blocks.some((b) => b.text === '[Antigravity step 6 could not be read]')), true);
  check('and the answer after it is shown', shown.turns?.at(-1).blocks[0].text, 'still here');
  const dg = await traces.digestFor({ id: 'am-bad', cli: 'antigravity', antigravityConversationId: BID });
  check('the digest has the last prompt and answer', `${dg?.lastPromptText}|${dg?.lastAssistantText}`, 'second|still here');
}

console.log('\nthe tail re-read notices rewinds and retired steps');
{
  const RID = '4d4d4d4d-0000-4000-8000-000000000005';
  const w = writer(RID);
  const st = (idx, type, status, text) => w.put({ idx, step_type: type, status, payload: [[1, type], [4, status], [5, [[1, [[1, 1793291000 + idx], [2, 0]]]]], type === 14 ? [19, [[2, text]]] : [20, [[1, text]]]] }, WORKSPACES);
  for (let i = 0; i < 80; i++) st(i, i % 2 ? 15 : 14, 3, `v1 ${i}`);
  const p = path.join(CONV, `${RID}.db`);
  const prev = agy.readAgySteps(p);
  // A rewind deep below the margin, the same number of rows written back.
  w.db.prepare('delete from steps where idx >= 10').run();
  for (let i = 10; i < 80; i++) st(i, i % 2 ? 15 : 14, 3, `v2 ${i}`);
  const next = agy.readAgySteps(p, prev);
  check('rows rewritten deep in the history are read again', next[20].text, 'v2 20');
  check('and the result equals a full read', JSON.stringify(next), JSON.stringify(agy.readAgySteps(p)));
  // A WAITING tool step left by a killed run, then the operator's next prompt.
  st(80, 132, 9, 'abandoned'); st(81, 14, 3, 'next prompt');
  for (let i = 82; i < 140; i++) st(i, 15, 3, `answer ${i}`);
  const a = agy.readAgySteps(p);
  st(140, 15, 3, 'one more');
  const b = agy.readAgySteps(p, a);
  check('a WAITING step from a superseded turn no longer holds the tail open', b[81] === a[81], true);
  check('only the margin is read again', b[140 - 33] === a[140 - 33] && b[140 - 32] !== a[140 - 32], true);
  check('and the result equals a full read', JSON.stringify(b), JSON.stringify(agy.readAgySteps(p)));
  st(141, 132, 9, 'pending'); st(142, 15, 3, 'after');
  const c = agy.readAgySteps(p);
  for (let i = 143; i < 190; i++) st(i, 15, 3, `more ${i}`);
  const d = agy.readAgySteps(p, c);
  check('a WAITING step of the current turn still does', d[141] !== c[141], true);
  w.db.close();
}

console.log('\nreading leaves agy\'s folder as it was');
{
  const HID = '5e5e5e5e-0000-4000-8000-000000000006';
  const w = writer(HID);
  w.put({ idx: 0, step_type: 14, status: 3, payload: [[1, 14], [4, 3], [5, [[1, [[1, 1793280000], [2, 0]]]]], [19, [[2, 'old'], [12, [[12, `file://${ws('hist')}`]]]]]] }, WORKSPACES);
  w.db.close();
  const p = path.join(CONV, `${HID}.db`);
  const hourAgo = new Date(Date.now() - 3600_000);
  fs.utimesSync(p, hourAgo, hourAgo);
  const side = () => ['-wal', '-shm'].filter((x) => fs.existsSync(p + x)).join() || 'none';
  check('a closed conversation has no sidecars', side(), 'none');
  const floor = Date.now() - 2000;
  check('capture does not adopt an hour-old conversation', agy.captureAgyConversation(ws('hist'), floor, null), null);
  check('and leaves no sidecar behind', side(), 'none');
  check('nor does a second capture adopt it', agy.captureAgyConversation(ws('hist'), floor, null), null);
  agy.readAgySteps(p); agy.agyWaitingStep(HID); agy.listAgyConversations();
  check('reading, the permission check and listing create none', side(), 'none');
  check('its activity is still an hour old', Math.abs(agy.agyActivityMs(p) - hourAgo.getTime()) < 1000, true);
  fs.writeFileSync(`${p}-wal`, '');
  check('an empty WAL beside it is no activity', Math.abs(agy.agyActivityMs(p) - hourAgo.getTime()) < 1000, true);
  check('so capture still skips it', agy.captureAgyConversation(ws('hist'), floor, null), null);
  fs.rmSync(`${p}-wal`);
}

console.log('\nmemory: only conversations in use keep their steps');
{
  const BIG = 'x'.repeat(100_000);
  const ids = [];
  for (let k = 0; k < 12; k++) {
    const id = `6f6f6f6f-0000-4000-8000-0000000001${String(k).padStart(2, '0')}`;
    ids.push(id);
    const w = writer(id);
    const T2 = 1793270000 + k * 100;
    w.put({ idx: 0, step_type: 14, status: 3, payload: [[1, 14], [4, 3], [5, [[1, [[1, T2], [2, 0]]]]], [19, [[2, `history ${k}`], [12, [[12, `file://${ws('archive')}`]]]]]] }, WORKSPACES);
    for (let i = 1; i <= 20; i++) {
      w.put({ idx: i, step_type: 132, status: 3, payload: [[1, 132], [4, 3], [5, [[1, [[1, T2 + i], [2, 0]]], [4, [[1, `c${i}`], [2, 'view_file'], [3, '{"AbsolutePath":"/x"}']]]]], [140, [[2, [[1, BIG]]]]]] }, WORKSPACES);
    }
    w.db.close();
  }
  await traces.traceDigests();
  await traces.buildTraces();
  const cached = traces.agyStepsCached();
  check('the bulk pass keeps no steps of conversations no pane holds', cached.some((c) => ids.some((id) => c.path.includes(id))), false);
  check('at most a handful of conversations keep their steps', cached.length <= 8, true);
  const one = agy.readAgySteps(path.join(CONV, `${ids[0]}.db`));
  check('a large tool output is kept clipped', one[1].output.length, agy.TEXT_KEEP);
  check('with its full length', one[1].outputLength, BIG.length);
  const tr = await traces.readTrace({ id: 'am-hist', cli: 'antigravity', antigravityConversationId: ids[0] }, { offset: 0, limit: 100 });
  const res = tr.turns.flatMap((m) => m.blocks).find((b) => b.type === 'tool_result');
  check('the reader counts what was cut from the full output', res.text.length + res.more, BIG.length);
  for (const id of ids.slice(1)) await traces.readTrace({ id: 'am-hist', cli: 'antigravity', antigravityConversationId: id }, { offset: 0, limit: 1 });
  check('opening many in the Reader keeps only the most recent few', traces.agyStepsCached().length, 8);
}

console.log('\nthe unpinned fallback');
{
  const share = await import('../src/share.js');
  const all = () => store.list();
  check('alone in its folder, a pane finds its conversation', path.basename((await share.findTrace(store.get('am-b'), all()))?.src || ''), `${IDS.b}.db`);
  const mover = store.create({ name: 'mover', cli: 'antigravity', path: 'elsewhere' });
  store.update(mover.id, { antigravityConversationId: IDS.b });
  check('but not one another pane is pinned to', await share.findTrace(store.get('am-b'), all()), null);
  store.update(mover.id, { antigravityConversationId: null });
  store.update('am-b', { antigravityCaptureSince: Date.now() + 60_000 });
  check('nor one older than the time it shared its folder', await share.findTrace(store.get('am-b'), all()), null);
  await new Promise((r) => setTimeout(r, 500));
  await traces.traceDigests();
  const dg = await traces.traceDigests({ fresh: true });
  check('and the digest agrees', dg.get('am-b') || null, null);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
