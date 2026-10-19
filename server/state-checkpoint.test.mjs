// Crash/recovery checks for scripts/agent-state.sh. Everything runs on local
// temporary directories; no mounted bucket or real agent state is touched.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-state-'));
const data = path.join(root, 'durable');
const local = path.join(root, 'local');
const script = path.resolve(here, '../scripts/agent-state.sh');

// An ALLOWLIST, not process.env with overrides: inside a running Space every
// shell exports the real CODEX_HOME, CLAUDE_CONFIG_DIR, *_LIVE and *_DURABLE,
// and a variable this list forgot to override would point the script at live
// agent state (it did, once, from a hand-run measurement — see the PR that
// added this). Nothing reaches the script that is not named here.
const inherited = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']
  .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const env = {
  ...inherited,
  HOME: path.join(root, 'home'),
  DATA_DIR: data,
  AM_LOCAL: local,
  CODEX_HOME: path.join(local, 'codex'),
  CODEX_DURABLE: path.join(data, 'state/codex'),
  CLAUDE_CONFIG_DIR: path.join(local, 'claude'),
  CLAUDE_DURABLE: path.join(data, 'state/claude'),
  GEMINI_CLI_HOME: path.join(local, 'gemini-home'),
  GEMINI_LIVE: path.join(local, 'gemini-home/.gemini'),
  GEMINI_DURABLE: path.join(data, 'state/gemini'),
  OPENCLAW_STATE_DIR: path.join(local, 'openclaw'),
  OPENCLAW_DURABLE: path.join(data, 'state/openclaw'),
  OPENCODE_LIVE: path.join(local, 'opencode'),
  OPENCODE_DURABLE: path.join(data, 'state/opencode'),
  HERMES_LIVE: path.join(local, 'hermes'),
  HERMES_DURABLE: path.join(data, 'state/hermes'),
  FX_LIVE: path.join(local, 'fx-home'),
  FX_DURABLE: path.join(data, 'state/fx'),
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const put = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const run = (mode, options = {}) => execFileSync('sh', [script, mode], {
  env, encoding: 'utf8', stdio: options.stdio || 'pipe',
});
const sql = (db, statement) => execFileSync('sqlite3', [db, statement], { encoding: 'utf8' }).trim();
const waitFor = (child, marker) => new Promise((resolve, reject) => {
  let out = '';
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}: ${out}`)), 5000);
  child.stdout.on('data', (chunk) => {
    out += chunk;
    if (out.includes(marker)) { clearTimeout(timer); resolve(); }
  });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`sqlite writer exited ${code}: ${out}`)); });
});

try {
  execFileSync('sh', ['-n', script]);
  check('checkpoint helper has valid POSIX shell syntax', true);

  const codexRel = 'sessions/2026/08/04/rollout-test.jsonl';
  const claudeRel = 'projects/work/session.jsonl';
  const geminiRel = 'tmp/work/chats/session-test.jsonl';
  const clawRel = 'agents/main/sessions/session.jsonl';
  const fxRel = 'sessions/1787565046083-1787565046083966744-936b6f5838945f4a/events.jsonl';
  put(path.join(env.CODEX_DURABLE, codexRel), '{"turn":1}\n');
  put(path.join(env.CLAUDE_DURABLE, claudeRel), '{"turn":1}\n');
  put(path.join(env.GEMINI_DURABLE, geminiRel), '{"turn":1}\n');
  put(path.join(env.OPENCLAW_DURABLE, clawRel), '{"turn":1}\n');
  put(path.join(env.FX_DURABLE, fxRel), '{"kind":"session_started"}\n');
  // A durable tree written before the excludes existed can still hold these.
  put(path.join(env.FX_DURABLE, 'sessions/1787565046083-1787565046083966744-936b6f5838945f4a/session.lock'), 'pid\n');
  put(path.join(env.FX_DURABLE, 'sessions/index.pending'), 'partial\n');

  run('restore');
  check('Codex rollout restores to a real local directory',
    fs.readFileSync(path.join(env.CODEX_HOME, codexRel), 'utf8') === '{"turn":1}\n'
      && !fs.lstatSync(path.join(env.CODEX_HOME, 'sessions')).isSymbolicLink());
  check('Claude transcript restores locally',
    fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, claudeRel), 'utf8') === '{"turn":1}\n');
  check('Gemini transcript restores under GEMINI_CLI_HOME',
    fs.readFileSync(path.join(env.GEMINI_LIVE, geminiRel), 'utf8') === '{"turn":1}\n');
  check('OpenClaw transcript restores locally',
    fs.readFileSync(path.join(env.OPENCLAW_STATE_DIR, clawRel), 'utf8') === '{"turn":1}\n');
  check('fx transcript restores locally',
    fs.readFileSync(path.join(env.FX_LIVE, fxRel), 'utf8') === '{"kind":"session_started"}\n');
  // A lock names a process that died with the old container, and the pending
  // index is half-written — restoring either hands fx state nobody holds.
  check('fx locks are not restored',
    !fs.existsSync(path.join(env.FX_LIVE, 'sessions/1787565046083-1787565046083966744-936b6f5838945f4a/session.lock')));
  check('fx pending index is not restored',
    !fs.existsSync(path.join(env.FX_LIVE, 'sessions/index.pending')));

  // Re-running entrypoint in the same container must not replace newer live
  // state with an older bucket checkpoint.
  const liveClaude = path.join(env.CLAUDE_CONFIG_DIR, claudeRel);
  const durableClaude = path.join(env.CLAUDE_DURABLE, claudeRel);
  put(durableClaude, '{"turn":"stale"}\n');
  put(liveClaude, '{"turn":"new-local"}\n');
  const now = Date.now() / 1000;
  fs.utimesSync(durableClaude, now - 60, now - 60);
  fs.utimesSync(liveClaude, now, now);
  run('restore');
  check('hot restart preserves newer local state',
    fs.readFileSync(liveClaude, 'utf8') === '{"turn":"new-local"}\n');

  // A first deployment can inherit a populated local tree but have no local
  // timestamp yet. Restore must force that tree through one checkpoint instead
  // of assuming every byte came from the durable side.
  fs.rmSync(path.join(local, 'agent-state-stamps/claude'));
  run('restore');
  run('checkpoint');
  check('first checkpoint captures pre-existing newer local state',
    fs.readFileSync(durableClaude, 'utf8') === '{"turn":"new-local"}\n');

  // SQLite-backed harnesses also have ordinary files (setup/auth/config)
  // before their database is first created. Those files must not disappear
  // merely because there is no database to snapshot yet.
  const openPreDb = path.join(env.OPENCODE_LIVE, 'setup.json');
  const hermesPreDb = path.join(env.HERMES_LIVE, 'config.yaml');
  put(openPreDb, '{"configured":true}\n');
  put(hermesPreDb, 'configured: true\n');
  run('checkpoint');
  check('opencode ordinary files checkpoint before opencode.db exists',
    fs.readFileSync(path.join(env.OPENCODE_DURABLE, 'setup.json'), 'utf8') === '{"configured":true}\n');
  check('Hermes ordinary files checkpoint before state.db exists',
    fs.readFileSync(path.join(env.HERMES_DURABLE, 'config.yaml'), 'utf8') === 'configured: true\n');

  // fx: the credential and the transcript must reach the bucket; its live locks
  // must not, or a restored container starts against a lock nobody holds.
  put(path.join(env.FX_LIVE, 'auth.json'), '{"token":"x"}\n');
  put(path.join(env.FX_LIVE, 'sessions/s1/events.jsonl'), '{"kind":"history_turn_committed"}\n');
  put(path.join(env.FX_LIVE, 'sessions/s1/commit.lock'), 'pid\n');
  put(path.join(env.FX_LIVE, 'sessions/s1/subagent/subagent-control.lock'), 'pid\n');
  put(path.join(env.FX_LIVE, 'sessions/index.pending'), 'partial\n');
  // Drop the copy the restore fixture above planted durably, so this asserts
  // what the checkpoint just wrote rather than what was already there.
  fs.rmSync(path.join(env.FX_DURABLE, 'sessions/index.pending'), { force: true });
  run('checkpoint');
  check('fx auth checkpoints to the bucket',
    fs.readFileSync(path.join(env.FX_DURABLE, 'auth.json'), 'utf8') === '{"token":"x"}\n');
  check('fx transcript checkpoints to the bucket',
    fs.readFileSync(path.join(env.FX_DURABLE, 'sessions/s1/events.jsonl'), 'utf8') === '{"kind":"history_turn_committed"}\n');
  check('fx locks stay out of the bucket',
    !fs.existsSync(path.join(env.FX_DURABLE, 'sessions/s1/commit.lock'))
      && !fs.existsSync(path.join(env.FX_DURABLE, 'sessions/s1/subagent/subagent-control.lock')));
  check('fx pending index stays out of the bucket',
    !fs.existsSync(path.join(env.FX_DURABLE, 'sessions/index.pending')));

  // --files-from supplies descendants explicitly: a directory-only exclusion
  // does not protect the mounted bucket from Codex's temporary plugin files.
  const scratch = ['.tmp/plugins/_common.py', 'plugins/cache/blob',
    'cache/blob', 'nested/.tmp/blob', 'mcp-oauth-locks/pid', 'db-backups/old'];
  for (const rel of scratch) put(path.join(env.CODEX_HOME, rel), 'temporary');
  put(path.join(env.CODEX_HOME, 'config.toml'), 'model = "fixture"\n');
  run('checkpoint');
  check('Codex scratch descendants stay out of file-list checkpoints',
    scratch.every(rel => !fs.existsSync(path.join(env.CODEX_DURABLE, rel))));
  check('Codex configuration still checkpoints alongside scratch files',
    fs.readFileSync(path.join(env.CODEX_DURABLE, 'config.toml'), 'utf8') === 'model = "fixture"\n');
  // Older versions may already have copied scratch state to the bucket.
  for (const rel of scratch) {
    fs.rmSync(path.join(env.CODEX_HOME, rel));
    put(path.join(env.CODEX_DURABLE, rel), 'old temporary');
  }
  run('restore');
  check('legacy Codex scratch descendants are not restored',
    scratch.every(rel => !fs.existsSync(path.join(env.CODEX_HOME, rel))));

  // Reproduce the Codex access pattern: append while holding the canonical
  // rollout FD open. Because the canonical file is now local, a different
  // process can checkpoint the visible bytes without waiting for close.
  const liveRollout = path.join(env.CODEX_HOME, codexRel);
  const held = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const fd = fs.openSync(process.argv[1], 'a');
    fs.writeSync(fd, '{"turn":2}\\n');
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `, liveRollout], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitFor(held, 'ready');
  run('checkpoint');
  check('open Codex rollout bytes reach a closed durable checkpoint',
    fs.readFileSync(path.join(env.CODEX_DURABLE, codexRel), 'utf8').endsWith('{"turn":2}\n'));
  held.kill('SIGKILL');

  fs.rmSync(env.CODEX_HOME, { recursive: true, force: true });
  run('restore');
  check('rollout survives writer crash and fresh-local restore',
    fs.readFileSync(path.join(env.CODEX_HOME, codexRel), 'utf8').endsWith('{"turn":2}\n'));

  // Keep an opencode writer alive in WAL mode. A raw copy can observe the DB
  // and WAL at different instants; SQLite .backup must still yield one valid
  // database containing the committed row.
  fs.mkdirSync(env.OPENCODE_LIVE, { recursive: true });
  const openDb = path.join(env.OPENCODE_LIVE, 'opencode.db');
  const writer = spawn('sqlite3', [openDb], { stdio: ['pipe', 'pipe', 'pipe'] });
  writer.stdin.write('PRAGMA journal_mode=WAL;\n');
  writer.stdin.write('PRAGMA wal_autocheckpoint=0;\n');
  writer.stdin.write('CREATE TABLE message(id INTEGER PRIMARY KEY, body TEXT);\n');
  writer.stdin.write("INSERT INTO message(body) VALUES ('survives');\n");
  writer.stdin.write('.print writer-ready\n');
  await waitFor(writer, 'writer-ready');
  run('checkpoint');

  const openCheckpoint = path.join(env.OPENCODE_DURABLE, 'checkpoints/opencode.db');
  check('opencode online backup is structurally valid', sql(openCheckpoint, 'PRAGMA quick_check;') === 'ok');
  check('opencode online backup includes committed WAL content',
    sql(openCheckpoint, 'SELECT body FROM message;') === 'survives');
  check('opencode checkpoint publishes no WAL/SHM companions',
    !fs.existsSync(`${openCheckpoint}-wal`) && !fs.existsSync(`${openCheckpoint}-shm`));
  const idleMarker = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(openCheckpoint, idleMarker, idleMarker);
  run('checkpoint');
  check('idle SQLite database does not generate another durable write',
    fs.statSync(openCheckpoint).mtimeMs === idleMarker.getTime());
  const writerExited = new Promise((resolve) => writer.once('exit', resolve));
  writer.stdin.end();
  await writerExited;

  sql(openDb, "INSERT INTO message(body) VALUES ('newer-local');");
  run('restore');
  check('hot restart does not replace a newer valid local SQLite database',
    sql(openDb, 'SELECT count(*) FROM message;') === '2');

  fs.mkdirSync(env.HERMES_LIVE, { recursive: true });
  const hermesDb = path.join(env.HERMES_LIVE, 'state.db');
  sql(hermesDb, 'CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES (\'hello\');');
  run('checkpoint');
  const hermesCheckpoint = path.join(env.HERMES_DURABLE, 'checkpoints/state.db');
  check('Hermes uses the same verified SQLite checkpoint adapter',
    sql(hermesCheckpoint, 'SELECT body FROM messages;') === 'hello');

  // A bad live DB must not replace the last known-good durable checkpoint.
  const openRowsBeforeCorruption = sql(openCheckpoint, 'SELECT body FROM message ORDER BY id;');
  fs.writeFileSync(openDb, 'not a database');
  let badFailed = false;
  try { run('checkpoint'); } catch { badFailed = true; }
  check('invalid live SQLite makes the checkpoint fail closed', badFailed);
  check('failed SQLite checkpoint leaves prior durable snapshot intact',
    sql(openCheckpoint, 'SELECT body FROM message ORDER BY id;') === openRowsBeforeCorruption);

  fs.rmSync(env.OPENCODE_LIVE, { recursive: true, force: true });
  run('restore');
  check('SQLite snapshot restores without stale WAL state',
    sql(path.join(env.OPENCODE_LIVE, 'opencode.db'), 'SELECT body FROM message ORDER BY id;') === openRowsBeforeCorruption
      && !fs.existsSync(path.join(env.OPENCODE_LIVE, 'opencode.db-wal')));
  // rsync exit 24 = "partial transfer due to vanished source files". A restore
  // walks the bucket for minutes while a harness prunes its transcript scratch,
  // so the listing names files that are gone by the time they are read. This
  // once aborted the boot outright. Exit code handling is pinned with a stub so
  // the check does not depend on winning a race against a real transfer; a
  // fresh DATA_DIR keeps the strict single-file SQLite copies out of the way.
  const vanishRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'am-agent-state-24-'));
  const stubDir = path.join(vanishRoot, 'bin');
  const stubRsync = (code) => {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'rsync'), [
      '#!/bin/sh',
      'echo \'file has vanished: "tool-results/toolu_01.txt"\' >&2',
      `echo 'rsync warning: vanished/error stub (code ${code})' >&2`,
      `exit ${code}`,
    ].join('\n'));
    fs.chmodSync(path.join(stubDir, 'rsync'), 0o755);
  };
  const restoreStatus = (code) => {
    stubRsync(code);
    const stubEnv = { ...env, PATH: `${stubDir}:${env.PATH}` };
    for (const [key, value] of Object.entries(stubEnv)) {
      if (typeof value === 'string' && value.startsWith(root)) {
        stubEnv[key] = value.replace(root, vanishRoot);
      }
    }
    try {
      execFileSync('sh', [script, 'restore'], { env: stubEnv, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, local: stubEnv.AM_LOCAL };
    } catch (error) {
      return { status: error.status ?? 1, local: stubEnv.AM_LOCAL };
    }
  };

  const vanished = restoreStatus(24);
  check('restore survives rsync vanished-source warning (exit 24)', vanished.status === 0);
  check('a tolerated exit 24 still takes the restore success path',
    fs.existsSync(path.join(vanished.local, 'agent-state-stamps/claude')));
  check('restore still fails on a genuine rsync error (exit 23)',
    restoreStatus(23).status === 1);
  fs.rmSync(vanishRoot, { recursive: true, force: true });

  // ---------- boot speed: progress, junk, parallel slices ----------
  // Each block gets its own roots. Every path the script reads is set
  // explicitly, so nothing here can reach the container's real agent state
  // (the Space exports its own CODEX_HOME, *_DURABLE, … to every shell).
  const fresh = (label) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), `am-agent-state-${label}-`));
    const e = { ...env };
    for (const [key, value] of Object.entries(e)) {
      if (typeof value === 'string' && value.startsWith(root)) e[key] = value.replace(root, r);
    }
    return { r, e };
  };
  // An rsync that sleeps first, or fails for one slice only, and otherwise is
  // the real one — so a failure sits in ONE branch of the parallel pool. With
  // STUB_TRACE set it also records each run as a read of the mount (an
  // argument under STUB_MOUNT, i.e. $DATA_DIR) or of anything else, and how
  // many runs of that kind were in flight when it started.
  const realRsync = execFileSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).trim();
  const wrapRsync = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rsync'), [
      '#!/bin/sh',
      'if [ -n "${STUB_TRACE:-}" ]; then',
      '  kind=other',
      '  for a in "$@"; do case "$a" in "$STUB_MOUNT"/*) kind=mount ;; esac; done',
      '  mkdir -p "$STUB_TRACE/$kind"; mkdir "$STUB_TRACE/$kind/live.$$"',
      '  ls -d "$STUB_TRACE/$kind"/live.* | wc -l | tr -d " " >> "$STUB_TRACE/$kind.inflight"',
      'fi',
      '[ -n "${STUB_SLEEP:-}" ] && sleep "$STUB_SLEEP"',
      'if [ -n "${STUB_FAIL_MATCH:-}" ]; then',
      '  for a in "$@"; do case "$a" in *"$STUB_FAIL_MATCH"*) echo "stub: failing $a" >&2; exit 23 ;; esac; done',
      'fi',
      `${realRsync} "$@"; rc=$?`,
      '[ -n "${STUB_TRACE:-}" ] && rmdir "$STUB_TRACE/$kind/live.$$"',
      'exit $rc',
    ].join('\n'));
    fs.chmodSync(path.join(dir, 'rsync'), 0o755);
  };
  // Per kind of rsync (mount / other): how many ran, and the most at once.
  const rsyncTrace = (dir, kind) => {
    const f = path.join(dir, `${kind}.inflight`);
    const counts = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(Number) : [];
    return { runs: counts.length, most: Math.max(0, ...counts) };
  };
  // The bucket API, faked: `hf` in dir, serving the fixture's own $DATA_DIR
  // as bucket test/bucket. Returns the env that routes a restore through it.
  const fakeHf = (dir, e) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(here, 'fixtures/fake-hf.py'), path.join(dir, 'hf'));
    fs.chmodSync(path.join(dir, 'hf'), 0o755);
    return { AGENT_STATE_BUCKET: 'test/bucket', FAKE_BUCKET_ROOT: e.DATA_DIR, FAKE_HF_LOG: path.join(dir, 'hf.log') };
  };
  // Run a mode with stdout+stderr to a file, so what is printed AFTER it exits
  // (a heartbeat that outlived it) is visible.
  const runTo = (e, mode, outFile, extra = {}) => {
    const fd = fs.openSync(outFile, 'w');
    const child = spawn('sh', [script, mode], { env: { ...e, ...extra }, stdio: ['ignore', fd, fd] });
    const done = new Promise((resolve) => child.on('exit', (code, signal) => { fs.closeSync(fd); resolve({ code, signal }); }));
    return { child, done };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Every process whose command line names `needle` (a fixture root): the
  // restore's workers carry their paths in their arguments.
  const processesNaming = (needle) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).flatMap((pid) => {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return cmd.includes(needle) && Number(pid) !== process.pid ? [`${pid}: ${cmd.slice(0, 80)}`] : [];
    } catch { return []; }
  });
  const quietAfter = async (file, ms) => {
    const before = fs.readFileSync(file, 'utf8');
    await sleep(ms);
    return fs.readFileSync(file, 'utf8') === before;
  };

  {
    // Progress lines, and a heartbeat that stops with the restore.
    const { r, e } = fresh('progress');
    // Through the (fake) bucket API: only copies from its local mirror are
    // split into a parallel pool.
    const bin = path.join(r, 'bin'); wrapRsync(bin);
    for (let i = 0; i < 30; i++) put(path.join(e.CLAUDE_DURABLE, `projects/p${i % 3}/s${i}.jsonl`), `{"n":${i}}\n`);
    put(path.join(e.CODEX_DURABLE, 'sessions/2026/10/15/rollout.jsonl'), '{}\n');
    const slow = { ...fakeHf(bin, e), PATH: `${bin}:${e.PATH}`, STUB_SLEEP: '1.2', AGENT_STATE_HEARTBEAT: '1' };
    const out = path.join(r, 'out.txt');
    const res = await runTo(e, 'restore', out, slow).done;
    const text = fs.readFileSync(out, 'utf8');
    check('restore reports each adapter starting and finishing',
      res.code === 0 && /agent-state: restoring claude…/.test(text)
        && /agent-state: claude done: 30 files, \S+ in \d+s/.test(text)
        && /agent-state: codex done: 1 files/.test(text), text.slice(0, 500));
    check('a heartbeat reports local progress while the restore runs',
      /agent-state: still restoring after \d+s \(\S+ of the budget left\): .*files on local disk so far/.test(text), text.slice(0, 500));
    check('the heartbeat stops when the restore succeeds', await quietAfter(out, 2500));

    // …when it fails…
    fs.rmSync(e.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
    const outFail = path.join(r, 'out-fail.txt');
    const failed = await runTo(e, 'restore', outFail, { ...slow, STUB_FAIL_MATCH: '/p1/' }).done;
    const failText = fs.readFileSync(outFail, 'utf8');
    check('one failed slice of the parallel pool fails the whole restore', failed.code === 1, failText.slice(-300));
    check('…names the adapter it failed in', /agent-state: claude FAILED after/.test(failText), failText.slice(-300));
    check('…while the other slices still ran', fs.existsSync(path.join(e.CLAUDE_CONFIG_DIR, 'projects/p0/s0.jsonl')));
    check('the heartbeat stops when the restore fails', await quietAfter(outFail, 2500));

    // …and when it is killed: the restore's whole worker tree — xargs, slice
    // shells, rsyncs, sleeps — must be gone, not just quiet. Two proofs: its
    // stdout pipe reaches EOF (every process holding it has exited), and no
    // process anywhere still names this fixture on its command line.
    fs.rmSync(e.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
    // The stubbed rsyncs sleep far longer than the checks below wait, so a
    // worker that survived the TERM is still there to be seen — not one that
    // merely finished on its own in the meantime.
    const kill = spawn('sh', [script, 'restore'], { env: { ...e, ...slow, STUB_SLEEP: '25' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let killOut = '';
    kill.stdout.on('data', (chunk) => { killOut += chunk; });
    const eof = new Promise((resolve) => kill.stdout.on('close', () => resolve(true)));
    const exited = new Promise((resolve) => kill.on('exit', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 60 && !/still restoring/.test(killOut); i++) await sleep(100);
    const workersBefore = processesNaming(r).length;
    kill.kill('SIGTERM');
    const k = await exited;
    const leftovers = processesNaming(r);
    const closed = await Promise.race([eof, sleep(4000).then(() => false)]);
    check('a TERM ends the restore with a failure status', k.code !== 0, JSON.stringify(k));
    check('…its stdout reaches EOF: no worker is left holding it', closed === true);
    check('…and no xargs, slice shell, rsync or sleep of it is left running',
      workersBefore > 0 && leftovers.length === 0, `${workersBefore} before; left: ${leftovers.join(' | ')}`);
    fs.rmSync(r, { recursive: true, force: true });
  }

  {
    // Junk stays out in both directions; what sits near it stays in.
    const { r, e } = fresh('junk');
    const junk = ['tmp/arg0/codex-arg0AbC/.lock', 'plugins/.remote-plugin-install-staging/x.tar', 'plugins/cache/openai/p/manifest.json'];
    const keep = ['config.toml', 'sessions/2026/10/15/tmp/rollout.jsonl', 'plugins/my-plugin.toml'];
    for (const rel of [...junk, ...keep]) put(path.join(e.CODEX_DURABLE, rel), 'x');
    const stamps = Array.from({ length: 8 }, (_, i) => 1792000000000 + i * 1000);
    for (const s of stamps) put(path.join(e.CLAUDE_DURABLE, `backups/.claude.json.backup.${s}`), `${s}`);
    put(path.join(e.CLAUDE_DURABLE, 'file-history/sess/abc@v1'), 'before edit');
    execFileSync('sh', [script, 'restore'], { env: e });
    check('Codex tmp/, plugin cache and install staging are not restored',
      junk.every((rel) => !fs.existsSync(path.join(e.CODEX_HOME, rel))));
    check('a nested tmp/, and plugin config beside the cache, still are',
      keep.every((rel) => fs.existsSync(path.join(e.CODEX_HOME, rel))));
    const restoredBackups = fs.readdirSync(path.join(e.CLAUDE_CONFIG_DIR, 'backups')).sort();
    check('only the newest five Claude config backups come back',
      JSON.stringify(restoredBackups) === JSON.stringify(stamps.slice(-5).map((s) => `.claude.json.backup.${s}`)), restoredBackups.join(','));
    check('Claude file-history (what /rewind restores from) is restored',
      fs.existsSync(path.join(e.CLAUDE_CONFIG_DIR, 'file-history/sess/abc@v1')));
    for (const rel of junk) { fs.rmSync(path.join(e.CODEX_DURABLE, rel)); put(path.join(e.CODEX_HOME, rel), 'new junk'); }
    execFileSync('sh', [script, 'checkpoint'], { env: e });
    check('Codex junk written locally is not checkpointed either',
      junk.every((rel) => !fs.existsSync(path.join(e.CODEX_DURABLE, rel))));
    fs.rmSync(r, { recursive: true, force: true });
  }

  {
    // The prune deletes the excluded junk, and only it.
    const { r, e } = fresh('prune');
    const junk = ['.tmp/plugins/a.py', 'tmp/arg0/x/.lock', 'tmp/empty', 'mcp-oauth-locks/pid',
      'plugins/cache/openai/p/m.json', 'plugins/.remote-plugin-install-staging/s'];
    const keep = ['config.toml', 'auth.json', 'sessions/2026/10/15/tmp/rollout.jsonl', 'plugins/my-plugin.toml',
      'db-backups/am-quarantine/logs_2.sqlite'];
    for (const rel of [...junk, ...keep]) put(path.join(e.CODEX_DURABLE, rel), 'x');
    // A symlink named like a junk directory, pointing at data that must
    // survive — and one INSIDE a junk directory, pointing out of it.
    const outside = path.join(r, 'outside');
    put(path.join(outside, 'precious.txt'), 'keep me');
    fs.symlinkSync(outside, path.join(e.CODEX_DURABLE, 'cache'));
    fs.symlinkSync(outside, path.join(e.CODEX_DURABLE, 'tmp/arg0/link'));
    const stamps = Array.from({ length: 8 }, (_, i) => 1792000000000 + i * 1000);
    for (const s of stamps) put(path.join(e.CLAUDE_DURABLE, `backups/.claude.json.backup.${s}`), `${s}`);
    put(path.join(e.CLAUDE_DURABLE, 'backups/notes.txt'), 'not a backup');
    put(path.join(e.CLAUDE_DURABLE, 'file-history/sess/abc@v1'), 'before edit');
    put(path.join(e.CLAUDE_DURABLE, 'projects/p/s.jsonl'), '{}');
    const out = execFileSync('sh', [script, 'prune'], { env: e, encoding: 'utf8' });
    check('prune removes the excluded Codex junk from the durable side',
      junk.every((rel) => !fs.existsSync(path.join(e.CODEX_DURABLE, rel))), out);
    check('prune keeps everything that is not excluded',
      keep.every((rel) => fs.existsSync(path.join(e.CODEX_DURABLE, rel)))
        && fs.existsSync(path.join(e.CLAUDE_DURABLE, 'file-history/sess/abc@v1'))
        && fs.existsSync(path.join(e.CLAUDE_DURABLE, 'projects/p/s.jsonl'))
        && fs.existsSync(path.join(e.CLAUDE_DURABLE, 'backups/notes.txt')));
    check('prune never follows a symlink, at the top or inside a junk tree',
      fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8') === 'keep me'
        && fs.lstatSync(path.join(e.CODEX_DURABLE, 'cache')).isSymbolicLink(), out);
    const left = fs.readdirSync(path.join(e.CLAUDE_DURABLE, 'backups')).filter((n) => n.startsWith('.claude.json.backup.')).sort();
    check('prune keeps the newest five Claude config backups',
      JSON.stringify(left) === JSON.stringify(stamps.slice(-5).map((s) => `.claude.json.backup.${s}`)), left.join(','));
    check('prune says what it removed', /prune: removed \d+ junk files/.test(out), out);

    // Serialised with checkpoints: while a checkpoint holds the lock, the
    // prune deletes nothing — and a backup that checkpoint publishes before
    // letting go is ranked with the rest, not deleted as "old".
    for (const rel of junk) put(path.join(e.CODEX_DURABLE, rel), 'x');
    const lockFile = path.join(e.AM_LOCAL, 'agent-state-checkpoint.lock');
    fs.mkdirSync(e.AM_LOCAL, { recursive: true });
    const holder = spawn('flock', [lockFile, 'sh', '-c', 'echo held; sleep 30'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(holder, 'held');
    const prune = spawn('sh', [script, 'prune'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let pruneOut = '';
    prune.stdout.on('data', (c) => { pruneOut += c; });
    const pruneDone = new Promise((resolve) => prune.on('exit', (code) => resolve(code)));
    await sleep(1500);
    check('prune waits while a checkpoint holds the lock, deleting nothing',
      prune.exitCode === null && junk.every((rel) => fs.existsSync(path.join(e.CODEX_DURABLE, rel))), pruneOut);
    const newest = 1793000000000;
    put(path.join(e.CLAUDE_DURABLE, `backups/.claude.json.backup.${newest}`), 'just published');
    holder.kill('SIGKILL');
    const pruneCode = await pruneDone;
    const afterRace = fs.readdirSync(path.join(e.CLAUDE_DURABLE, 'backups')).filter((n) => n.startsWith('.claude.json.backup.')).sort();
    check('…then prunes once the checkpoint lets go',
      pruneCode === 0 && junk.every((rel) => !fs.existsSync(path.join(e.CODEX_DURABLE, rel))), pruneOut);
    // At shutdown the entrypoint stops a running prune (stop-prune) before the
    // final checkpoint: its whole group goes, and the lock is free at once.
    for (const rel of junk) put(path.join(e.CODEX_DURABLE, rel), 'x');
    const holder2 = spawn('flock', [lockFile, 'sh', '-c', 'echo held; sleep 30'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(holder2, 'held');
    const running = spawn('setsid', ['-w', 'sh', script, 'prune'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    const runningDone = new Promise((resolve) => running.on('exit', resolve));
    for (let i = 0; i < 50 && !fs.existsSync(path.join(e.AM_LOCAL, 'agent-state-prune.pgid')); i++) await sleep(100);
    const pruneGroup = fs.readFileSync(path.join(e.AM_LOCAL, 'agent-state-prune.pgid'), 'utf8').trim();
    const inGroup = (g) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((pid) => {
      try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[2] === g; } catch { return false; }
    });
    const groupBefore = inGroup(pruneGroup).length;
    const stopped = execFileSync('sh', [script, 'stop-prune'], { env: e, encoding: 'utf8' });
    await Promise.race([runningDone, sleep(5000)]);
    holder2.kill('SIGKILL');
    check('stop-prune ends a running prune and every process of it',
      groupBefore > 0 && inGroup(pruneGroup).length === 0 && /stopped the junk prune/.test(stopped), `${groupBefore} in group before; ${stopped}`);
    check('…before it deleted anything it was still waiting to',
      junk.every((rel) => fs.existsSync(path.join(e.CODEX_DURABLE, rel))));
    check('…and leaves no stale group id behind', !fs.existsSync(path.join(e.AM_LOCAL, 'agent-state-prune.pgid')));
    check('stop-prune with no prune running is a no-op',
      execFileSync('sh', [script, 'stop-prune'], { env: e, encoding: 'utf8' }) === '');

    check('…keeping a backup the checkpoint published meanwhile as one of the newest five',
      afterRace.length === 5 && afterRace.includes(`.claude.json.backup.${newest}`), afterRace.join(','));

    const { r: r2, e: e2 } = fresh('prune-cap');
    for (let i = 0; i < 10; i++) put(path.join(e2.CODEX_DURABLE, `tmp/f${i}`), 'x');
    const capped = execFileSync('sh', [script, 'prune'], { env: { ...e2, AGENT_STATE_PRUNE_MAX: '4' }, encoding: 'utf8' });
    check('prune is bounded, and says the rest waits for the next boot',
      fs.readdirSync(path.join(e2.CODEX_DURABLE, 'tmp')).length === 6 && /stopped at 4 files/.test(capped), capped);
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(r2, { recursive: true, force: true });
  }

  {
    // A restore never writes into a tree a live process has a file open in:
    // rsync replaces by rename, and that process would go on writing to an
    // unlinked inode no checkpoint ever sees.
    const { r, e } = fresh('open');
    put(path.join(e.CLAUDE_DURABLE, 'projects/p/s.jsonl'), 'durable');
    const held = path.join(e.CLAUDE_CONFIG_DIR, 'projects/p/s.jsonl');
    put(held, 'live');
    const holder = spawn(process.execPath, ['-e', `
      require('fs').openSync(process.argv[1], 'a'); process.stdout.write('open\\n'); setInterval(() => {}, 1000);
    `, held], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(holder, 'open');
    let refused = null;
    try { execFileSync('sh', [script, 'restore'], { env: e, encoding: 'utf8', stdio: 'pipe' }); } catch (error) { refused = error; }
    check('restore refuses while a process holds a file open in a live tree',
      refused?.status === 1 && /refusing to restore/.test(refused.stderr) && refused.stderr.includes(held), refused?.stderr);
    // The entrypoint must still boot: it warns and restores.
    const boot = execFileSync('sh', [script, 'restore'], { env: { ...e, AGENT_STATE_FROM_ENTRYPOINT: '1' }, encoding: 'utf8', stdio: 'pipe' });
    check('the entrypoint\'s restore warns about open files but still boots', typeof boot === 'string');
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    const ok = execFileSync('sh', [script, 'restore'], { env: e, encoding: 'utf8', stdio: 'pipe' });
    check('…and restores once nothing holds it', fs.existsSync(held));
    check('a restore not started by the entrypoint says so', /WARNING: restore was not started by the entrypoint/.test(ok), ok);
    const quiet = execFileSync('sh', [script, 'restore'], { env: { ...e, AGENT_STATE_FROM_ENTRYPOINT: '1' }, encoding: 'utf8', stdio: 'pipe' });
    check('…and the entrypoint\'s own restore does not', !/WARNING/.test(quiet), quiet);
    fs.rmSync(r, { recursive: true, force: true });
  }

  // A hot restart through the parallel slices still keeps newer local state,
  // with a pool (from the API mirror, whose mtimes come from the bucket's) and
  // without one.
  for (const jobs of ['6', '1']) {
    const { r, e } = fresh(`hot-${jobs}`);
    const rel = 'projects/work/session.jsonl';
    put(path.join(e.CLAUDE_DURABLE, rel), 'stale');
    put(path.join(e.CLAUDE_CONFIG_DIR, rel), 'new-local');
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(e.CLAUDE_DURABLE, rel), t - 60, t - 60);
    fs.utimesSync(path.join(e.CLAUDE_CONFIG_DIR, rel), t, t);
    put(path.join(e.CLAUDE_DURABLE, 'projects/other/a.jsonl'), 'restored');
    const bin = path.join(r, 'bin');
    const api = jobs === '1' ? {} : { ...fakeHf(bin, e), PATH: `${bin}:${e.PATH}` };
    execFileSync('sh', [script, 'restore'], { env: { ...e, ...api, AGENT_STATE_JOBS: jobs } });
    check(`hot restart keeps newer local state through ${jobs === '1' ? 'one rsync' : 'parallel slices'}`,
      fs.readFileSync(path.join(e.CLAUDE_CONFIG_DIR, rel), 'utf8') === 'new-local'
        && fs.readFileSync(path.join(e.CLAUDE_CONFIG_DIR, 'projects/other/a.jsonl'), 'utf8') === 'restored');
    fs.rmSync(r, { recursive: true, force: true });
  }

  // ---------- the bucket API route, its fallbacks, and the time budget ----------
  // A fake `hf` (fixtures/fake-hf.py) serves each fixture's own $DATA_DIR as
  // the bucket, so the API and the mount hold the same files, and the traced
  // rsync tells which one a restore read: an rsync naming $DATA_DIR is a
  // direct mount read; one from the mirror is not.
  let apiRuns = 0;
  const apiFixture = (label) => {
    const { r, e } = fresh(label);
    const bin = path.join(r, 'bin'); wrapRsync(bin);
    const trace = path.join(r, 'trace');
    const api = { ...fakeHf(bin, e), PATH: `${bin}:${e.PATH}`, STUB_TRACE: trace, STUB_MOUNT: e.DATA_DIR };
    const stamps = Array.from({ length: 8 }, (_, i) => 1792000000000 + i * 1000);
    for (const s of stamps) put(path.join(e.CLAUDE_DURABLE, `backups/.claude.json.backup.${s}`), `${s}`);
    for (let i = 0; i < 6; i++) put(path.join(e.CLAUDE_DURABLE, `projects/p${i}/s.jsonl`), `{"p":${i}}\n`);
    put(path.join(e.CODEX_DURABLE, 'sessions/2026/10/19/rollout.jsonl'), '{"turn":1}\n');
    put(path.join(e.CODEX_DURABLE, 'mcp-oauth-locks/4242'), 'pid');
    put(path.join(e.CODEX_DURABLE, 'logs_1.db'), 'not restored');
    put(path.join(e.FX_DURABLE, 'sessions/s1/events.jsonl'), '{}\n');
    put(path.join(e.FX_DURABLE, 'sessions/s1/session.lock'), 'pid');
    put(path.join(e.GEMINI_DURABLE, 'settings.json'), '{}');
    put(path.join(e.OPENCLAW_DURABLE, 'agents/main/sessions/s.jsonl'), '{}');
    for (const [dir, name] of [[e.OPENCODE_DURABLE, 'opencode.db'], [e.HERMES_DURABLE, 'state.db']]) {
      fs.mkdirSync(path.join(dir, 'checkpoints'), { recursive: true });
      sql(path.join(dir, 'checkpoints', name), 'create table t(x); insert into t values (42);');
    }
    const restored = () => fs.existsSync(path.join(e.CODEX_HOME, 'sessions/2026/10/19/rollout.jsonl'))
      && fs.existsSync(path.join(e.CLAUDE_CONFIG_DIR, 'projects/p5/s.jsonl'))
      && fs.existsSync(path.join(e.FX_LIVE, 'sessions/s1/events.jsonl'))
      && fs.existsSync(path.join(e.GEMINI_LIVE, 'settings.json'))
      && fs.existsSync(path.join(e.OPENCLAW_STATE_DIR, 'agents/main/sessions/s.jsonl'))
      && sql(path.join(e.OPENCODE_LIVE, 'opencode.db'), 'select x from t') === '42'
      && sql(path.join(e.HERMES_LIVE, 'state.db'), 'select x from t') === '42';
    const backups = () => {
      const dir = path.join(e.CLAUDE_CONFIG_DIR, 'backups');
      return JSON.stringify(fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
        === JSON.stringify(stamps.slice(-5).map((s) => `.claude.json.backup.${s}`));
    };
    const hfLog = () => (fs.existsSync(api.FAKE_HF_LOG) ? fs.readFileSync(api.FAKE_HF_LOG, 'utf8') : '');
    const restore = async (extra = {}) => {
      const out = path.join(r, `out-${++apiRuns}.txt`);
      const t = Date.now();
      const res = await runTo(e, 'restore', out, { ...api, ...extra }).done;
      return { code: res.code, out: fs.readFileSync(out, 'utf8'), secs: (Date.now() - t) / 1000 };
    };
    return { r, e, api, bin, trace, restored, backups, hfLog, restore };
  };

  {
    // The happy path: every adapter over the API, nothing read from the mount.
    const f = apiFixture('api');
    const old = Math.floor(Date.now() / 1000) - 86400;
    fs.utimesSync(path.join(f.e.CLAUDE_DURABLE, 'projects/p0/s.jsonl'), old, old);
    const res = await f.restore({ STUB_SLEEP: '0.3' });
    const log = f.hfLog();
    check('API: the restore succeeds over the bucket API', res.code === 0 && f.restored(), res.out.slice(-800));
    check('API: every adapter is planned and applied over the API',
      (log.match(/ --plan /g) || []).length === 7 && (log.match(/ --apply /g) || []).length === 7, log);
    check('API: nothing is read from the mount directly', rsyncTrace(f.trace, 'mount').runs === 0, JSON.stringify(rsyncTrace(f.trace, 'mount')));
    check('API: copies from the local mirror still run in parallel', rsyncTrace(f.trace, 'other').most > 1, JSON.stringify(rsyncTrace(f.trace, 'other')));
    check('API: exactly the newest five Claude backups come back', f.backups());
    check('API: restored files keep the bucket\'s mtimes',
      Math.abs(fs.statSync(path.join(f.e.CLAUDE_CONFIG_DIR, 'projects/p0/s.jsonl')).mtimeMs / 1000 - old) < 1.5);
    const downloads = log.split('\n').filter((l) => l.startsWith('download '));
    check('API: #180\'s discards are not downloaded (Codex *.db, mcp-oauth-locks, fx locks; old backups)',
      !downloads.some((l) => /logs_1\.db|mcp-oauth-locks|session\.lock/.test(l))
        && downloads.filter((l) => /backups\//.test(l)).length === 5, downloads.join(' | '));
    check('API: the mirror is gone afterwards', !fs.existsSync(path.join(f.e.AM_LOCAL, 'agent-state-mirror')));
    fs.rmSync(f.r, { recursive: true, force: true });
  }

  {
    // No token: the mount, as before the API route, with a hint — and with
    // every direct mount read strictly one at a time across ALL adapters.
    const f = apiFixture('no-token');
    const { AGENT_STATE_BUCKET: _unused, ...noBucket } = f.api;
    const out = path.join(f.r, 'out.txt');
    const res = await runTo(f.e, 'restore', out, { ...noBucket, SPACE_ID: 'test/space', STUB_SLEEP: '0.4', AGENT_STATE_JOBS: '8' }).done;
    const text = fs.readFileSync(out, 'utf8');
    const mount = rsyncTrace(f.trace, 'mount');
    check('no token: restores from the mount, with a hint to add HF_TOKEN',
      res.code === 0 && f.restored() && f.backups() && f.hfLog() === ''
        && /bucket API not usable \(HF_TOKEN is not set; add an HF_TOKEN that can read the bucket/.test(text), text.slice(-800));
    check('mount reads run strictly one at a time across all seven adapters',
      mount.runs >= 7 && mount.most === 1, JSON.stringify(mount));
    fs.rmSync(f.r, { recursive: true, force: true });
  }

  {
    // The API fails (after its retry): that adapter falls back to the mount.
    const f = apiFixture('api-fail');
    const res = await f.restore({ FAKE_HF_SYNC: 'fail', STUB_SLEEP: '0.2' });
    const mount = rsyncTrace(f.trace, 'mount');
    check('API fails → retried, then restored from the mount',
      res.code === 0 && f.restored() && f.backups()
        && /claude: bucket transfer failed, retrying/.test(res.out)
        && /claude: could not fetch from bucket test\/bucket \(exit 1: Error: 503/.test(res.out), res.out.slice(-800));
    check('…with those mount reads one at a time too', mount.runs >= 7 && mount.most === 1, JSON.stringify(mount));
    fs.rmSync(f.r, { recursive: true, force: true });
  }

  for (const [mode, extra, why] of [
    ['fail', {}, /listing the Claude backups failed \(exit 29: Error: 429/],
    ['hang', { AGENT_STATE_API_TIMEOUT: '2' }, /listing the Claude backups timed out/],
    ['garbage', {}, /the Claude backup listing is not a JSON file list/],
  ]) {
    // A backup listing we cannot trust is never read as "no backups": Claude
    // falls back to the mount, which restores the newest five.
    const f = apiFixture(`list-${mode}`);
    const res = await f.restore({ FAKE_HF_LIST: mode, ...extra });
    check(`backup listing ${mode}: Claude falls back to the mount, newest five backups restored`,
      res.code === 0 && f.restored() && f.backups() && why.test(res.out)
        && /claude: could not fetch from bucket/.test(res.out) && /codex: fetched over the bucket API/.test(res.out), res.out.slice(-800));
    if (mode === 'hang') {
      check('…the hung listing is cut off by the API cap, its whole process group with it',
        res.secs < 30 && processesNaming(f.r).length === 0, `${res.secs}s; left: ${processesNaming(f.r).join(' | ')}`);
    }
    fs.rmSync(f.r, { recursive: true, force: true });
  }

  {
    // Always a full restore: a mirror an earlier, killed restore left behind
    // (where this one's attempt would go, too) is deleted, never restored from.
    const f = apiFixture('stale-mirror');
    for (const rel of ['codex/sessions/stale.jsonl', 'codex/try1/sessions/stale.jsonl']) {
      put(path.join(f.e.AM_LOCAL, 'agent-state-mirror', rel), '{"stale":true}\n');
    }
    const res = await f.restore();
    check('a stale mirror from an earlier attempt is never restored from',
      res.code === 0 && f.restored() && !fs.existsSync(path.join(f.e.CODEX_HOME, 'sessions/stale.jsonl')), res.out.slice(-600));
    fs.rmSync(f.r, { recursive: true, force: true });
  }

  {
    // The budget is for the whole restore: a hung API with a cap longer than
    // the budget fails closed, naming the adapter and the step, and leaves
    // nothing running.
    const f = apiFixture('budget-api');
    const res = await f.restore({ FAKE_HF_SYNC: 'hang', AGENT_STATE_BUDGET: '4', AGENT_STATE_API_TIMEOUT: '60' });
    check('budget: a hung API fails the restore once the budget is out, naming adapter and step',
      res.code === 1 && /codex FAILED after \d+s: out of time — the restore budget \(AGENT_STATE_BUDGET=4s\) ran out during: fetching over the API \(plan\)/.test(res.out)
        && /refusing to start/.test(res.out) && !/could not fetch/.test(res.out), res.out.slice(-800));
    check('…promptly, with no process of it left', res.secs < 20 && processesNaming(f.r).length === 0,
      `${res.secs}s; left: ${processesNaming(f.r).join(' | ')}`);
    fs.rmSync(f.r, { recursive: true, force: true });

    // The same on the mount route: slow serial reads run the budget out.
    const g = apiFixture('budget-mount');
    const { AGENT_STATE_BUCKET: _unused, ...noBucket } = g.api;
    const out = path.join(g.r, 'out.txt');
    const t = Date.now();
    const m = await runTo(g.e, 'restore', out, { ...noBucket, STUB_SLEEP: '3', AGENT_STATE_BUDGET: '5' }).done;
    const text = fs.readFileSync(out, 'utf8');
    check('budget: slow mount reads fail the restore once the budget is out, naming adapter and step',
      m.code === 1 && /\w+ FAILED after \d+s: out of time — the restore budget \(AGENT_STATE_BUDGET=5s\) ran out during: (rsync from |waiting for )/.test(text), text.slice(-800));
    check('…promptly, with no process of it left', (Date.now() - t) / 1000 < 20 && processesNaming(g.r).length === 0,
      processesNaming(g.r).join(' | '));
    fs.rmSync(g.r, { recursive: true, force: true });

    // A step with no timeout of its own (here a SQLite check that never
    // returns) is stopped by the watchdog shortly after the budget. Kept
    // deterministic: no API, and opencode is the only adapter with state, so
    // what runs before that check is a handful of near-empty rsyncs, far
    // inside the budget even on a busy box — and the fake sqlite3 leaves a
    // marker proving the restore was in that very step when time ran out.
    const { r: hr, e: he } = fresh('budget-watchdog');
    const hbin = path.join(hr, 'bin');
    fs.mkdirSync(path.join(he.OPENCODE_DURABLE, 'checkpoints'), { recursive: true });
    sql(path.join(he.OPENCODE_DURABLE, 'checkpoints/opencode.db'), 'create table t(x);');
    const reached = path.join(hr, 'sqlite-reached');
    fs.mkdirSync(hbin, { recursive: true });
    fs.writeFileSync(path.join(hbin, 'sqlite3'), `#!/bin/sh\n: > '${reached}'\nsleep 1000; :\n`);
    fs.chmodSync(path.join(hbin, 'sqlite3'), 0o755);
    const hOut = path.join(hr, 'out.txt');
    const ht = Date.now();
    const w = await runTo(he, 'restore', hOut, { PATH: `${hbin}:${he.PATH}`, AGENT_STATE_BUDGET: '8' }).done;
    const wText = fs.readFileSync(hOut, 'utf8');
    check('budget: a step without its own timeout is stopped by the watchdog, naming the step',
      w.code === 1 && fs.existsSync(reached)
        && /opencode FAILED: out of time — the restore budget \(AGENT_STATE_BUDGET=8s\) ran out during: checking the restored SQLite database/.test(wText)
        && /refusing to start/.test(wText) && !/restore finished/.test(wText), wText.slice(-800));
    check('…promptly, with no process of it left', (Date.now() - ht) / 1000 < 40 && processesNaming(hr).length === 0,
      processesNaming(hr).join(' | '));
    fs.rmSync(hr, { recursive: true, force: true });

    // The mount-side backup listing: Claude on the mount (its API listing
    // failed), and `ls` of the backups hung until the budget stopped it. A
    // stopped listing is not an empty one — Claude fails, and so does the
    // restore, instead of finishing without the backups.
    const k = apiFixture('mount-ls-hang');
    const realLs = execFileSync('sh', ['-c', 'command -v ls'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(k.bin, 'ls'), [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in */state/claude/backups) sleep 1000; : ;; esac; done',
      `exec ${realLs} "$@"`,
    ].join('\n'));
    fs.chmodSync(path.join(k.bin, 'ls'), 0o755);
    const kr = await k.restore({ FAKE_HF_LIST: 'fail', AGENT_STATE_BUDGET: '6' });
    const kBackups = path.join(k.e.CLAUDE_CONFIG_DIR, 'backups');
    check('budget: a hung mount-side backup listing fails Claude and the restore, never "no backups"',
      kr.code === 1 && /claude: could not fetch from bucket/.test(kr.out)
        && /claude FAILED after \d+s: out of time — the restore budget \(AGENT_STATE_BUDGET=6s\) ran out during: listing \S+\/state\/claude\/backups/.test(kr.out)
        && !/restore finished/.test(kr.out) && !/claude done/.test(kr.out), kr.out.slice(-800));
    check('…promptly, with no process of it left', kr.secs < 25 && processesNaming(k.r).length === 0
      && !(fs.existsSync(kBackups) && fs.readdirSync(kBackups).length), processesNaming(k.r).join(' | '));
    fs.rmSync(k.r, { recursive: true, force: true });
  }

} catch (error) {
  check('no unexpected exception', false, error?.stack || String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall agent-state checks passed');
process.exit(failures ? 1 : 0);
