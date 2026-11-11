// An agent opened with no prompt is not working while its CLI starts up.
// "working" means the screen changed in the last BUSY_SECS, and a Claude
// started on its own paints its banner, status line and notices in bursts that
// can sit more than BUSY_SECS apart: each burst flipped a freshly spawned agent
// back to working, so its sidebar frame alternated with a bare logo. Screen
// changes count once the launch has had input, or was given a prompt.
// The CLI is stubbed by a script that prints in timed bursts.
// Run with: node test/startup-activity.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-activity-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(TMP, 'input-required');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'no-claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
process.env.AM_BASHRC = '/nonexistent';
fs.mkdirSync(process.env.HOME);

// Banner at once, a status line a second later, a notice well past BUSY_SECS.
const STUB = path.join(TMP, 'stub.sh');
fs.writeFileSync(STUB, "printf 'banner\\n'; sleep 1; printf 'status\\n'; sleep 6.5; printf 'notice\\n'; exec sleep 120\n");

const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
config.ensureDirs(); sessions.init();
const cli = config.cliById('opencode');
cli.run = cli.cont = cli.resume = () => `sh ${STUB}`;
cli.withPrompt = () => `sh ${STUB}`;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}\n         want ${want}`}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (s) => runner.deriveState(sessions.get(s.id), runner.agentInfo().get(s.id));

const bare = sessions.create({ name: 'bare', cli: 'opencode', path: 'bare' });
const asked = sessions.create({ name: 'asked', cli: 'opencode', path: 'asked' });
sessions.update(asked.id, { pendingPrompt: 'do the thing' });
for (const s of [bare, asked]) fs.mkdirSync(config.workspacePath(s.path), { recursive: true });

try {
  const t0 = Date.now();
  runner.ensureRunning(sessions.get(bare.id));
  runner.ensureRunning(sessions.get(asked.id));
  const at = (ms) => pause(Math.max(0, t0 + ms - Date.now()));

  await at(500);
  check('a new pane reads as working while it launches', state(bare), 'working');
  await at(6800);
  check('quiet past BUSY_SECS: waiting', state(bare), 'waiting');
  await at(8600);
  const screen = runner.peek(bare.id) || '';
  check('the stub printed its late notice', screen.includes('notice'), true);
  check('a startup notice on a pane nobody has asked anything is not work', state(bare), 'waiting');
  check('the same notice on a pane launched with a prompt is', state(asked), 'working');

  runner.pasteInput(bare.id, 'hi');
  await pause(700);
  check('once it has had input, its screen changes count again', state(bare), 'working');
} finally {
  runner.stop(bare.id);
  runner.stop(asked.id);
  await pause(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nstartup activity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
