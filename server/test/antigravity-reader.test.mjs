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
check('a malformed payload is skipped, not fatal', agy.decodeStep({ idx: 0, step_type: 15, status: 3, step_payload: Buffer.from([0x0a, 0x7f, 1]) }), null);

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

console.log('\nan interactive conversation, which records its folder only in agy\'s cache');
// The pane's agy writes no folder into its prompt step; cache/last_conversations.json
// ({ cwd: id }, what `agy -c` resumes) is the only record. Thinking is kept.
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
live.close();

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
