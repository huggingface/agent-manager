// Which conversation an Antigravity pane is pinned to.
//
// A running agy holds `presence/<uuid>.lock` open for the conversation it is
// on (from its first prompt, and it moves to the new id on `/new`), so the
// pane's own process names its conversation exactly: another agy writing a
// conversation in the same folder (the operator's shell, a tool of another
// agent) never moves the pin. Only when no agy process can be read does the
// folder fallback apply, and then never over an existing pin; a shared folder
// is remembered so the sibling's conversations are never adopted later.
// `agy` is a shell script here that holds the lock named in its folder's
// `.agy-conversation` (`.agy-conversation.<pane id>` first), or, with
// `.agy-hidden`, is a plain `sleep` nothing can be read from. Run with: node test/antigravity-capture.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-capture-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(TMP, 'input-required');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'no-claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
fs.mkdirSync(process.env.HOME);

const FAKE = path.join(TMP, 'bin', 'agy');
fs.mkdirSync(path.dirname(FAKE));
fs.writeFileSync(FAKE, `#!/bin/sh
[ -e .agy-hidden ] && exec sleep 120
P="$HOME/.gemini/antigravity-cli/presence"
mkdir -p "$P"
ctl=".agy-conversation.$AM_ID"; [ -e "$ctl" ] || ctl=.agy-conversation
cur=
while :; do
  id=$(cat "$ctl" 2>/dev/null)
  if [ "$id" != "$cur" ]; then
    if [ -n "$id" ]; then exec 3<>"$P/$id.lock"; else exec 3<&-; fi
    cur=$id
  fi
  sleep 0.05
done
`, { mode: 0o755 });

