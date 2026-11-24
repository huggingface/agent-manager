// Antigravity's ~/.gemini/{antigravity-cli,config} must be links to local disk
// (state-links.js, agent-state.sh relink-antigravity). The incident: from
// 2026-11-20 both were real directories on the bucket, agy kept its SQLite
// there, and four conversations came back malformed.
//
// Everything runs in temporary directories, with an allowlisted environment:
// a shell inside a running Space exports the real live and durable paths.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../scripts/agent-state.sh');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agy-relink-'));
process.env.DATA_DIR = path.join(base, 'server-data');
const { ensureAntigravityLinks, readStateLinkHealth, expectedLinks, _reset } = await import('../src/state-links.js');

const children = [];
after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch {} });

let n = 0;
function world() {
  const root = path.join(base, `w${++n}`);
  const data = path.join(root, 'data');
  const local = path.join(root, 'local');
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', TMPDIR: path.join(root, 'tmp'),
    HOME: path.join(data, 'home'),
    DATA_DIR: data,
    AM_LOCAL: local,
    AGENT_STATE_SCRIPT: script,
    ANTIGRAVITY_LIVE: path.join(local, 'antigravity-home'),
    ANTIGRAVITY_DURABLE: path.join(data, 'state/antigravity'),
    AGENT_STATE_LOG: path.join(data, 'state/agent-state.log'),
  };
  for (const d of [env.TMPDIR, path.join(env.HOME, '.gemini'), path.join(env.ANTIGRAVITY_LIVE, 'antigravity-cli'), path.join(env.ANTIGRAVITY_LIVE, 'config')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const link = path.join(env.HOME, '.gemini/antigravity-cli');
  const cfg = path.join(env.HOME, '.gemini/config');
  const live = path.join(env.ANTIGRAVITY_LIVE, 'antigravity-cli');
  return { root, env, link, cfg, live, liveCfg: path.join(env.ANTIGRAVITY_LIVE, 'config') };
}
const linkOk = (w) => {
  fs.symlinkSync(w.live, w.link);
  fs.symlinkSync(w.liveCfg, w.cfg);
};
const write = (p, text, mtimeSec) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mtimeSec) fs.utimesSync(p, mtimeSec, mtimeSec);
};
const sqlite = (db, sql) => spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });

// A database whose newest rows exist only in its -wal: what agy leaves when it
// is killed, and what a copy of the .db alone would lose.
function dbWithWal(db) {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const py = `
import sqlite3, os, sys
c = sqlite3.connect(sys.argv[1]); c.execute('pragma journal_mode=wal'); c.execute('pragma wal_autocheckpoint=0')
c.execute('create table t(x)'); c.commit()
c.execute("insert into t values ('only-in-wal')"); c.commit()
os._exit(0)  # no close: no checkpoint, the row stays in the WAL
`;
  const r = spawnSync('python3', ['-c', py, db], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(`${db}-wal`).size > 0, 'the WAL holds frames');
}
const asides = (w, name) => fs.readdirSync(path.dirname(w.link)).filter((f) => f.startsWith(`${name}.bucket-`));

test('links that are fine cost nothing and report nothing', () => {
  _reset();
  const w = world(); linkOk(w);
  assert.equal(ensureAntigravityLinks({ env: w.env }), 'ok');
  assert.equal(readStateLinkHealth({ env: w.env, dataDir: w.env.DATA_DIR }), null);
  assert.deepEqual(expectedLinks(w.env).map((l) => l.link), [w.link, w.cfg]);
});

