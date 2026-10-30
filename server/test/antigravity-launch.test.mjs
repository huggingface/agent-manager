// How an Antigravity CLI (`agy`) pane is launched and brought back.
//
// agy ignores GEMINI_API_KEY unless its provider is "gemini" and otherwise asks
// for a Google sign-in, so the launch line passes that setting, but only while
// the key is set when the shell runs it. `agy -c` resumes the newest
// conversation in the cwd, so like codex `resume --last` it must not run in a
// folder another Antigravity pane shares, nor, like fx, in one it ever shared
// until it holds a pin: the sibling's conversation outlives the sibling. Once
// the runner has pinned the pane's conversation, a restart resumes it by id
// instead, existence-checked.
// Run with: node test/antigravity-launch.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });

process.env.DATA_DIR = DATA;
process.env.HOME = path.join(TMP, 'home');
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(TMP, 'input-required');

const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const { cliById } = await import('../src/config.js');
sessions.init();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}\n         want ${want}`}`);
};
const has = (name, hay, needle) => check(name, String(hay).includes(needle), true);

// What argv agy would get from a launch line, with `agy` stubbed to print it.
const bin = path.join(TMP, 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n', { mode: 0o755 });
const argvOf = (line, key) => {
  const env = { PATH: `${bin}:${process.env.PATH}` };
  if (key) env.GEMINI_API_KEY = key;
  return execFileSync('bash', ['-c', line], { env, encoding: 'utf8' });
};

console.log('the catalog entry');
const agy = cliById('antigravity');
check('antigravity is registered', !!agy, true);
check('binary is agy', agy.bin, 'agy');
check('not updated through npm', !!agy.noUpdate && !agy.npm, true);

console.log('\nthe key decides the provider, at launch time');
check('with a key, the provider is gemini', argvOf(agy.run(), 'k'), '[--settings][{"modelProvider":"gemini"}]');
check('without one, agy is left to its own sign-in', argvOf(agy.run(), ''), '');
check('a seeded prompt stays one argument', argvOf(agy.withPrompt("'say hi; now'"), 'k'),
  '[--settings][{"modelProvider":"gemini"}][-i][say hi; now]');
check('continue keeps the provider', argvOf(agy.cont(), 'k'), '[--settings][{"modelProvider":"gemini"}][-c]');

console.log('\nfirst launch and restart');
const s = sessions.create({ name: 'agy', cli: 'antigravity', path: 'proj-a' });
sessions.update(s.id, { pendingPrompt: 'hello there' });
has('a queued prompt rides the first launch', runner.commandFor(sessions.get(s.id)), "-i 'hello there'");
sessions.update(s.id, { everStarted: true, pendingPrompt: null });
const alone = runner.commandFor(sessions.get(s.id));
has('alone in its folder, a restart continues', alone, `${agy.cont()} || exec ${agy.run()}`);

console.log('\npanes sharing a folder start fresh rather than collide');
const other = sessions.create({ name: 'agy-2', cli: 'antigravity', path: 'proj-a' });
const shared = runner.commandFor(sessions.get(s.id));
check('no -c in a shared folder', / -c( |$)/.test(shared), false);
check('a fresh launch instead', shared, `exec ${agy.run()}`);
check('the pane remembers it shared the folder', typeof sessions.get(s.id).antigravityCaptureSince, 'number');
sessions.update(other.id, { path: 'proj-b' });
check('once the sibling moves away, it still starts fresh', runner.commandFor(sessions.get(s.id)), `exec ${agy.run()}`);
const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')).find((x) => x.id === s.id);
check('across a server restart too: the mark is saved', typeof saved?.antigravityCaptureSince, 'number');
const lone = sessions.create({ name: 'agy-lone', cli: 'antigravity', path: 'proj-c' });
sessions.update(lone.id, { everStarted: true });
has('a pane that never shared its folder still continues', runner.commandFor(sessions.get(lone.id)), `${agy.cont()} || exec ${agy.run()}`);

console.log('\na pinned pane resumes its own conversation by id');
const ID = '79cd3d9b-b387-44da-91c0-2df98a2ae37e';
check('resume keeps the provider', argvOf(agy.resume(ID), 'k'), `[--settings][{"modelProvider":"gemini"}][--conversation][${ID}]`);
sessions.update(other.id, { path: 'proj-a' });
sessions.update(s.id, { antigravityConversationId: ID });
const pinned = runner.commandFor(sessions.get(s.id));
has('resumes by id, even in a shared folder', pinned, `exec ${agy.resume(ID)}`);
const conv = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'conversations');
const run = (line) => argvOf(line.replaceAll('$HOME', process.env.HOME), 'k');
check('a missing conversation starts fresh', run(pinned), '[--settings][{"modelProvider":"gemini"}]');
fs.mkdirSync(conv, { recursive: true });
fs.writeFileSync(path.join(conv, `${ID}.db`), '');
check('an existing one is resumed', run(pinned), `[--settings][{"modelProvider":"gemini"}][--conversation][${ID}]`);
sessions.update(s.id, { antigravityConversationId: 'x; touch /tmp/owned' });
check('only a uuid reaches the launch line', runner.commandFor(sessions.get(s.id)).includes('owned'), false);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