const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const agy = await import('../src/antigravity.js');
config.ensureDirs(); sessions.init();
const cli = config.cliById('antigravity');
cli.run = cli.cont = () => FAKE;
cli.resume = () => FAKE;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}\n         want ${want}`}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await pause(50); return fn(); };

// A conversation database whose first prompt names its folder, as agy writes it.
const CONV = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'conversations');
fs.mkdirSync(CONV, { recursive: true });
function varint(n) { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); }
function encode(tree) {
  return Buffer.concat(tree.flatMap(([f, v]) => {
    if (typeof v === 'number') return [varint(f * 8), varint(v)];
    const body = typeof v === 'string' ? Buffer.from(v) : encode(v);
    return [varint(f * 8 + 2), varint(body.length), body];
  }));
}
function conversation(id, folder) {
  const db = new DatabaseSync(path.join(CONV, `${id}.db`));
  db.exec('CREATE TABLE IF NOT EXISTS steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, step_payload blob)');
  db.prepare('insert or replace into steps values (0, 14, 3, ?)').run(encode([[1, 14], [4, 3],
    [5, [[1, [[1, Math.floor(Date.now() / 1000)], [2, 0]]]]],
    [19, [[2, 'hello'], [12, [[12, `file://${path.join(config.WORKSPACES_DIR, folder)}`]]]]]]));
  db.close();
}
const id = (n) => `7a7a7a7a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const folder = (name, { conv = '', hidden = false } = {}) => {
  const d = path.join(config.WORKSPACES_DIR, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '.agy-conversation'), conv);
  if (hidden) fs.writeFileSync(path.join(d, '.agy-hidden'), '');
  return (next) => fs.writeFileSync(path.join(d, '.agy-conversation'), next);
};

const procs = [];
try {
  console.log('the process names its conversation');
  {
    const steer = folder('unit');
    const p = spawn(FAKE, [], { cwd: path.join(config.WORKSPACES_DIR, 'unit'), stdio: 'ignore' });
    procs.push(p);
    check('agy running, no conversation yet', await until(() => agy.agyConversationForPid(p.pid)?.id === null) && 'none', 'none');
    steer(id(1));
    check('after its first prompt, the lock names it', await until(() => agy.agyConversationForPid(p.pid)?.id === id(1)) && id(1), id(1));
    steer(id(2));
    check('/new moves it to the new conversation', await until(() => agy.agyConversationForPid(p.pid)?.id === id(2)) && id(2), id(2));
    const sh = spawn('bash', ['-c', `${FAKE}; :`], { cwd: path.join(config.WORKSPACES_DIR, 'unit'), stdio: 'ignore' });
    procs.push(sh);
    check('through the shell of a `-c || exec` launch', await until(() => agy.agyConversationForPid(sh.pid)?.id === id(2)) && 'found', 'found');
    check('a process that is not agy names nothing', agy.agyConversationForPid(process.pid), null);
    check('nor does a pid that is gone', agy.agyConversationForPid(2 ** 22 + 7), null);
  }

  console.log('\nlive panes');
  folder('exact', { conv: id(10) });
  conversation(id(10), 'exact');
  const exact = sessions.create({ name: 'exact', cli: 'antigravity', path: 'exact' });
  folder('nolock');
  const nolock = sessions.create({ name: 'nolock', cli: 'antigravity', path: 'nolock' });
  folder('kept', { hidden: true });
  conversation(id(30), 'kept');
  const kept = sessions.create({ name: 'kept', cli: 'antigravity', path: 'kept' });
  sessions.update(kept.id, { antigravityConversationId: id(30) });
  folder('fallback', { hidden: true });
  const fallback = sessions.create({ name: 'fallback', cli: 'antigravity', path: 'fallback' });
  folder('shared', { hidden: true });
  const shared1 = sessions.create({ name: 'shared-1', cli: 'antigravity', path: 'shared' });
  const shared2 = sessions.create({ name: 'shared-2', cli: 'antigravity', path: 'shared' });
  // Two panes in one folder, each on its own conversation.
  folder('twins');
  conversation(id(60), 'twins'); conversation(id(61), 'twins');
  const twin1 = sessions.create({ name: 'twin-1', cli: 'antigravity', path: 'twins' });
  const twin2 = sessions.create({ name: 'twin-2', cli: 'antigravity', path: 'twins' });
  fs.writeFileSync(path.join(config.WORKSPACES_DIR, 'twins', `.agy-conversation.${twin1.id}`), id(60));
  fs.writeFileSync(path.join(config.WORKSPACES_DIR, 'twins', `.agy-conversation.${twin2.id}`), id(61));

  for (const s of [exact, nolock, kept, fallback, shared1, shared2, twin1, twin2]) runner.ensureRunning(sessions.get(s.id));
  await pause(800);
  // Another agy, outside these panes, writes conversations in their folders
  // after they launched: newer than anything the panes wrote.
  conversation(id(11), 'exact');
  conversation(id(20), 'nolock');
  conversation(id(31), 'kept');
  conversation(id(40), 'fallback');
  conversation(id(50), 'shared');
  await until(() => sessions.get(fallback.id).antigravityConversationId, 6000);
  await pause(300);

  const pin = (s) => sessions.get(s.id).antigravityConversationId || null;
  check('a pane is pinned to the conversation its agy holds', pin(exact), id(10));
  check('not to a newer one another process wrote in its folder', pin(exact) !== id(11), true);
  check('an agy that holds no conversation yet adopts nothing', pin(nolock), null);
  check('with no agy to read, an existing pin is kept', pin(kept), id(30));
  check('with no agy to read and no pin, the folder fallback still adopts', pin(fallback), id(40));
  check('panes sharing a folder adopt nothing from it', pin(shared1) || pin(shared2), null);
  check('and remember that they shared it', typeof sessions.get(shared1.id).antigravityCaptureSince, 'number');
  check('two panes in one folder each get their own conversation', `${pin(twin1)} ${pin(twin2)}`, `${id(60)} ${id(61)}`);

  console.log('\nafter the sibling leaves');
  runner.stop(shared2.id);
  await until(() => !runner.agentInfo().has(shared2.id), 5000);
  sessions.remove(shared2.id);
  sessions.update(shared1.id, { everStarted: true });
  check('the survivor still starts fresh, not `-c`', runner.commandFor(sessions.get(shared1.id)), `exec ${FAKE}`);
  check('until it holds a pin', (sessions.update(shared1.id, { antigravityConversationId: id(70), antigravityCaptureSince: undefined }),
    runner.commandFor(sessions.get(shared1.id)).includes(`exec ${FAKE}; fi`)), true);
} finally {
  for (const p of procs) try { p.kill('SIGKILL'); } catch {}
  await runner.stopAll(2000);
  await pause(100);
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
