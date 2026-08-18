// Runs a package's test suites: every `*.test.mjs` in `test/`, then every one at
// the package root, in that order, one at a time.
//
// WHY THIS EXISTS. Both package.json files used to carry the suite list by hand
// —  `node a.test.mjs && node b.test.mjs && …` on one line. Every PR that added
// a test edited that line, so any two such PRs conflicted by construction (six
// times in the last few days), and the natural resolution — take one side —
// silently drops the other PR's suite from the run. It stays green and nobody
// notices the coverage is gone. Discovery removes the shared line: adding
// `test/foo.test.mjs` is enough to make it run.
//
// SEQUENTIAL, DELIBERATELY. `node --test` would also discover these files, but
// it runs them in PARALLEL by default, and several suites here start a real
// server on a fixed port (migration on 7893, resize on 7895, trace-download on
// 7898) or drive Chromium. Those ports do not collide today, but only because
// whoever added each one picked a free number — nothing enforces it, and the
// first suite that copies an existing PORT constant produces a flake that reads
// as a product bug. This fleet has already lost time to exactly that symptom.
// One at a time costs wall-clock and nothing else.
//
// EXIT SEMANTICS match the `&&` chain it replaces: the first failing suite stops
// the run and its exit code is this process's exit code. That holds for both
// kinds of file here — the standalone scripts that print their own results and
// call process.exit, and the two `node:test` suites, which node exits non-zero
// for when a test fails (verified, not assumed).
//
// OPTING OUT. A suite that must not run in the default set says so in its own
// header, on a line containing `am-test: manual` plus the reason. It is declared
// where a reader will see it rather than by absence from a list somewhere else,
// and every run prints what it skipped and why, so coverage cannot go quiet.
//
// Usage:  node ../scripts/run-suites.mjs [substring …]
//         (a substring filters to matching suites — for running one by hand)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MANUAL = /am-test:\s*manual\s*[—:-]?\s*(.*)/;
const HEAD_BYTES = 4096;          // the marker belongs in the header, not line 900

const listDir = (dir) => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.test.mjs'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile());
};

// `test/` first, then the package root: the root files are the older ones, and
// keeping them behind the directory keeps the common case (a new suite in
// test/) at the front of the run.
const found = [...listDir('test'), ...listDir('.')];

const filters = process.argv.slice(2);
const suites = [];
const skipped = [];
for (const file of found) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    fs.closeSync(fd);
  } catch { /* unreadable: let node report it */ }
  const manual = head.match(MANUAL);
  if (manual) { skipped.push({ file, why: manual[1].trim() }); continue; }
  if (filters.length && !filters.some((f) => file.includes(f))) continue;
  suites.push(file);
}

const pkg = path.basename(process.cwd());
if (!suites.length) {
  console.error(`no suites found in ${pkg}/${filters.length ? ` matching ${filters.join(', ')}` : ''}`);
  process.exit(1);
}
const plural = (n) => `${n} suite${n === 1 ? '' : 's'}`;
console.log(`${pkg}: ${plural(suites.length)}\n`);

for (const [i, file] of suites.entries()) {
  console.log(`── [${i + 1}/${suites.length}] ${file}`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  if (code !== 0) {
    console.error(`\n${file} FAILED (${r.signal ? `signal ${r.signal}` : `exit ${code}`})`);
    console.error(`${plural(i)} had passed before it; the rest were not started.`);
    process.exit(code);
  }
  console.log('');
}

console.log(`${pkg}: ${plural(suites.length)} passed`);
for (const { file, why } of skipped) console.log(`  skipped ${file} — ${why || 'marked manual'}`);
