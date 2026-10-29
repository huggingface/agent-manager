// A revived agent is told its work was interrupted, and carries on.
//
// Reviving a session resumes its conversation, not its turn: whatever the
// agent was doing — a tool call, the background listener it keeps for peer
// messages — died with the old process, and the resumed CLI just sat at its
// prompt until someone noticed. So after a restart, each revived AGENT gets
// one message, through the same delivery path as the Overview reply box, once
// its CLI can take input.
//
// Driven through real servers: the first creates the sessions, then a
// runstate snapshot says they were running when it "went down", and a second
// boot revives them. The agents are the fake TUI from submit-confirm (it
// records every prompt it receives), the non-agent is a plain shell.
//
// Run with:  node test/revive-continue.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-continue-'));
const DATA_DIR = path.join(root, 'data'); fs.mkdirSync(DATA_DIR, { recursive: true });
// Before the import: config.js reads it once, and must never see the real one.
process.env.DATA_DIR = DATA_DIR;
const { CONTINUE_TEXT } = await import('../src/runstate.js');
const PUBLIC_DIR = path.join(root, 'public'); fs.mkdirSync(PUBLIC_DIR);
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');
const FAKE_DIR = path.join(root, 'fake'); fs.mkdirSync(FAKE_DIR);
const home = path.join(root, 'home'); fs.mkdirSync(home);
const submitted = () => { try { return fs.readFileSync(path.join(FAKE_DIR, 'submitted'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  return false;
};
// An allowlist, not process.env: inside a Space the shell exports live agent
// state paths that a child must never inherit.
const inherited = Object.fromEntries(['PATH', 'LANG', 'TZ'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

async function boot() {
  const PORT = String(await freePort());
  const proc = spawn('node', ['src/index.js'], {
    cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, HOME: home, PORT, DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
      AM_ALLOW_MISSING_ORIGIN: '1',
      AM_TEST_SUBMIT_CMD: `env FAKE_DIR=${FAKE_DIR} ${process.execPath} ${path.join(HERE, 'fixtures', 'fake-submit-tui.mjs')}` },
  });
  const srv = { proc, api: `http://127.0.0.1:${PORT}`, logs: '' };
  proc.stdout.on('data', (d) => { srv.logs += d; });
  proc.stderr.on('data', (d) => { srv.logs += d; });
  if (!await until(() => fetch(`${srv.api}/api/health`).then((r) => r.ok), 60_000)) throw new Error(`server did not start:\n${srv.logs.slice(-1200)}`);
  return srv;
}
async function shutdown(srv) {
  if (srv.proc.exitCode !== null) return;
  srv.proc.kill('SIGTERM');
  await Promise.race([new Promise((r) => srv.proc.once('exit', r)), sleep(10_000)]);
  if (srv.proc.exitCode === null) srv.proc.kill('SIGKILL');
}
const post = (srv, p, body) => fetch(srv.api + p, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-am-request': '1' },
  body: body === undefined ? undefined : JSON.stringify(body) });

// What the previous boot left behind: these were running, the stopped one was not.
function wentDown(ids, { stopped = [] } = {}) {
  const file = path.join(DATA_DIR, 'sessions.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of all) Object.assign(s, { everStarted: true, lastInputAt: Date.now() - 60_000 });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  const sessions = Object.fromEntries(ids.map((id) => [id, { running: true, work: false }]));
  for (const id of stopped) sessions[id] = { running: false };
  fs.writeFileSync(path.join(DATA_DIR, 'runstate.json'), JSON.stringify({ at: new Date().toISOString(), sessions }));
  fs.rmSync(path.join(FAKE_DIR, 'submitted'), { force: true });
}
const told = (logs) => (logs.match(/told to continue/g) || []).length;

let srv;
try {
  srv = await boot();
  await post(srv, '/api/welcome/seen');
  const make = async (cli, name) => (await (await post(srv, '/api/sessions', { cli, name, path: name })).json()).id;
  const agentA = await make('test-submit', 'agent-a');
  const agentB = await make('test-submit', 'agent-b');
  const idle = await make('test-submit', 'agent-stopped');
  const shell = await make('shell', 'a-shell');
  await shutdown(srv);

  console.log('\n# a restart with two agents and a shell running');
  wentDown([agentA, agentB, shell], { stopped: [idle] });
  srv = await boot();
  // Revival starts 8 s after boot, 4 s apart; then each CLI must go quiet.
  const got = await until(() => submitted().length >= 2, 60_000);
  await sleep(6000); // long enough for a duplicate to show up
  const lines = submitted();
  check('each revived agent receives the continue message', () => {
    assert.ok(got, `only ${lines.length} delivered\n${srv.logs.slice(-1500)}`);
    assert.equal(lines.length, 2, lines.join('\n'));
    for (const l of lines) assert.equal(l, CONTINUE_TEXT);
  });
  check('once per agent, not repeated', () => assert.equal(told(srv.logs), 2, srv.logs.slice(-1500)));
  const state = await (await fetch(`${srv.api}/api/sessions`)).json();
  const running = (id) => (Array.isArray(state) ? state : state.sessions || []).find((s) => s.id === id)?.running;
  check('the stopped one was not started', () => assert.notEqual(running(idle), true));
  check('the shell was revived but is not an agent, so nothing was typed into it', () => {
    assert.match(srv.logs, /\[revive\] a-shell \(shell\)/);
    assert.ok(!/a-shell: told to continue/.test(srv.logs));
  });
  await shutdown(srv);

  console.log('\n# the same restart with the continue message switched off');
  fs.writeFileSync(path.join(DATA_DIR, 'am-config.json'), JSON.stringify({ revive: { enabled: true, days: 3, continue: false } }));
  wentDown([agentA, agentB]);
  srv = await boot();
  const revived = await until(() => (srv.logs.match(/\[revive\] agent-[ab] /g) || []).length >= 2, 40_000);
  await sleep(8000);
  check('the agents still come back', () => assert.ok(revived, srv.logs.slice(-1500)));
  check('but nothing is sent to them', () => {
    assert.deepEqual(submitted(), []);
    assert.equal(told(srv.logs), 0);
  });
  const cfg = await (await fetch(`${srv.api}/api/config`)).json();
  check('GET /api/config reports revive.continue = false', () => assert.equal(cfg.revive?.continue, false));
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.message}\n${srv?.logs.slice(-1500) || ''}`);
} finally {
  if (srv) await shutdown(srv);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
