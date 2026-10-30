// scripts/agent-state.sh and entrypoint.sh for Antigravity CLI (`agy`): one
// WAL-mode SQLite database per conversation.
//   checkpoint  one database that can't be copied costs only itself: the
//               others are published once, it is retried a few passes, then
//               left until it changes. agy's files are only read.
//   restore     a valid live database is kept on a hot restart; an invalid one
//               is moved aside for its checkpoint. A restore not started by the
//               entrypoint refuses while a process holds one open.
//   migrate     a real ~/.gemini/antigravity-cli left by an earlier agy reaches
//               the durable tree through SQLite's backup, rows still in its WAL
//               included, without its locks, logs or binaries.
// Everything runs in a temporary tree. Run with: node test/antigravity-state.test.mjs
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../scripts/agent-state.sh');
const entrypoint = path.resolve(here, '../../entrypoint.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-state-'));
const data = path.join(root, 'durable');
const local = path.join(root, 'local');

// An allowlist, as in state-checkpoint.test.mjs: nothing from a running
// Space's environment may point the script at real agent state.
const inherited = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']
  .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const env = { ...inherited, HOME: path.join(root, 'home'), DATA_DIR: data, AM_LOCAL: local, AGENT_STATE_BUDGET: '120' };
for (const [k, live, durable] of [['CODEX', 'codex', 'codex'], ['CLAUDE', 'claude', 'claude'], ['GEMINI', 'gemini-home/.gemini', 'gemini'],
  ['OPENCLAW', 'openclaw', 'openclaw'], ['OPENCODE', 'opencode', 'opencode'], ['HERMES', 'hermes', 'hermes'], ['FX', 'fx-home', 'fx'],
  ['ANTIGRAVITY', 'antigravity-home', 'antigravity']]) {
  env[{ CODEX: 'CODEX_HOME', CLAUDE: 'CLAUDE_CONFIG_DIR', OPENCLAW: 'OPENCLAW_STATE_DIR' }[k] || `${k}_LIVE`] = path.join(local, live);
  env[`${k}_DURABLE`] = path.join(data, 'state', durable);
}
env.GEMINI_CLI_HOME = path.join(local, 'gemini-home');
const LIVE = path.join(env.ANTIGRAVITY_LIVE, 'antigravity-cli');
const DUR = path.join(env.ANTIGRAVITY_DURABLE, 'antigravity-cli');
const STAMPS = path.join(local, 'agent-state-stamps');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const run = (args, extra = {}) => spawnSync('sh', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const sql = (db, q) => execFileSync('sqlite3', [db, q], { encoding: 'utf8' }).trim();
// The main file alone: a plain open would fold a WAL beside it in on close.
const sqlMain = (db, q) => sql(`file:${db}?immutable=1`, q);
const exists = (p) => fs.existsSync(p);
const mtime = (p) => fs.statSync(p).mtimeMs;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A database whose last rows are only in its WAL, as an agy that was killed
// leaves it: the writer dies without checkpointing.
async function crashed(db, rows, { keepShm = true } = {}) {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const w = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  w.stdout.on('data', (c) => { out += c; });
  w.stdin.write('PRAGMA journal_mode=WAL;\nCREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY, body TEXT);\nPRAGMA wal_checkpoint(TRUNCATE);\nPRAGMA wal_autocheckpoint=0;\n');
  for (const r of rows) w.stdin.write(`INSERT INTO steps(body) VALUES ('${r}');\n`);
  w.stdin.write('.print ready\n');
  for (const end = Date.now() + 5000; !out.includes('ready') && Date.now() < end;) await pause(20);
  w.kill('SIGKILL');
  await new Promise((r) => w.once('exit', r));
  if (!keepShm) fs.rmSync(`${db}-shm`, { force: true });
}
const closed = (db, rows) => {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  execFileSync('sqlite3', [db, `PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, body TEXT); ${rows.map((r) => `INSERT INTO steps(body) VALUES ('${r}');`).join(' ')}`]);
};

try {
  console.log('checkpoint: one bad database costs only itself');
  const good = path.join(LIVE, 'conversations/aaaaaaaa-0000-4000-8000-000000000001.db');
  const junk = path.join(LIVE, 'conversations/bbbbbbbb-0000-4000-8000-000000000002.db');
  closed(good, ['hello']);
  put(junk, 'this is not a database');
  for (const d of ['bin', 'log', 'crashes', 'updater', 'presence']) closed(path.join(LIVE, d, 'x.db'), ['local only']);
  put(path.join(LIVE, 'settings.json'), '{}');
  // Older than the 2 s overlap every checkpoint boundary keeps on purpose.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(good, past, past);
  const p1 = run(['checkpoint']);
  check('a pass with a bad database reports it', p1.status === 1 && /bbbbbbbb.*retrying next pass/.test(p1.stderr), p1.stderr);
  check('the good one is published', exists(path.join(DUR, 'conversations/aaaaaaaa-0000-4000-8000-000000000001.db'))
    && sql(path.join(DUR, 'conversations/aaaaaaaa-0000-4000-8000-000000000001.db'), 'select body from steps') === 'hello');
  check('the bad one is not', !exists(path.join(DUR, 'conversations/bbbbbbbb-0000-4000-8000-000000000002.db')));
  check('the stamp moves on anyway', mtime(path.join(STAMPS, 'antigravity-db')) > Date.now() - 60_000);
  check('databases in the folders that stay local are not copied',
    ['bin', 'log', 'crashes', 'updater', 'presence'].every((d) => !exists(path.join(DUR, d, 'x.db'))));
  check('reading the closed database left no sidecar beside it', !exists(`${good}-wal`) && !exists(`${good}-shm`));
  const published = mtime(path.join(DUR, 'conversations/aaaaaaaa-0000-4000-8000-000000000001.db'));
  await pause(1100);
  const p2 = run(['checkpoint']);
  check('the next pass retries only the bad one', p2.status === 1 && /bbbbbbbb/.test(p2.stderr), p2.stderr);
  check('the good one is not published again', mtime(path.join(DUR, 'conversations/aaaaaaaa-0000-4000-8000-000000000001.db')) === published);
  const p3 = run(['checkpoint']);
  check('after three passes it is logged once and left', p3.status === 0 && /after 3 passes; leaving it until it changes/.test(p3.stderr), p3.stderr);
  const p4 = run(['checkpoint']);
  check('and later passes are clean', p4.status === 0 && !/bbbbbbbb/.test(p4.stderr), p4.stderr);
  await pause(1100);
  fs.appendFileSync(junk, ' still not');
  const p5 = run(['checkpoint']);
  check('once it changes, it is tried again', p5.status === 1 && /bbbbbbbb.*retrying next pass/.test(p5.stderr), p5.stderr);
  fs.rmSync(junk);
  run(['checkpoint']); run(['checkpoint']);

  console.log('\ncheckpoint: agy\'s files are only read');
  const crash = path.join(LIVE, 'conversations/cccccccc-0000-4000-8000-000000000003.db');
  await crashed(crash, ['one', 'two'], { keepShm: false });
  const walSize = fs.statSync(`${crash}-wal`).size;
  check('fixture: the rows are only in the WAL', walSize > 0 && sql(`file:${crash}?immutable=1`, 'select count(*) from steps') === '0');
  const p6 = run(['checkpoint']);
  check('the checkpoint passes', p6.status === 0, p6.stderr);
  check('it carries the rows still in the WAL', sql(path.join(DUR, 'conversations/cccccccc-0000-4000-8000-000000000003.db'), 'select count(*) from steps') === '2');
  check('and leaves agy\'s WAL as it was (no checkpoint into the main file)', exists(`${crash}-wal`) && fs.statSync(`${crash}-wal`).size === walSize);

  console.log('\nrestore: the live database is the authority on a hot restart');
  const hot = path.join(LIVE, 'conversations/dddddddd-0000-4000-8000-000000000004.db');
  closed(hot, ['zero']);
  run(['checkpoint']);
  const hotDur = path.join(DUR, 'conversations/dddddddd-0000-4000-8000-000000000004.db');
  // A newer turn lands in the live WAL only; the durable backup is older in
  // content but newer by mtime, as a backup taken a moment later would be.
  await crashed(hot, ['one']);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(hotDur, future, future);
  const inode = fs.statSync(hot).ino;
  const r1 = run(['restore'], { AGENT_STATE_FROM_ENTRYPOINT: '1' });
  check('the restore passes', r1.status === 0, r1.stderr.slice(-600));
  check('the live database was not replaced', fs.statSync(hot).ino === inode);
  check('its rows in the WAL are all there', sql(hot, 'select count(*) from steps') === '2');
  const bad = path.join(LIVE, 'conversations/eeeeeeee-0000-4000-8000-000000000005.db');
  closed(bad, ['from the checkpoint']);
  run(['checkpoint']);
  fs.writeFileSync(bad, 'garbage now');
  const r2 = run(['restore'], { AGENT_STATE_FROM_ENTRYPOINT: '1' });
  check('an invalid live database comes back from its checkpoint', r2.status === 0 && sql(bad, 'select body from steps') === 'from the checkpoint', r2.stderr.slice(-600));
  check('and the invalid one is kept aside', /invalid live Antigravity database moved/.test(r2.stderr)
    && fs.readdirSync(path.join(local, 'agent-state-invalid')).some((d) => d.startsWith('antigravity.')));
  fs.rmSync(env.ANTIGRAVITY_LIVE, { recursive: true, force: true });
  const r3 = run(['restore'], { AGENT_STATE_FROM_ENTRYPOINT: '1' });
  check('a fresh container gets every database back', r3.status === 0
    && sql(hot, 'select count(*) from steps') === '2' && sql(crash, 'select count(*) from steps') === '2', r3.stderr.slice(-600));

  console.log('\nrestore: refused while agy holds a database open');
  const holder = spawn('sqlite3', [hot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let held = '';
  holder.stdout.on('data', (c) => { held += c; });
  holder.stdin.write('BEGIN; SELECT count(*) FROM steps;\n.print open\n');
  for (const end = Date.now() + 5000; !held.includes('open') && Date.now() < end;) await pause(20);
  const r4 = run(['restore']);
  check('a restore not started by the entrypoint refuses', r4.status === 1 && /refusing to restore/.test(r4.stderr) && r4.stderr.includes('antigravity-home'), r4.stderr.slice(-600));
  holder.kill('SIGKILL');
  await new Promise((r) => holder.once('exit', r));

  console.log('\nmigration of a real ~/.gemini/antigravity-cli');
  const home = path.join(root, 'home');
  const legacy = path.join(home, '.gemini/antigravity-cli');
  const legacyDb = path.join(legacy, 'conversations/ffffffff-0000-4000-8000-000000000006.db');
  await crashed(legacyDb, ['written', 'only in the WAL']);
  put(path.join(legacy, 'settings.json'), '{"legacy":true}');
  for (const rel of ['presence/ffffffff.lock', 'log/cli.log', 'crashes/c.log', 'updater/update.lock', 'bin/webm_encoder']) put(path.join(legacy, rel), 'local');
  put(path.join(home, '.gemini/config/projects/p.json'), '{"p":1}');
  put(path.join(home, '.gemini/settings.json'), '{"gemini":true}');
  // The entrypoint's own migration block, run as it is, with the real script.
  const ep = fs.readFileSync(entrypoint, 'utf8');
  const block = ep.slice(ep.indexOf('# Preserve existing Gemini state'), ep.indexOf('boot "migrations done'));
  check('fixture: the migration block was found', block.includes('migrate_tree'));
  const epRun = spawnSync('sh', ['-c', block], { env: { ...env, AGENT_STATE_SCRIPT: script }, encoding: 'utf8' });
  check('the migration passes', epRun.status === 0, epRun.stderr + epRun.stdout);
  const migrated = path.join(DUR, 'conversations/ffffffff-0000-4000-8000-000000000006.db');
  check('no WAL/SHM is copied beside the database', !exists(`${migrated}-wal`) && !exists(`${migrated}-shm`));
  check('the database alone is a valid copy', exists(migrated) && sqlMain(migrated, 'PRAGMA quick_check;') === 'ok');
  check('with the rows that were only in the WAL', exists(migrated) && sqlMain(migrated, 'select count(*) from steps') === '2');
  check('settings and project config come along', exists(path.join(DUR, 'settings.json')) && exists(path.join(env.ANTIGRAVITY_DURABLE, 'config/projects/p.json')));
  check('locks, logs, crash dumps, updater and binaries stay behind',
    ['presence/ffffffff.lock', 'log/cli.log', 'crashes/c.log', 'updater/update.lock', 'bin/webm_encoder'].every((rel) => !exists(path.join(DUR, rel))));
  check('the old folder is kept as a rollback copy', exists(path.join(home, '.gemini/antigravity-cli.pre-agent-state/conversations/ffffffff-0000-4000-8000-000000000006.db-wal')));
  check('and replaced by the link to local disk', fs.lstatSync(legacy).isSymbolicLink() && fs.readlinkSync(legacy) === LIVE);
  check('Gemini\'s migration takes its own files only',
    exists(path.join(env.GEMINI_DURABLE, 'settings.json')) && !exists(path.join(env.GEMINI_DURABLE, 'antigravity-cli')) && !exists(path.join(env.GEMINI_DURABLE, 'config')));
  fs.rmSync(env.ANTIGRAVITY_LIVE, { recursive: true, force: true });
  const r5 = run(['restore'], { AGENT_STATE_FROM_ENTRYPOINT: '1' });
  const back = path.join(LIVE, 'conversations/ffffffff-0000-4000-8000-000000000006.db');
  check('a restore after the migration brings the WAL rows back', r5.status === 0
    && exists(back) && sqlMain(back, 'select count(*) from steps') === '2', r5.stderr.slice(-600));
  check('a migration of anything else is refused', run(['migrate-antigravity', path.join(root, 'elsewhere')]).status === 2);

  console.log('\nthe paths the entrypoint exports are not reported as secrets');
  // Settings lists env vars set after the image was built as injected
  // secrets, except the catalog in index.js, which must name what
  // entrypoint.sh exports (PATH is in the build-time snapshot).
  const idx = fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8');
  const catalog = new Set([...idx.slice(idx.indexOf('const NON_SECRET = new Set(['), idx.indexOf(']);', idx.indexOf('const NON_SECRET = new Set(['))).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
  const exported = [...ep.matchAll(/^\s*export ([A-Z_]+)/gm)].map((m) => m[1]).filter((k) => k !== 'PATH' && !k.startsWith('AM_'));
  const missing = exported.filter((k) => !catalog.has(k));
  check('every export is in NON_SECRET (ANTIGRAVITY_LIVE and _DURABLE included)', missing.length === 0 && catalog.has('ANTIGRAVITY_LIVE'), `missing: ${missing.join(' ')}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
