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
// and every run prints what it skipped and why — on the failure path too, since
// that is the moment someone is actually reading this output.
//
// DISCOVERY IS TWO DEEP, ON PURPOSE: `test/` and the package root, so a
// `test/fixtures/` directory is fixtures rather than a source of surprise runs.
// A `*.test.mjs` anywhere below that is reported at the end of every run instead
// of being ignored — a file that looks like a suite and never runs is the exact
// failure this script exists to end, and it does not matter that the cause is a
// subdirectory rather than a hand-edited list.
//
// Usage:  node ../scripts/run-suites.mjs [substring …] [--manual]
//         a substring filters to matching suites — for running one by hand;
//         --manual lets that filter reach the suites marked manual.
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

const args = process.argv.slice(2);
const wantManual = args.includes('--manual');
const filters = args.filter((a) => !a.startsWith('--'));
const matches = (file) => !filters.length || filters.some((f) => file.includes(f));
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
  // Named explicitly with --manual, a manual suite runs: the filter is the
  // run-one-by-hand path, and the suites worth running by hand are mostly these.
  if (manual && !(wantManual && filters.length && matches(file))) {
    if (matches(file)) skipped.push({ file, why: manual[1].trim() });
    continue;
  }
  if (!matches(file)) continue;
  suites.push(file);
}

// Anything that looks like a suite but sits below the two scanned depths.
const stray = [];
(function walk(dir, depth) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(e.name)) continue;
      walk(p, depth + 1);
    } else if (e.name.endsWith('.test.mjs') && depth > 0 && path.dirname(p) !== 'test') {
      stray.push(p);
    }
  }
}('.', 0));

const plural = (n) => `${n} suite${n === 1 ? '' : 's'}`;
// Printed by BOTH exits. What did not run is most worth saying when something
// failed, and that is exactly when an early `process.exit` used to swallow it.
const report = () => {
  for (const { file, why } of skipped) console.log(`  skipped ${file} — ${why || 'marked manual'}`);
  for (const file of stray) {
    console.log(`  NOT RUN ${file} — below \`test/\` and the package root, where discovery looks.`);
    console.log('          Move it up, or mark it `am-test: manual` with a reason, or rename it.');
  }
};

const pkg = path.basename(process.cwd());
if (!suites.length) {
  // Blaming the filter here sends people looking for a typo when the file was
  // found and deliberately excluded.
  const manualOnly = skipped.length && filters.length;
  console.error(manualOnly
    ? `${pkg}/: ${plural(skipped.length)} matched ${filters.join(', ')}, all marked manual:`
    : `no suites found in ${pkg}/${filters.length ? ` matching ${filters.join(', ')}` : ''}`);
  report();
  if (manualOnly) console.error(`Run one anyway with: npm test -- ${filters.join(' ')} --manual`);
  process.exit(1);
}
console.log(`${pkg}: ${plural(suites.length)}\n`);

for (const [i, file] of suites.entries()) {
  console.log(`── [${i + 1}/${suites.length}] ${file}`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  if (code !== 0) {
    console.error(`\n${file} FAILED (${r.signal ? `signal ${r.signal}` : `exit ${code}`})`);
    console.error(`${plural(i)} had passed before it; the rest were not started.`);
    report();
    process.exit(code);
  }
  console.log('');
}

console.log(`${pkg}: ${plural(suites.length)} passed`);
report();
