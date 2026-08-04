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
  put(path.join(env.CODEX_DURABLE, codexRel), '{"turn":1}\n');
  put(path.join(env.CLAUDE_DURABLE, claudeRel), '{"turn":1}\n');
  put(path.join(env.GEMINI_DURABLE, geminiRel), '{"turn":1}\n');
  put(path.join(env.OPENCLAW_DURABLE, clawRel), '{"turn":1}\n');

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
} catch (error) {
  check('no unexpected exception', false, error?.stack || String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall agent-state checks passed');
process.exit(failures ? 1 : 0);
