// Which conversation an opencode pane comes back on after a restart.
//
// Regression cover for the bug where the launch line used `--continue` — the
// most-recent conversation in the CWD — and so ignored the pin the watcher
// maintains: a restart could land on a conversation the pane had left, or in a
// shared folder on a sibling's. Run with: node test/opencode-resume.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-resume-'));
const XDG = path.join(TMP, 'xdg');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(XDG, 'opencode'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

process.env.XDG_DATA_HOME = XDG;
process.env.DATA_DIR = DATA;

// Only the columns the runner reads. opencode's real table has ~30 more; a
// narrower one still proves the query, and drifts less.
const DB = path.join(XDG, 'opencode', 'opencode.db');
const db = new DatabaseSync(DB);
db.exec('create table session (id text primary key, directory text not null, time_created integer not null)');
const addRow = (id, directory, timeCreated) =>
  db.prepare('insert into session (id, directory, time_created) values (?, ?, ?)').run(id, directory, timeCreated);

const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const traces = await import('../src/traces.js');
sessions.init();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}\n         want ${want}`}`);
};
const has = (name, hay, needle) => check(name, String(hay).includes(needle), true);

const LIVE = 'ses_0325987abffej9UeLKjc55GHK8';
const GONE = 'ses_099999999ffezzzzzzzzzzzzzzz';
addRow(LIVE, '/data/workspaces/proj-a', 1770000000000);

console.log('\nthe db decides whether a pin is still resumable');
check('live row found', traces.opencodeSessionExists(LIVE), true);
check('purged row not found', traces.opencodeSessionExists(GONE), false);
check('no id is not a row', traces.opencodeSessionExists(null), false);

console.log('\na restart resumes the pinned conversation, not the folder\'s newest');
const s = sessions.create({ name: 'oc', cli: 'opencode', path: 'proj-a' });
sessions.update(s.id, { everStarted: true, opencodeSessionId: LIVE });
const cmd = runner.commandFor(sessions.get(s.id));
has('resumes by id', cmd, `exec opencode --session ${LIVE}`);
check('does not fall back to --continue', cmd.includes('--continue'), false);
has('keeps the opencode.json guard', cmd, 'opencode/opencode.json');

console.log('\na pin whose conversation is gone starts fresh, it does not die');
// opencode exits 1 with "Session not found" on a missing id (verified on
// 1.18.9), so emitting the flag here would kill the pane on sight.
sessions.update(s.id, { opencodeSessionId: GONE });
const purged = runner.commandFor(sessions.get(s.id));
check('no --session for a missing row', purged.includes('--session'), false);
has('continues in its own folder instead', purged, '--continue');

console.log('\nan id that is not an opencode id never reaches the shell');
for (const bad of ['ses_a; rm -rf /', 'ses_$(whoami)', '../../etc/passwd', 'ses_a b']) {
  addRow(bad, '/data/workspaces/proj-a', 1770000000000); // even if the db says it exists
  sessions.update(s.id, { opencodeSessionId: bad });
  check(`rejected: ${JSON.stringify(bad)}`, runner.commandFor(sessions.get(s.id)).includes('--session'), false);
}

console.log('\nthe pin wins over the folder, so siblings cannot cross-talk');
// Two live opencode sessions in one folder: `--continue` would have given BOTH
// the same conversation. Each pinned session resumes its own.
const other = sessions.create({ name: 'oc-2', cli: 'opencode', path: 'proj-a' });
const MINE = 'ses_0aaaaaaaaffeaaaaaaaaaaaaaaa';
const THEIRS = 'ses_0bbbbbbbbffebbbbbbbbbbbbbbb';
addRow(MINE, '/data/workspaces/proj-a', 1770000001000);
addRow(THEIRS, '/data/workspaces/proj-a', 1770000002000); // newer: --continue would pick this
sessions.update(s.id, { opencodeSessionId: MINE });
sessions.update(other.id, { everStarted: true, opencodeSessionId: THEIRS });
has('this session resumes its own', runner.commandFor(sessions.get(s.id)), `--session ${MINE}`);
has('the sibling resumes its own', runner.commandFor(sessions.get(other.id)), `--session ${THEIRS}`);

console.log('\na first launch has nothing to resume');
const fresh = sessions.create({ name: 'oc-3', cli: 'opencode', path: 'proj-b' });
sessions.update(fresh.id, { opencodeSessionId: LIVE }); // pinned but never started
const first = runner.commandFor(sessions.get(fresh.id));
check('no --session on first launch', first.includes('--session'), false);
check('no --continue on first launch', first.includes('--continue'), false);

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch {}
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
