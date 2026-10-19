// Runs test suites: every `*.test.mjs` in `test/`, then every one at the package
// root, for one package (run from its directory) or for the whole repository.
//
//   cd server && npm test            this package's suites
//   cd web && npm test               this package's suites, plus one shared web build
//   npm test                         (repo root) server + web + the web typecheck
//   npm test -- reader archive       only suites whose path contains a substring
//   npm test -- foo --manual         …including suites marked manual
//   npm test -- --jobs 1             one at a time, output streamed as it happens
//
// WHY THIS EXISTS. Both package.json files used to carry the suite list by hand
// —  `node a.test.mjs && node b.test.mjs && …` on one line. Every PR that added
// a test edited that line, so any two such PRs conflicted by construction, and
// the natural resolution — take one side — silently drops the other PR's suite
// from the run. Discovery removes the shared line: adding `test/foo.test.mjs` is
// enough to make it run.
//
// PARALLEL, BOUNDED. Suites run `--jobs` at a time (default: one per core),
// longest first by the durations recorded on the previous run, so a slow browser
// suite starts at once instead of being the last thing the run waits for. That
// is safe because no suite in the default set binds a fixed port or a fixed path:
// servers listen on a port the kernel hands out, and scratch state lives in
// mkdtemp dirs. A new suite that does need the machine to itself says so in its
// header with a line containing `am-test: serial` and the reason; it then runs
// alone, after the parallel ones. Before reaching for that, give it a free port.
//
// ONE WEB BUILD PER RUN. A suite that serves the production build (it mentions
// AM_TEST_DIST, normally through `buildWeb()` in web/test/helpers/) waits for a
// single `vite build` the runner starts at the beginning, and gets its directory
// in AM_TEST_DIST. A suite that writes into the build must copy it first.
// AM_TEST_DIST set by the caller is used as is and nothing is built.
//
// EVERY SUITE RUNS. A failing suite no longer stops the run: everything runs,
// and the end of the output lists every failure with its exit status. The exit
// code is non-zero if anything failed. With more than one job, a passing suite
// prints one line and a failing one prints its whole output, so the log stays
// readable; `--verbose` prints every suite's output, and `--jobs 1` streams it.
// A suite that runs longer than AM_SUITE_TIMEOUT seconds (default 600) is killed
// with its process group and counted as failed, rather than hanging the run.
//
// OPTING OUT. A suite that must not run in the default set says so in its own
// header, on a line containing `am-test: manual` plus the reason. It is declared
// where a reader will see it rather than by absence from a list somewhere else,
// and every run prints what it skipped and why. docs/testing.md lists them.
//
// DISCOVERY IS TWO DEEP, ON PURPOSE: `test/` and the package root, so a
// `test/fixtures/` directory is fixtures rather than a source of surprise runs.
// A `*.test.mjs` anywhere below that is reported at the end of every run instead
// of being ignored — a file that looks like a suite and never runs is the exact
// failure this script exists to end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANUAL = /am-test:\s*manual\s*[—:-]?\s*(.*)/;
const SERIAL = /am-test:\s*serial\b/;
const NEEDS_DIST = /AM_TEST_DIST|buildWeb\(/;
const HEAD_BYTES = 4096;          // the markers belong in the header, not line 900
const TIMEOUT_S = Number(process.env.AM_SUITE_TIMEOUT) || 600;

const listDir = (dir) => {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.test.mjs'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile());
};

/** The suites of one package directory, already filtered. */
function discover(pkgDir, { filters, wantManual }) {
  const pkg = path.basename(pkgDir);
  const matches = (file) => !filters.length || filters.some((f) => `${pkg}/${file}`.includes(f));
  const suites = [];
  const skipped = [];
  for (const file of [...listDir(path.join(pkgDir, 'test')), ...listDir(pkgDir)].map((p) => path.relative(pkgDir, p))) {
    let src = '';
    try { src = fs.readFileSync(path.join(pkgDir, file), 'utf8'); } catch { /* unreadable: let node report it */ }
    const head = src.slice(0, HEAD_BYTES);
    const manual = head.match(MANUAL);
    // Named explicitly with --manual, a manual suite runs: the filter is the
    // run-one-by-hand path, and the suites worth running by hand are mostly these.
    if (manual && !(wantManual && filters.length && matches(file))) {
      if (matches(file)) skipped.push({ name: `${pkg}/${file}`, why: manual[1].trim() });
      continue;
    }
    if (!matches(file)) continue;
    suites.push({
      name: `${pkg}/${file}`, cwd: pkgDir, cmd: [process.execPath, file],
      serial: SERIAL.test(head), needsDist: NEEDS_DIST.test(src),
    });
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
      } else if (e.name.endsWith('.test.mjs') && depth > 0 && path.relative(pkgDir, path.dirname(p)) !== 'test') {
        stray.push(`${pkg}/${path.relative(pkgDir, p)}`);
      }
    }
  }(pkgDir, 0));
  return { suites, skipped, stray };
}

