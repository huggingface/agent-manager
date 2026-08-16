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
const backend = spawn('node', ['src/index.js'], {
  cwd: ROOT,
  env: {
    ...BASE_ENV,
    PORT, DATA_DIR, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    AM_BASHRC: '/nonexistent', SPACE_HOST: '', AM_ALLOW_MISSING_ORIGIN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });

const post = (url, body) => fetch(`${API}${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

try {
  let up = false;
  for (let i = 0; i < 300 && !up; i += 1) {
    up = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`server did not start:\n${logs.slice(-2000)}`);

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
} catch (e) {
  check('no exceptions', false, String(e && e.message ? e.message : e));
  console.log(`--- server log tail ---\n${logs.slice(-1200)}`);
} finally {
  backend.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
