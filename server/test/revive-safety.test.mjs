// The continue message a revived agent gets must never land anywhere but an
// empty prompt of the very process it is about.
//
// Each case is one way the first version of it went wrong (review of #228),
// driven through real runner PTYs with small fake CLIs:
//   1. a quiet startup dialog read as "ready" and got the text and an Enter;
//   2. OpenCode's first stable frame comes before its input handler, and the
//      revived pane skipped the echo check that catches that;
//   3. a pane stopped, restarted or archived while its message waited still
//      got it — or its replacement did, or the stagger started it again;
//   4. a privacy lock landing while the message waited did not drop it.
// The screen rule itself is checked on panes captured from the real CLIs.
//
// Run with: node test/revive-safety.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-safety-'));
// Before the imports: config.js reads these once, and must never see the real
// ones. Inside a Space the CLIs' state dirs are exported too, and revive's
// trace digest would read the live transcripts through them.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|OPENCODE_\w+|HERMES_HOME|OPENCLAW_HOME|FX_HOME|XDG_\w+|AM_\w+)$/.test(k)) delete process.env[k];
}
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'), AM_LOCAL: path.join(root, 'local'),
  AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  AM_INPUT_READY_QUIET_MS: '600',
});
for (const d of [process.env.DATA_DIR, process.env.HOME, process.env.AM_LOCAL]) fs.mkdirSync(d, { recursive: true });
const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const runstate = await import('../src/runstate.js');
const { CONTINUE_TEXT, tellRevived } = runstate;

