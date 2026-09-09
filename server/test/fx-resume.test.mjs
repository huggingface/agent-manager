// Which conversation an fx pane comes back on after a restart.
//
// `fx --continue` resumes the latest session for the WORKSPACE, so two fx panes
// sharing a folder would both land on the same conversation — the same
// cross-talk hazard codex `resume --last` and opencode `--continue` have. The
// launch line resumes the PINNED id instead, and existence-checks it in the
// shell so a purged session starts fresh rather than killing the pane (fx exits
// 1 with "saved session not found."). Run with: node test/fx-resume.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-resume-'));
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

const ID = '1787565046083-1787565046083966744-936b6f5838945f4a';
const OTHER = '1787565136860-1787565136860751740-ce53ed402471b87e';

console.log('the catalog entry');
const fx = cliById('fx');
check('fx is registered', !!fx, true);
check('binary is fx', fx.bin, 'fx');
check('a fresh launch is bare fx', fx.run, 'fx');
check('resume is by exact id', fx.resume(ID), `fx --resume ${ID}`);
// `fx ask` runs ONE request and exits, which would close the pane instead of
// opening it, so fx deliberately has no seeded-launch form.
check('no seeded-prompt launch form', fx.withPrompt, undefined);

console.log('\na restart resumes the pinned conversation, not the workspace\'s newest');
const s = sessions.create({ name: 'fx', cli: 'fx', path: 'proj-a' });
sessions.update(s.id, { everStarted: true, fxSessionId: ID });
const cmd = runner.commandFor(sessions.get(s.id));
has('resumes by id', cmd, `exec fx --resume ${ID}`);
check('does not fall back to --continue', cmd.includes('--continue'), false);

console.log('\nthe pin is existence-checked, so a purged session starts fresh');
// fx exits 1 with "saved session not found." on a missing id, which would end
// the pane on sight. The shell decides at launch time, not when we build the line.
has('tests the event log', cmd, `[ -f "$HOME/.fx/sessions/${ID}/events.jsonl" ]`);
has('falls back to a fresh launch', cmd, 'else exec fx; fi');

console.log('\nan id that is not an fx id never reaches the shell');
for (const bad of [`${ID}; rm -rf /`, '$(whoami)', '../../etc/passwd', 'a b', '`id`', "'"]) {
  sessions.update(s.id, { fxSessionId: bad });
  check(`rejected: ${JSON.stringify(bad)}`, runner.commandFor(sessions.get(s.id)).includes('--resume'), false);
}

console.log('\nthe pin wins over the folder, so siblings cannot cross-talk');
const other = sessions.create({ name: 'fx-2', cli: 'fx', path: 'proj-a' });
sessions.update(s.id, { fxSessionId: ID });
sessions.update(other.id, { everStarted: true, fxSessionId: OTHER });
has('this session resumes its own', runner.commandFor(sessions.get(s.id)), `--resume ${ID}`);
has('the sibling resumes its own', runner.commandFor(sessions.get(other.id)), `--resume ${OTHER}`);

console.log('\nunpinned panes sharing a folder start fresh rather than collide');
// Two live fx sessions in one folder and neither pinned yet: --continue would
// hand BOTH the same conversation.
sessions.update(s.id, { fxSessionId: null });
sessions.update(other.id, { fxSessionId: null });
const shared = runner.commandFor(sessions.get(s.id));
check('no --continue in a shared folder', shared.includes('--continue'), false);
check('a fresh launch instead', shared, 'exec fx');

console.log('\nalone in its folder, an unpinned pane may continue');
const solo = sessions.create({ name: 'fx-3', cli: 'fx', path: 'proj-b' });
sessions.update(solo.id, { everStarted: true });
const soloCmd = runner.commandFor(sessions.get(solo.id));
has('continues its own workspace', soloCmd, 'fx --continue');
has('with a fresh fallback', soloCmd, '|| exec fx');

console.log('\na first launch has nothing to resume');
const fresh = sessions.create({ name: 'fx-4', cli: 'fx', path: 'proj-c' });
sessions.update(fresh.id, { fxSessionId: ID }); // pinned but never started
check('starts fresh', runner.commandFor(sessions.get(fresh.id)), 'exec fx');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