test('a link replaced by a real directory is merged, moved aside and relinked before launch; the WAL comes along', () => {
  _reset();
  const w = world();
  fs.symlinkSync(w.liveCfg, w.cfg);
  const old = Math.floor(Date.now() / 1000) - 3600;
  // The bucket copy: a conversation only it has (rows in the WAL, plus a stale
  // -shm), a newer settings file, and an older copy of a database live has
  // since changed.
  fs.mkdirSync(w.link);
  dbWithWal(path.join(w.link, 'conversations/a.db'));
  write(path.join(w.link, 'conversations/a.db-shm'), 'stale shm');
  write(path.join(w.link, 'settings.json'), '{"from":"bucket"}');
  write(path.join(w.link, 'conversations/b.db'), 'bucket-old-b', old);
  write(path.join(w.link, 'history.jsonl'), 'bucket-old-history', old);
  // Live: a newer b.db, and a newer history.jsonl.
  write(path.join(w.live, 'conversations/b.db'), 'live-new-b');
  write(path.join(w.live, 'history.jsonl'), 'live-new-history');
  write(path.join(w.live, 'settings.json'), '{"from":"live"}', old);

  const before = readStateLinkHealth({ env: w.env, dataDir: w.env.DATA_DIR });
  assert.equal(before.broken.length, 1);
  assert.deepEqual({ cli: before.broken[0].cli, kind: before.broken[0].kind, onBucket: before.broken[0].onBucket },
    { cli: 'antigravity', kind: 'dir', onBucket: true });

  assert.equal(ensureAntigravityLinks({ env: w.env }), 'repaired');

  assert.equal(fs.readlinkSync(w.link), w.live);
  assert.equal(readStateLinkHealth({ env: w.env, dataDir: w.env.DATA_DIR }), null);
  // The pair came over together, and the row that was only in the WAL is there.
  assert.ok(fs.statSync(path.join(w.live, 'conversations/a.db-wal')).size > 0);
  assert.equal(fs.existsSync(path.join(w.live, 'conversations/a.db-shm')), false, '-shm is never copied');
  assert.equal(sqlite(path.join(w.live, 'conversations/a.db'), 'select x from t').stdout.trim(), 'only-in-wal');
  // Newer wins, both ways.
  assert.equal(fs.readFileSync(path.join(w.live, 'settings.json'), 'utf8'), '{"from":"bucket"}');
  assert.equal(fs.readFileSync(path.join(w.live, 'conversations/b.db'), 'utf8'), 'live-new-b');
  assert.equal(fs.readFileSync(path.join(w.live, 'history.jsonl'), 'utf8'), 'live-new-history');
  // Never deleted: the directory is aside, whole.
  const [aside] = asides(w, 'antigravity-cli');
  assert.ok(aside, 'moved aside with a timestamp');
  assert.match(aside, /^antigravity-cli\.bucket-\d{8}T\d{6}Z/);
  const kept = path.join(path.dirname(w.link), aside);
  for (const f of ['conversations/a.db', 'conversations/a.db-wal', 'conversations/a.db-shm', 'conversations/b.db', 'settings.json']) {
    assert.ok(fs.existsSync(path.join(kept, f)), `${f} kept in the moved-aside copy`);
  }
  // Written down where it survives a restart.
  assert.match(fs.readFileSync(w.env.AGENT_STATE_LOG, 'utf8'),
    /relink-antigravity relink: .*antigravity-cli was a real directory \(Antigravity state on the bucket\); merged into .*, moved aside to .*\.bucket-/);
});

test('a newer bucket database replaces the live pair as a pair; the replaced one is kept', () => {
  _reset();
  const w = world(); fs.symlinkSync(w.liveCfg, w.cfg);
  const old = Math.floor(Date.now() / 1000) - 3600;
  write(path.join(w.live, 'conversations/c.db'), 'live-old-c', old);
  write(path.join(w.live, 'conversations/c.db-wal'), 'live-old-c-wal', old);
  write(path.join(w.live, 'conversations/c.db-shm'), 'live-old-c-shm', old);
  fs.mkdirSync(w.link);
  write(path.join(w.link, 'conversations/c.db'), 'bucket-new-c');
  assert.equal(ensureAntigravityLinks({ env: w.env }), 'repaired');
  assert.equal(fs.readFileSync(path.join(w.live, 'conversations/c.db'), 'utf8'), 'bucket-new-c');
  // The old WAL must not be replayed onto the newer database.
  assert.equal(fs.existsSync(path.join(w.live, 'conversations/c.db-wal')), false);
  assert.equal(fs.existsSync(path.join(w.live, 'conversations/c.db-shm')), false);
  const rep = path.join(w.env.AM_LOCAL, 'agent-state-replaced');
  const [dir] = fs.readdirSync(rep);
  assert.equal(fs.readFileSync(path.join(rep, dir, 'conversations/c.db-wal'), 'utf8'), 'live-old-c-wal');
});

test('the config link is repaired too, and a missing link is made', () => {
  _reset();
  const w = world();
  fs.mkdirSync(w.cfg);
  write(path.join(w.cfg, 'mcp_config.json'), '{}');
  assert.equal(ensureAntigravityLinks({ env: w.env }), 'repaired');
  assert.equal(fs.readlinkSync(w.cfg), w.liveCfg);
  assert.equal(fs.readlinkSync(w.link), w.live);
  assert.equal(fs.readFileSync(path.join(w.liveCfg, 'mcp_config.json'), 'utf8'), '{}');
  assert.equal(asides(w, 'config').length, 1);
});