let failed = 0;
const say = console.log.bind(console);  // case 1b listens to console.log
const check = async (what, fn) => {
  try { await fn(); say(`  ok  ${what}`); } catch (e) {
    failed++; say(`  FAIL ${what}\n       ${String(e.message).split('\n')[0]}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

// One fake CLI, several moods. Every keystroke it receives is logged with the
// pane's AM_ID and AM_RUN_ID, and whether the CLI was taking input yet.
const received = path.join(root, 'received.jsonl');
const fixture = path.join(root, 'fake-cli.mjs');
fs.writeFileSync(fixture, `
import fs from 'node:fs';
const mode = process.argv[2];
process.stdin.setRawMode(true);
const acceptAt = Date.now() + (mode === 'late' ? 3000 : 0);
if (mode === 'dialog-signal') process.stdout.write('\\x1b]9;Gemini CLI needs your attention: Answer requested by agent\\x07Login confirmation: press Enter to continue\\r\\n');
else if (mode === 'dialog') process.stdout.write('Trust this folder?\\r\\n  1. Yes\\r\\n  2. No\\r\\n');
else if (mode === 'late' || mode === 'oc') process.stdout.write('\\r\\n             \\u2503  \\r\\n             \\u2503\\r\\n             \\u2579\\u2580\\u2580\\u2580\\u2580\\u2580\\x1b[2A\\r\\x1b[16C');
else process.stdout.write('Agent composer ready\\r\\n> ');
process.stdin.on('data', (d) => {
  const accepted = Date.now() >= acceptAt;
  fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({ id: process.env.AM_ID, run: process.env.AM_RUN_ID, accepted, data: d.toString() }) + '\\n');
  // Echo what it takes, as a composer does; ignore it before it is ready.
  if (accepted && mode === 'late') process.stdout.write(d.toString().replace(/\\r/g, ''));
});
setInterval(() => {}, 1000);
`);
const input = () => { try { return fs.readFileSync(received, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const typed = (id) => input().filter((r) => r.id === id).map((r) => r.data).join('');
// Hermes stands in for "an agent CLI with a prompt detector": the fake draws a
// `> ` composer, which is the generic rule's shape.
const agent = config.cliById('hermes');
const opencode = config.cliById('opencode');
const as = (cli, mode) => { cli.run = () => `${process.execPath} ${fixture} ${mode}`; cli.cont = null; };
const make = (name, cli = 'hermes') => {
  const s = sessions.create({ name, cli, path: name });
  return sessions.update(s.id, { everStarted: true, lastInputAt: Date.now() });
};
// What index.js hands revive, minus the privacy-lock scope: the pinned send.
const send = async (s, text, { runId }) => runner.sendInput(s.id, text, { runId });

try {
  console.log('\n# 0. the screen rule, on panes captured from the real CLIs');
  const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/input-lines.json'), 'utf8'));
  const text = (snap) => snap.visibleLines.map((l) => l.text).join('\n');
  await check('an empty composer is ready: Claude Code, Codex, OpenCode, Hermes, Antigravity', () => {
    for (const cli of ['claude', 'codex', 'opencode', 'hermes', 'antigravity']) {
      assert.equal(runner.emptyPrompt(SCREENS[cli].empty, text(SCREENS[cli].empty), cli), true, cli);
    }
  });
  await check('one holding typed text never is', () => {
    for (const cli of Object.keys(SCREENS)) {
      assert.equal(runner.emptyPrompt(SCREENS[cli].typed, text(SCREENS[cli].typed), cli), false, cli);
    }
  });
  await check('nor a startup dialog: Gemini\'s OAuth code prompt, OpenClaw\'s [Y/n], fx\'s sign-in menu', () => {
    for (const cli of ['gemini', 'openclaw', 'fx']) {
      assert.equal(runner.emptyPrompt(SCREENS[cli].empty, text(SCREENS[cli].empty), cli), false, cli);
    }
  });
  // Antigravity (agy 1.4.10) beyond the empty/typed pair: its `>` composer
  // between two rules stays on screen empty mid-turn and under its dialogs.
  const AGY = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/agy-screens.json'), 'utf8'));
  await check('antigravity: the composer after a finished turn is ready', () => {
    assert.equal(runner.emptyPrompt(AGY.after_turn, text(AGY.after_turn), 'antigravity'), true);
  });
  await check('antigravity: its permission dialog ("Requesting permission for: … Run this command?") is not', () => {
    assert.match(text(AGY.permission), /Requesting permission for:[\s\S]*Run this command\?/);
    assert.equal(runner.emptyPrompt(AGY.permission, text(AGY.permission), 'antigravity'), false);
  });
  await check('antigravity: nor its empty composer mid-turn ("esc to cancel" where "? for shortcuts" was)', () => {
    assert.match(text(AGY.working), /esc to cancel/);
    assert.equal(runner.emptyPrompt(AGY.working, text(AGY.working), 'antigravity'), false);
  });
  await check('antigravity: nor its startup dialogs: color scheme, terms, folder trust', () => {
    for (const k of ['onboarding', 'terms', 'trust']) {
      assert.equal(runner.emptyPrompt(AGY[k], text(AGY[k]), 'antigravity'), false, k);
    }
  });
  await check('nor a shell prompt, which is not an agent\'s composer', () => {
    assert.equal(runner.emptyPrompt(SCREENS.shell.empty, text(SCREENS.shell.empty), 'shell'), false);
  });

  console.log('\n# 1. a quiet dialog is not a prompt');
  // OpenCode's composer on screen, empty — and its plugin reporting a
  // permission dialog open (the marker file its plugin writes).
  as(opencode, 'oc');
  const signalled = make('dialog-signal', 'opencode');
  runner.ensureRunning(signalled);
  fs.mkdirSync(process.env.AM_INPUT_REQUIRED_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.AM_INPUT_REQUIRED_DIR, `${signalled.id}.json`), JSON.stringify({
    amId: signalled.id, runId: runner.runIdOf(signalled.id), cli: 'opencode', kind: 'permission', source: 'opencode-event', at: Date.now() }));
  await until(() => runner.agentInfo().get(signalled.id)?.inputRequired, 3000);
  await check('the CLI reports a dialog open, and nothing is typed into it — composer or not', async () => {
    assert.equal(runner.agentInfo().get(signalled.id).inputRequired?.kind, 'permission');
    assert.equal(await tellRevived(signalled.id, send, { readyMs: 2500 }), false);
    assert.equal(typed(signalled.id), '');
    assert.ok(runner.agentInfo().get(signalled.id).inputRequired, 'the dialog signal was cleared');
  });
  as(agent, 'dialog');
  const menu = make('dialog-quiet');
  runner.ensureRunning(menu);
  await check('a menu with no signal at all, quiet for longer than "ready" used to need, gets nothing', async () => {
    assert.equal(await tellRevived(menu.id, send, { readyMs: 2500 }), false);
    assert.equal(typed(menu.id), '');
  });
  as(agent, 'composer');
  const ready = make('composer');
  runner.ensureRunning(ready);
  await check('an empty prompt gets the message, once, and Enter', async () => {
    assert.equal(await tellRevived(ready.id, send, { readyMs: 5000 }), true);
    await sleep(500);
    assert.equal(typed(ready.id), `${CONTINUE_TEXT}\r`);
  });
  await runner.stopAll();

  console.log('\n# 1b. a CLI with no prompt detector is skipped at once, and says so');
  const logged = [];
  const log0 = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  try {
    for (const cli of ['gemini', 'openclaw', 'fx']) {
      config.cliById(cli).run = () => `${process.execPath} ${fixture} composer`;
      config.cliById(cli).cont = null;
      const s = make(`nodetect-${cli}`, cli);
      runner.ensureRunning(s);
      await sleep(1000);  // a `> ` prompt on screen, quiet: it would pass the screen rule
      const t0 = Date.now();
      await check(`${cli}: not sent, without waiting out the timeout`, async () => {
        assert.equal(await tellRevived(s.id, send, { readyMs: 60_000 }), false);
        assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
        assert.equal(typed(s.id), '');
        assert.ok(logged.includes(`[revive] nodetect-${cli}: no prompt detector for ${cli}, not sent`), logged.join(' | '));
      });
    }
  } finally { console.log = log0; }
  await check('the detector list is exactly the CLIs checked on real captured screens', () => {
    assert.deepEqual(config.CLIS.filter((c) => c.promptDetector && !c.id.startsWith('test-')).map((c) => c.id).sort(),
      ['antigravity', 'claude', 'codex', 'hermes', 'opencode']);
  });
  await runner.stopAll();

  console.log('\n# 2. OpenCode: a stable first frame before its input handler works');
  as(opencode, 'late');
  const oc = make('opencode-late', 'opencode');
  runner.ensureRunning(oc);
  await check('the message is only counted once the CLI echoed it — whoever started the pane', async () => {
    assert.equal(await tellRevived(oc.id, send, { readyMs: 8000 }), true);
    await sleep(500);
    const got = input().filter((r) => r.id === oc.id);
    assert.ok(got.some((r) => !r.accepted), 'the fixture never discarded an early attempt — the case was not exercised');
    const accepted = got.filter((r) => r.accepted).map((r) => r.data).join('');
    assert.ok(accepted.includes(CONTINUE_TEXT.slice(-40)), 'the text never reached the ready CLI');
    assert.ok(accepted.endsWith('\r'), 'no Enter after the acknowledged text');
  });
  await runner.stopAll();

  console.log('\n# 3. bound to the process it is about');
  as(agent, 'dialog');  // stays not-ready, so the message is still waiting
  const replaced = make('replaced');
  runner.ensureRunning(replaced);
  const firstRun = runner.runIdOf(replaced.id);
  const waiting = tellRevived(replaced.id, send, { runId: firstRun, readyMs: 8000 });
  await sleep(300);
  as(agent, 'composer');  // the replacement is immediately ready
  await runner.restart(sessions.get(replaced.id));
  await check('an operator restart ends the wait; the replacement process gets nothing', async () => {
    assert.notEqual(runner.runIdOf(replaced.id), firstRun);
    assert.equal(await waiting, false);
    await sleep(1500);
    assert.equal(typed(replaced.id), '');
  });
  await check('and a send pinned to the old launch is refused at the keystrokes too', async () => {
    await assert.rejects(runner.sendInput(replaced.id, 'late', { runId: firstRun }), /restarted/);
    assert.equal(typed(replaced.id), '');
  });

  as(agent, 'dialog');
  const stopped = make('stopped');
  runner.ensureRunning(stopped);
  const pending = tellRevived(stopped.id, send, { readyMs: 8000 });
  await sleep(300);
  runner.stop(stopped.id);
  await check('a stop ends the wait, and nothing starts it again', async () => {
    assert.equal(await pending, false);
    await sleep(500);
    assert.equal(runner.isRunning(stopped.id), false);
  });

  as(agent, 'dialog');
  const archived = make('archived');
  runner.ensureRunning(archived);
  const shelved = tellRevived(archived.id, send, { readyMs: 8000 });
  await sleep(300);
  sessions.update(archived.id, { archivedAt: new Date().toISOString() });
  await check('archiving it ends the wait', async () => assert.equal(await shelved, false));
  await runner.stopAll();

  console.log('\n# 3b. the stagger leaves alone what the operator touched');
  as(agent, 'composer');
  const first = make('slot-first');
  const opened = make('slot-opened');
  const shelf = make('slot-archived');
  sessions.update(first.id, { lastInputAt: Date.now() + 3000 });  // newest, so slot 0
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'runstate.json'), JSON.stringify({ at: new Date().toISOString(),
    sessions: { [first.id]: { running: true }, [opened.id]: { running: true }, [shelf.id]: { running: true } } }));
  runstate.init();
  const told = [];
  const plan = await runstate.reviveOnBoot({ send: async (s, t, o) => { told.push(s.id); return send(s, t, o); } });
  runner.ensureRunning(sessions.get(opened.id));     // opened before its slot…
  await sleep(300);
  runner.stop(opened.id);                            // …and stopped again on purpose
  sessions.update(shelf.id, { archivedAt: new Date().toISOString() });
  await sleep(plan.length * 4000 + 4000);
  await check('the slot of a session opened and stopped since boot does not start it again', () => {
    assert.equal(runner.isRunning(opened.id), false);
    assert.ok(!told.includes(opened.id));
  });
  await check('nor one archived since boot', () => {
    assert.equal(runner.isRunning(shelf.id), false);
    assert.ok(!told.includes(shelf.id));
  });
  await check('the untouched one is started and told, once', () => assert.deepEqual(told, [first.id]));
  await runner.stopAll();

  console.log('\n# 4. a privacy lock drops a waiting message for good');
  as(agent, 'dialog');
  const locked = make('locked');
  runner.ensureRunning(locked);
  const lock = new AbortController();
  const held = tellRevived(locked.id, send, { signal: lock.signal, readyMs: 8000 });
  await sleep(300);
  lock.abort();  // the lock lands while the CLI is still not ready…
  as(agent, 'composer');
  await check('it is not delivered, even if the pane becomes ready (or the lock clears) later', async () => {
    assert.equal(await held, false);
    assert.equal(typed(locked.id), '');
  });
  as(agent, 'composer');
  const scheduled = make('locked-before-slot');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'runstate.json'), JSON.stringify({ at: new Date().toISOString(),
    sessions: { [scheduled.id]: { running: true } } }));
  runstate.init();
  const scopes = [];
  const sent = [];
  await runstate.reviveOnBoot({
    scope: () => { const c = new AbortController(); const s = { signal: c.signal, released: false, release() { s.released = true; } }; scopes.push({ c, s }); return s; },
    send: async (s, t, o) => { sent.push(s.id); return send(s, t, o); },
  });
  await check('the scope is opened when the message is scheduled, before the pane even starts', () => assert.equal(scopes.length, 1));
  scopes[0].c.abort();
  await sleep(4000);
  await check('so a lock before the slot cancels it, and the scope is released', () => {
    assert.deepEqual(sent, []);
    assert.equal(scopes[0].s.released, true);
  });
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.stack}`);
} finally {
  await runner.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
