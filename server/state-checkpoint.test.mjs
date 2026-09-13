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

const env = {
  ...process.env,
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
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
} catch (error) {
  check('no unexpected exception', false, error?.stack || String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall agent-state checks passed');
process.exit(failures ? 1 : 0);