// Durations from the last run, to start the longest suites first. Machine-local
// and disposable: lives under node_modules/.cache, and a missing or stale file
// only changes the order, never what runs.
const timesFile = path.join(REPO, 'web', 'node_modules', '.cache', 'am-suite-times.json');
const readTimes = () => { try { return JSON.parse(fs.readFileSync(timesFile, 'utf8')); } catch { return {}; } };
const writeTimes = (times) => {
  try { fs.mkdirSync(path.dirname(timesFile), { recursive: true }); fs.writeFileSync(timesFile, JSON.stringify(times, null, 1)); } catch { /* best effort */ }
};

/** Runs one command; resolves { code, signal, output, secs, timedOut }. */
function runTask(task, { stream, env }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(task.cmd[0], task.cmd.slice(1), {
      cwd: task.cwd, env: { ...process.env, ...env }, detached: true,
      stdio: ['ignore', stream ? 'inherit' : 'pipe', stream ? 'inherit' : 'pipe'],
    });
    const chunks = [];
    child.stdout?.on('data', (d) => chunks.push(d));
    child.stderr?.on('data', (d) => chunks.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, TIMEOUT_S * 1000);
    child.on('error', (e) => chunks.push(Buffer.from(String(e.stack || e))));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Anything the suite left running in its group (a server it forgot to
      // stop, a browser) would otherwise outlive the run and hold its port.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ }
      resolve({ code, signal, timedOut, output: Buffer.concat(chunks).toString('utf8'), secs: (performance.now() - t0) / 1000 });
    });
  });
}

/** `vite build` into a fresh temp dir, once. */
function buildWeb() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-dist-'));
  const task = { cwd: path.join(REPO, 'web'), cmd: [process.execPath, 'node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--outDir', out] };
  return runTask(task, { stream: false }).then((r) => ({ ...r, out }));
}

