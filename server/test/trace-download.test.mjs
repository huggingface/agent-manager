// Downloading the transcript behind a session. The reader and the Files pane
// RENDER a trace; this route hands over the file, which is the only way to hold
// a session's own transcript: it lives in the harness's directory, outside the
// workspace, so the Files pane cannot reach it. Run with:
//   node test/trace-download.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-trace-download-'));
const DATA_DIR = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const PORT = process.env.TRACE_DOWNLOAD_PORT || '7898';
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'projects', 'am'), { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// A test server must not publish skills — the same strip migration.test.mjs and
// the browser suites do: `SPACE_ID` is set when this runs inside the Space, and
// generateEnvSkill() then fans this checkout's environment skill into every live
// agent's skills dir, which comes from $HOME rather than DATA_DIR.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
let logs = '';
let backend = null;
const start = async () => {
  backend = spawn('node', ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...BASE_ENV,
      PORT, DATA_DIR, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
      AM_BASHRC: '/nonexistent', SPACE_HOST: '', AM_ALLOW_MISSING_ORIGIN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => { logs += d; });
  backend.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 300; i += 1) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`server did not start:\n${logs.slice(-2000)}`);
};
const stop = async () => {
  if (!backend) return;
  const dead = new Promise((r) => backend.on('exit', r));
  backend.kill('SIGTERM');
  await Promise.race([dead, sleep(4_000)]);
  backend = null;
};

const post = (url, body) => fetch(`${API}${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

try {
  await start();

  const made = await (await post('/api/sessions', { cli: 'claude', name: 'Download me', path: 'dl' })).json();

  // No transcript yet is an ordinary state for an agent that has not spoken —
  // it must be a clean 404 with a reason, not a 500 or an empty file.
  const missing = await fetch(`${API}/api/trace/${made.id}/download`);
  const missingBody = await missing.json().catch(() => ({}));
  check('a session with no transcript answers 404 and says so',
    missing.status === 404 && missingBody.code === 'no-trace',
    JSON.stringify({ status: missing.status, body: missingBody }));

  // Now give it one, the way Claude Code would: a .jsonl under the config dir
  // whose `cwd` is this session's workspace folder.
  const workdir = path.join(DATA_DIR, 'workspaces', 'dl');
  const line = (i) => JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    cwd: workdir,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      ...(i % 2 ? { id: `m${i}`, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 } } : {}),
      content: [{ type: 'text', text: `turn ${i}` }],
    },
  });
  const transcript = path.join(HOME, '.claude', 'projects', 'am', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const body = `${[0, 1, 2, 3].map(line).join('\n')}\n`;
  fs.writeFileSync(transcript, body);

  const got = await fetch(`${API}/api/trace/${made.id}/download`);
  const text = await got.text();
  const disposition = got.headers.get('content-disposition') || '';
  check('the transcript downloads byte-for-byte', got.status === 200 && text === body,
    JSON.stringify({ status: got.status, bytes: text.length, expected: body.length }));
  // The name is the session's, not the harness's uuid: a folder of downloads
  // named 'aaaaaaaa-bbbb-…jsonl' tells the operator nothing.
  check('it arrives as an attachment named after the session',
    /attachment/i.test(disposition) && disposition.includes('download-me.jsonl'),
    JSON.stringify({ disposition }));

  // A trace pane over an imported bundle downloads the bundle's file, not the
  // pane's own (a trace pane has no transcript of its own at all).
  const bundleRef = 'user__shared-session';
  const bundleDir = path.join(DATA_DIR, 'traces', bundleRef);
  fs.mkdirSync(bundleDir, { recursive: true });
  const bundleBody = `${line(0)}\n`;
  fs.writeFileSync(path.join(bundleDir, 'session.jsonl'), bundleBody);
  const pane = await (await post('/api/sessions', { cli: 'trace', name: 'Shared: demo', path: '.' })).json();
  await fetch(`${API}/api/trace/${pane.id}/source`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'bundle', ref: bundleRef }),
  });
  const fromBundle = await fetch(`${API}/api/trace/${pane.id}/download`);
  const bundleText = await fromBundle.text();
  check('a trace pane downloads the file it is reading',
    fromBundle.status === 200 && bundleText === bundleBody,
    JSON.stringify({ status: fromBundle.status, bytes: bundleText.length }));

  const unknown = await fetch(`${API}/api/trace/does-not-exist/download`);
  check('an unknown id is a 404, not a crash', unknown.status === 404);

  // ---- a bundle ref is a directory NAME, never a path -----------------------
  // `/^[\w.-]+$/` matches `..`, and `path.join(DATA_DIR, 'traces', '..')` is
  // DATA_DIR: without a containment check this route serves the first *.jsonl
  // in the data directory — the operations log, whatever lands there next — as
  // an attachment, and `GET /api/trace/:id` renders the same file as a
  // conversation. A canary that sorts first is what `readdir` reaches for.
  fs.writeFileSync(path.join(DATA_DIR, 'aa-canary.jsonl'), `${JSON.stringify({
    type: 'user', cwd: workdir, timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'CANARY-NOT-A-TRACE' }] },
  })}\n`);
  const escapes = ['..', '.', '../..', 'a/../..'];
  const refused = [];
  for (const ref of escapes) {
    const put = await fetch(`${API}/api/trace/${pane.id}/source`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bundle', ref }),
    });
    refused.push({ ref, status: put.status });
  }
  check('a traversing bundle ref is refused before it is stored',
    refused.every((r) => r.status === 400), JSON.stringify(refused));

  // And independently of that gate: a ref already in the store must not resolve
  // either. Written straight into sessions.json, which is the state a Space
  // upgraded from a build that accepted `..` would boot with.
  await stop();
  const store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
  const paneRecord = store.find((entry) => entry.id === pane.id);
  paneRecord.traceSource = { kind: 'bundle', ref: '..' };
  // The property the whole route rests on: a NON-trace session reads its own
  // transcript and nothing else. `traceFileOf` hard-codes `ref = s.id` for
  // those, so a planted source must be ignored rather than followed.
  store.find((entry) => entry.id === made.id).traceSource = { kind: 'bundle', ref: '..' };
  fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify(store, null, 2));
  await start();

  const escaped = await fetch(`${API}/api/trace/${pane.id}/download`);
  const escapedBody = await escaped.text();
  check('a stored traversing ref cannot be downloaded',
    escaped.status === 400 && !escapedBody.includes('CANARY-NOT-A-TRACE'),
    JSON.stringify({ status: escaped.status, leaked: escapedBody.includes('CANARY-NOT-A-TRACE') }));
  const escapedWindow = await fetch(`${API}/api/trace/${pane.id}?tail=1`);
  const escapedWindowBody = await escapedWindow.text();
  check('nor rendered as a conversation by the reader',
    escapedWindow.status === 400 && !escapedWindowBody.includes('CANARY-NOT-A-TRACE'),
    JSON.stringify({ status: escapedWindow.status, leaked: escapedWindowBody.includes('CANARY-NOT-A-TRACE') }));

  const own = await fetch(`${API}/api/trace/${made.id}/download`);
  const ownBody = await own.text();
  check('a non-trace session downloads its own transcript, whatever source is planted on it',
    own.status === 200 && ownBody === body && !ownBody.includes('CANARY-NOT-A-TRACE'),
    JSON.stringify({ status: own.status, bytes: ownBody.length, expected: body.length }));
} catch (e) {
  check('no exceptions', false, String(e && e.message ? e.message : e));
  console.log(`--- server log tail ---\n${logs.slice(-1200)}`);
} finally {
  backend?.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
