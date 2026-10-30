// An Antigravity pane waiting on a permission prompt shows the input-required
// badge. agy records the pending tool as a step with status WAITING (9) in the
// conversation database; the runner reads that status column for a live pane's
// pinned conversation and feeds it to the pane's input-required tracker.
// `agy` is stubbed by a sleeping process; the databases are written here.
// Run with: node test/antigravity-permission.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-permission-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(TMP, 'input-required');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'no-claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
fs.mkdirSync(process.env.HOME);

const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
config.ensureDirs(); sessions.init();
const agy = config.cliById('antigravity');
agy.run = agy.cont = 'sleep 120';
agy.resume = () => 'sleep 120';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}\n         want ${want}`}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const CONV = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'conversations');
fs.mkdirSync(CONV, { recursive: true });
const SCHEMA = 'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`step_payload` blob,PRIMARY KEY (`idx`));';
// Payloads are junk on purpose: the badge must not depend on decoding them.
function conversation(id) {
  const db = new DatabaseSync(path.join(CONV, `${id}.db`));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  const put = db.prepare('insert or replace into steps (idx, step_type, status, step_payload) values (?, ?, ?, ?)');
  return (idx, type, status) => put.run(idx, type, status, Buffer.from([0xff, 0xff, 0xff]));
}
const USER = 14, PLANNER = 15, TOOL = 132;
const badge = (s) => runner.agentInfo().get(s.id)?.inputRequired?.kind ?? null;

const C = '9a9a9a9a-0000-4000-8000-00000000000c';
const C2 = '9a9a9a9a-0000-4000-8000-0000000000c2';
const S = '9a9a9a9a-0000-4000-8000-000000000005';
const step = conversation(C);
conversation(C2)(0, USER, 3);
const shared = conversation(S);

const pinned = sessions.create({ name: 'agy', cli: 'antigravity', path: 'alone' });
sessions.update(pinned.id, { antigravityConversationId: C });
const left = sessions.create({ name: 'agy-l', cli: 'antigravity', path: 'shared' });
const right = sessions.create({ name: 'agy-r', cli: 'antigravity', path: 'shared' });
const asleep = sessions.create({ name: 'agy-off', cli: 'antigravity', path: 'off' });
sessions.update(asleep.id, { antigravityConversationId: S });

try {
  runner.ensureRunning(sessions.get(pinned.id));
  runner.ensureRunning(sessions.get(left.id));
  runner.ensureRunning(sessions.get(right.id));
  await pause(300);
  check('the panes are up', [pinned, left, right].every((s) => runner.isRunning(s.id)), true);

  console.log('a live, pinned pane');
  step(0, USER, 3); step(1, PLANNER, 3);
  check('nothing pending, no badge', badge(pinned), null);
  step(2, TOOL, 9);
  check('a WAITING tool step sets it', badge(pinned), 'permission');
  check('the pane reads as needing input', runner.agentInfo().get(pinned.id)?.inputRequired?.cli, 'antigravity');
  step(2, TOOL, 3);
  check('approved and DONE clears it', badge(pinned), null);
  step(3, TOOL, 9);
  check('the next prompt sets it again', badge(pinned), 'permission');
  step(3, TOOL, 7);
  check('ERROR clears it', badge(pinned), null);
  step(4, TOOL, 9);
  check('set', badge(pinned), 'permission');
  step(4, TOOL, 6);
  check('cancelled (6) clears it', badge(pinned), null);
  step(5, PLANNER, 3); step(6, TOOL, 9); step(7, PLANNER, 8);
  check('a WAITING step behind later output still counts', badge(pinned), 'permission');
  step(8, USER, 3);
  check('a newer prompt retires a WAITING left by an old run', badge(pinned), null);

  console.log('\nthe pin decides');
  step(9, TOOL, 9);
  check('set again', badge(pinned), 'permission');
  sessions.update(pinned.id, { antigravityConversationId: C2 });
  check('a new pin with nothing pending clears it', badge(pinned), null);
  sessions.update(pinned.id, { antigravityConversationId: C });
  check('back on the waiting conversation, it shows', badge(pinned), 'permission');
  sessions.update(pinned.id, { antigravityConversationId: null });
  check('no pin, no badge', badge(pinned), null);
  sessions.update(pinned.id, { antigravityConversationId: C });

  console.log('\nthe operator answering in the terminal');
  runner.pasteInput(pinned.id, 'y');
  check('a key clears it, like the other CLIs', badge(pinned), null);
  check('and it stays clear for that step', badge(pinned), null);
  step(9, TOOL, 3); step(10, TOOL, 9);
  check('the next permission prompt shows', badge(pinned), 'permission');

  console.log('\npanes that never show it');
  shared(0, USER, 3); shared(1, TOOL, 9);
  fs.mkdirSync(path.join(CONV, '..', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(CONV, '..', 'cache', 'last_conversations.json'),
    JSON.stringify({ [path.join(config.WORKSPACES_DIR, 'shared')]: S }));
  await pause(200);
  check('unpinned panes sharing a folder: no badge (left)', badge(left), null);
  check('unpinned panes sharing a folder: no badge (right)', badge(right), null);
  check('a stopped pane pinned to a WAITING conversation has no entry', runner.agentInfo().has(asleep.id), false);

  console.log('\nstopping the pane');
  runner.stop(pinned.id);
  for (const end = Date.now() + 5000; runner.agentInfo().has(pinned.id) && Date.now() < end;) await pause(50);
  check('stopped', runner.isRunning(pinned.id), false);
  check('the badge goes with it', badge(pinned), null);
} finally {
  await runner.stopAll(2000);
  await pause(100);
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
