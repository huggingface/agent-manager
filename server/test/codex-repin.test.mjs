// The codex rollout walk, after being made async.
//
// It walks $CODEX_HOME/sessions, whose `sessions` child is a symlink onto the
// FUSE bucket on the Space. Synchronously that froze every pane for 400-750ms on
// every REPIN_MS beat, once per codex session. Run with:
//   node test/codex-repin.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repin-'));
process.env.CODEX_HOME = path.join(TMP, 'codex-home');
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const runner = await import('../src/runner.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}  want ${want}`}`);
};

const NOW = 1770000000000;
const SESSIONS = path.join(process.env.CODEX_HOME, 'sessions');

// Codex lays rollouts out under sessions/YYYY/MM/DD/, so the walk has to descend
// three levels before it ever sees a file.
function rollout(uuid, { day = '28', month = '07', mtimeMs }) {
  const dir = path.join(SESSIONS, '2026', month, day);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `rollout-2026-${month}-${day}T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(p, `${JSON.stringify({ payload: { cwd: '/w', timestamp: '2026-07-28T00:00:00Z' } })}\n`);
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;

console.log('an absent root is not an error');
check('returns empty, does not throw', (await runner.codexRolloutsSince(0)).length, 0);

console.log('\nfinds rollouts under the YYYY/MM/DD tree');
const old = rollout(U(1), { mtimeMs: NOW - 60_000 });
const mid = rollout(U(2), { mtimeMs: NOW - 30_000 });
const New = rollout(U(3), { month: '08', day: '01', mtimeMs: NOW });

let got = await runner.codexRolloutsSince(0);
check('finds all three across months', got.length, 3);
check('newest first', got[0].p, New);
check('oldest last', got[2].p, old);

console.log('\nfilters on mtime');
got = await runner.codexRolloutsSince(NOW - 45_000);
check('drops the one older than sinceMs', got.length, 2);
check('keeps the newest', got[0].p, New);
check('keeps the middle', got[1].p, mid);

console.log('\nignores anything that is not a rollout');
fs.writeFileSync(path.join(SESSIONS, '2026', '07', '28', 'notes.jsonl'), '{}\n');
fs.writeFileSync(path.join(SESSIONS, '2026', '07', '28', 'rollout-x.txt'), 'x\n');
check('still only the rollouts', (await runner.codexRolloutsSince(0)).length, 3);

console.log('\nis actually async — the whole point of the change');
const returned = runner.codexRolloutsSince(0);
check('returns a promise', typeof returned.then, 'function');
await returned;

// A rollout nested past the depth cap must not be walked forever.
console.log('\nrespects the depth cap');
let deep = SESSIONS;
for (let i = 0; i < 8; i++) deep = path.join(deep, `d${i}`);
fs.mkdirSync(deep, { recursive: true });
fs.writeFileSync(path.join(deep, `rollout-deep-${U(9)}.jsonl`), '{}\n');
check('too-deep rollout ignored', (await runner.codexRolloutsSince(0)).length, 3);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