export async function runSuites({ pkgDirs, filters = [], wantManual = false, jobs, verbose = false, extraTasks = [] }) {
  const all = pkgDirs.map((d) => discover(d, { filters, wantManual }));
  const suites = all.flatMap((a) => a.suites);
  const skipped = all.flatMap((a) => a.skipped);
  const stray = all.flatMap((a) => a.stray);
  const plural = (n) => `${n} suite${n === 1 ? '' : 's'}`;
  const report = () => {
    for (const { name, why } of skipped) console.log(`  skipped ${name} — ${why || 'marked manual'}`);
    for (const name of stray) {
      console.log(`  NOT RUN ${name} — below \`test/\` and the package root, where discovery looks.`);
      console.log('          Move it up, or mark it `am-test: manual` with a reason, or rename it.');
    }
  };
  const label = pkgDirs.map((d) => path.basename(d)).join(' + ');
  if (!suites.length && !extraTasks.length) {
    // Blaming the filter here sends people looking for a typo when the file was
    // found and deliberately excluded.
    const manualOnly = skipped.length && filters.length;
    console.error(manualOnly
      ? `${label}: ${plural(skipped.length)} matched ${filters.join(', ')}, all marked manual:`
      : `no suites found in ${label}${filters.length ? ` matching ${filters.join(', ')}` : ''}`);
    report();
    if (manualOnly) console.error(`Run one anyway with: npm test -- ${filters.join(' ')} --manual`);
    return 1;
  }

  jobs = Math.max(1, jobs || os.availableParallelism());
  const tasks = [...extraTasks, ...suites];
  const stream = jobs === 1 && tasks.length === suites.length;
  const times = readTimes();
  // Longest first; an unknown duration counts as long, so a new suite is not the
  // one the whole run ends up waiting on.
  const est = (t) => times[t.name] ?? 60;
  const parallel = tasks.filter((t) => !t.serial).sort((a, b) => est(b) - est(a));
  const serial = tasks.filter((t) => t.serial);
  console.log(`${label}: ${plural(suites.length)}${extraTasks.length ? ` + ${extraTasks.map((t) => t.name).join(', ')}` : ''}, ${jobs} at a time\n`);

  const t0 = performance.now();
  let dist = process.env.AM_TEST_DIST || null;
  let build = null;
  if (!dist && suites.some((s) => s.needsDist)) {
    build = buildWeb().then((r) => {
      console.log(`${r.code === 0 ? '  ok  ' : '  FAIL'} web build for AM_TEST_DIST (${r.secs.toFixed(1)}s)`);
      if (r.code !== 0) { console.log(r.output); return null; }
      return r.out;
    });
  }

  const results = [];
  const finish = (task, r) => {
    const ok = r.code === 0 && !r.timedOut;
    results.push({ task, ok, ...r });
    times[task.name] = Math.round(r.secs * 10) / 10;
    const why = ok ? '' : r.timedOut ? ` — killed after ${TIMEOUT_S}s` : r.signal ? ` — signal ${r.signal}` : ` — exit ${r.code}`;
    if (stream) { if (!ok) console.log(`\n${task.name} FAILED${why}`); console.log(''); return; }
    const n = String(results.length).padStart(String(tasks.length).length);
    console.log(`${ok ? '  ok  ' : '  FAIL'} [${n}/${tasks.length}] ${task.name} (${r.secs.toFixed(1)}s)${why}`);
    if (!ok || verbose) {
      const out = r.output.trimEnd();
      if (out) console.log(out.split('\n').map((l) => `      │ ${l}`).join('\n'));
    }
  };
  const start = async (task) => {
    let env = {};
    if (task.needsDist) {
      if (build) dist = await build;
      if (!dist) { finish(task, { code: 1, signal: null, timedOut: false, output: 'not run: the shared web build failed (above)', secs: 0 }); return; }
      env = { AM_TEST_DIST: dist };
    }
    if (stream) console.log(`── ${task.name}`);
    finish(task, await runTask(task, { stream, env }));
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, parallel.length) }, async () => {
    while (next < parallel.length) await start(parallel[next++]);
  }));
  for (const task of serial) await start(task);
  if (build && dist) fs.rmSync(dist, { recursive: true, force: true });
  writeTimes(times);

  const failed = results.filter((r) => !r.ok);
  const wall = (performance.now() - t0) / 1000;
  console.log('');
  if (failed.length) {
    console.log(`${label}: ${failed.length} of ${results.length} FAILED in ${wall.toFixed(1)}s:`);
    for (const r of failed) console.log(`  ✗ ${r.task.name}${r.timedOut ? ` (killed after ${TIMEOUT_S}s)` : r.signal ? ` (signal ${r.signal})` : ` (exit ${r.code})`}`);
  } else {
    console.log(`${label}: all ${results.length} passed in ${wall.toFixed(1)}s`);
  }
  report();
  return failed.length ? 1 : 0;
}

export function parseArgs(argv) {
  const opts = { filters: [], wantManual: false, verbose: false, jobs: Number(process.env.AM_TEST_JOBS) || 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manual') opts.wantManual = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--serial') opts.jobs = 1;
    else if (a === '--jobs' || a === '-j') opts.jobs = Number(argv[++i]);
    else if (a.startsWith('--jobs=')) opts.jobs = Number(a.slice(7));
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else opts.filters.push(a);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSuites({ pkgDirs: [process.cwd()], ...parseArgs(process.argv.slice(2)) });
}