function startFakeAgy(w, cwd) {
  // A process whose executable is named agy, with this world's HOME.
  const bin = path.join(w.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const agy = path.join(bin, 'agy');
  fs.copyFileSync(spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim(), agy);
  fs.chmodSync(agy, 0o755);
  const c = spawn(agy, ['60'], { env: { PATH: '/usr/bin:/bin', HOME: w.env.HOME }, cwd, stdio: 'ignore' });
  children.push(c);
  return c;
}
async function procUp(c) {
  for (let i = 0; i < 50; i++) {
    try { if (fs.readlinkSync(`/proc/${c.pid}/exe`).endsWith('/agy')) return; } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('fake agy did not start');
}

test('while agy runs nothing is moved, and the warning says why', async () => {
  _reset();
  const w = world(); fs.symlinkSync(w.liveCfg, w.cfg);
  fs.mkdirSync(w.link);
  dbWithWal(path.join(w.link, 'conversations/a.db'));
  const c = startFakeAgy(w, w.root);
  await procUp(c);

  assert.equal(ensureAntigravityLinks({ env: w.env }), 'deferred');
  assert.ok(fs.lstatSync(w.link).isDirectory() && !fs.lstatSync(w.link).isSymbolicLink(), 'still the real directory');
  assert.ok(fs.existsSync(path.join(w.link, 'conversations/a.db-wal')));
  assert.equal(fs.existsSync(path.join(w.live, 'conversations/a.db')), false, 'nothing copied');
  assert.equal(asides(w, 'antigravity-cli').length, 0);
  const h = readStateLinkHealth({ env: w.env, dataDir: w.env.DATA_DIR });
  assert.equal(h.broken[0].kind, 'dir');
  assert.equal(h.repair.outcome, 'deferred');
  assert.match(h.repair.detail, /agy is running/);
  assert.match(fs.readFileSync(w.env.AGENT_STATE_LOG, 'utf8'), /DEFERRED: .*antigravity-cli is a real directory/);

  // Once it has exited, the next launch repairs it.
  c.kill('SIGKILL');
  await new Promise((r) => c.once('exit', r));
  assert.equal(ensureAntigravityLinks({ env: w.env }), 'repaired');
  assert.equal(readStateLinkHealth({ env: w.env, dataDir: w.env.DATA_DIR }), null);
  assert.equal(sqlite(path.join(w.live, 'conversations/a.db'), 'select x from t').stdout.trim(), 'only-in-wal');
});

test('any process with a file or its cwd in the directory also defers it', async () => {
  _reset();
  const w = world(); fs.symlinkSync(w.liveCfg, w.cfg);
  fs.mkdirSync(w.link);
  const c = spawn('sleep', ['60'], { cwd: w.link, stdio: 'ignore' });
  children.push(c);
  for (let i = 0; i < 50 && !fs.existsSync(`/proc/${c.pid}/cwd`); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ensureAntigravityLinks({ env: w.env }), 'deferred');
  assert.equal(fs.lstatSync(w.link).isSymbolicLink(), false);
  c.kill('SIGKILL');
});

test('an agy with another HOME does not hold the repair back', async () => {
  _reset();
  const w = world(); fs.symlinkSync(w.liveCfg, w.cfg);
  fs.mkdirSync(w.link);
  const other = world();
  const c = startFakeAgy(other, other.root);
  await procUp(c);
  assert.equal(ensureAntigravityLinks({ env: w.env }), 'repaired');
  c.kill('SIGKILL');
});

test('the general check: any CLI whose state link became a real directory on the data dir', () => {
  _reset();
  const w = world(); linkOk(w);
  const env = { ...w.env, OPENCODE_LIVE: path.join(w.env.AM_LOCAL, 'opencode'), HERMES_LIVE: path.join(w.env.AM_LOCAL, 'hermes'), FX_LIVE: path.join(w.env.AM_LOCAL, 'fx') };
  fs.mkdirSync(path.join(env.HOME, '.hermes'));
  fs.symlinkSync(env.FX_LIVE, path.join(env.HOME, '.fx'));
  const h = readStateLinkHealth({ env, dataDir: env.DATA_DIR });
  // opencode's is missing (harmless until it runs), fx's is right.
  assert.deepEqual(h.broken.map((b) => [b.cli, b.kind, b.onBucket]), [['hermes', 'dir', true]]);
});

test('the watcher puts back a link the mount dropped, even while agy runs, and leaves a directory to the launch', async () => {
  _reset();
  const w = world(); linkOk(w);
  const c = startFakeAgy(w, w.root);
  await procUp(c);
  fs.unlinkSync(w.cfg); // what hf-mount did to ~/.gemini/config on 11-24
  assert.equal(ensureAntigravityLinks({ env: w.env, missingOnly: true }), 'repaired');
  assert.equal(fs.readlinkSync(w.cfg), w.liveCfg);
  assert.match(fs.readFileSync(w.env.AGENT_STATE_LOG, 'utf8'), /config was missing; linked it to/);
  // A real directory: untouched, no log line, no failure recorded.
  fs.unlinkSync(w.link); fs.mkdirSync(w.link);
  const logged = fs.readFileSync(w.env.AGENT_STATE_LOG, 'utf8');
  assert.equal(ensureAntigravityLinks({ env: w.env, missingOnly: true }), 'ok');
  assert.equal(fs.lstatSync(w.link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(w.env.AGENT_STATE_LOG, 'utf8'), logged);
  assert.equal(readStateLinkHealth({ env: w.env, dataDir: w.env.DATA_DIR }).broken[0].kind, 'dir');
  c.kill('SIGKILL');
});
