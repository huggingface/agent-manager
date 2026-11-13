// No synchronous DATA_DIR access on the paths a sidebar poll or a keystroke runs.
//
// Every pane is served by one Node event loop, and on the Space DATA_DIR is a
// FUSE bucket where a sync fs call parks that loop for 40-115 ms (issue #235).
// A call like that on /api/tree, which every tab polls every 2.5 s, is a
// keystroke that does not echo. This suite boots the real server with
// helpers/fakefs-preload.mjs, which wraps every sync fs call under DATA_DIR
// and attributes it to the HTTP request or ws frame that made it, then runs
// the hot contexts and compares what they touched with KNOWN below.
//
// It COUNTS, it does not time: FAKEFS_MS=0 adds no delay, and a loaded machine
// changes nothing it measures, so it runs in the parallel pool. Deferring a
// call with setImmediate does not get past it either: the context follows the
// continuation.
//
// The fixture is a shared-Codex host: the pilot is on, three stopped Codex rows
// are seeded (no CLI starts), one of them bound to a thread on a local fake
// observer that answers thread/read and turns/list and refuses everything
// else. So every poll runs both per-row bindings lookups (hit and miss) and
// the bound row's status refresh, which is where the file was still read.
//
// KNOWN is the allowlist of offenders still on main, one line each. The suite
// fails on a line that is not on it (a new offender) AND on a line that is on
// it but no longer happens (a fixed one: delete the line in the same PR, so the
// list stays what the code does). The fixes are the numbered plan in #235.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { freePort } from './free-port.mjs';
import { endpointIdentity } from '../src/codex-bindings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const { WebSocket, WebSocketServer } = createRequire(path.join(SERVER, 'package.json'))('ws');
const H = { 'x-am-request': '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The contexts that run per poll or per keystroke. Anything else is reported.
const HOT = ['http GET /api/tree', 'http GET /api/meta', 'http GET /api/sessions', 'ws:i'];
const POLLS = 10, KEYS = 40;

// context, sync fs method, path relative to DATA_DIR. One line per offender.
const KNOWN = [
  // A3: sessions.js persist() from touchInput, on the first keystroke of each
  // minute per session (#235 step 5).
  ['ws:i', 'writeFileSync', 'sessions.json.tmp'],
  ['ws:i', 'renameSync', 'sessions.json.tmp'],
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hot-path-'));
const DATA_DIR = path.join(root, 'data'); fs.mkdirSync(DATA_DIR);
const HOME = path.join(root, 'home'); fs.mkdirSync(HOME);
const PUBLIC_DIR = path.join(root, 'public'); fs.mkdirSync(PUBLIC_DIR);
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');

// The shared Codex endpoint: a Unix socket and a Codex home, both off the
// bucket as on the Space (CODEX_HOME is on local disk there).
fs.mkdirSync(path.join(HOME, 'codex', 'sessions'), { recursive: true });
const CODEX_HOME = fs.realpathSync(path.join(HOME, 'codex'));
const SOCKET = path.join(root, 'observer.sock');
const THREAD = '11111111-1111-4111-8111-111111111111';
const WORK = path.join(DATA_DIR, 'workspaces', 'w'); fs.mkdirSync(WORK, { recursive: true });
const codexRows = [0, 1, 2].map((i) => ({ id: `codex-${i}`, name: `codex-${i}`, cli: 'codex', path: 'w',
  sessionUuid: crypto.randomUUID(), codexSessionId: i ? crypto.randomUUID() : THREAD, everStarted: true, createdAt: new Date().toISOString() }));
fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify(codexRows, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'codex-bindings.json'), JSON.stringify({ version: 1, bindings: [{
  amSessionId: codexRows[0].id, amSessionUuid: codexRows[0].sessionUuid, threadId: THREAD,
  endpointId: endpointIdentity({ socket: SOCKET, home: CODEX_HOME }),
  cwd: fs.realpathSync(WORK), revision: 1, boundAt: new Date().toISOString() }] }, null, 2));
// A saved, unloaded thread: the status refresh then also runs the recovery
// lookup, which reads the rollout header and resolves the workspace again.
const ROLLOUT = path.join(CODEX_HOME, 'sessions', 'rollout.jsonl');
fs.writeFileSync(ROLLOUT, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: THREAD, cwd: fs.realpathSync(WORK) } }) + '\n');
const observer = http.createServer(), wss = new WebSocketServer({ server: observer });
const observed = { reads: 0, refused: [] };
wss.on('connection', (ws) => ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { codexHome: CODEX_HOME, userAgent: 'fixture/0.162.1' };
  else if (m.method === 'thread/read') { observed.reads++; result = { thread: { id: THREAD, cwd: fs.realpathSync(WORK), path: ROLLOUT, status: { type: 'notLoaded' }, canAcceptDirectInput: false } }; }
  else if (m.method === 'thread/turns/list') result = { data: [{ id: 'turn-1', status: 'completed' }] };
  else { observed.refused.push(m.method); ws.send(JSON.stringify({ id: m.id, error: { code: -32000, message: 'read-only fixture' } })); return; }
  ws.send(JSON.stringify({ id: m.id, result }));
}));
await new Promise((resolve, reject) => { observer.once('error', reject); observer.listen(SOCKET, resolve); });
fs.chmodSync(SOCKET, 0o600); // the observer client refuses a socket others could reach

const port = await freePort();
const API = `http://127.0.0.1:${port}`;
// SPACE_* would make the server believe it is on a Space; the skills
// distribution walks real folders. Neither belongs in a fixture.
const { SPACE_ID, SPACE_HOST, AM_DISTRIBUTE_SKILLS, ...BASE } = process.env;
const child = spawn(process.execPath, ['--import', path.join(HERE, 'helpers', 'fakefs-preload.mjs'), 'src/index.js'], {
  cwd: SERVER,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...BASE, PORT: String(port), AM_BIND_HOST: '127.0.0.1', DATA_DIR, HOME, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    CODEX_HOME, CLAUDE_CONFIG_DIR: path.join(HOME, 'claude'),
    AM_CODEX_SHARED_SOCKET: SOCKET, AM_CODEX_SHARED_HOME: CODEX_HOME, AM_CODEX_BINDINGS_PILOT: '1',
    AM_ALLOW_MISSING_ORIGIN: '1', FAKEFS_MS: '0', // count, never delay
    AM_TEST_REPAINT_CMD: 'bash --noprofile --norc -i' },
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
const ask = (m) => new Promise((res) => { const f = (r) => { if (r?.fakefs) { child.off('message', f); res(r); } }; child.on('message', f); child.send(m); });
const show = (rows) => rows.map((x) => `    ${String(x.n).padStart(4)}x ${x.ctx.padEnd(24)} ${x.method.padEnd(14)} ${x.file}`).join('\n');
const key = (x) => `${x.ctx}\t${x.method}\t${x.file}`;

let failed = false;
const fail = (msg) => { failed = true; console.log(`FAIL ${msg}`); };
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(API + '/api/health', { headers: H })).ok) break; } catch {}
    if (i > 300 || child.exitCode !== null) throw new Error('server did not start\n' + logs.slice(-2000));
    await sleep(100);
  }
  const post = (p, b) => fetch(API + p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
  const get = (p) => fetch(API + p, { headers: H }).then((r) => r.arrayBuffer());
  await post('/api/welcome/seen');
  for (let i = 0; i < 3; i++) await post('/api/sessions', { cli: 'shell', name: `bg${i}`, path: '.' });
  const made = await (await post('/api/sessions', { cli: 'test-repaint', name: 'typing', path: '.' })).json();
  if (!made.id) throw new Error('no session: ' + JSON.stringify(made));
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?session=${made.id}&cols=100&rows=30`, { headers: H });
  await once(ws, 'open');
  await sleep(2500);
  // Warm caches ONCE: a first read at startup is allowed; doing it every poll is not.
  for (const p of ['/api/tree', '/api/meta', '/api/sessions']) await get(p);
  await sleep(1500);
  // The fixture as the roster sees it: three stopped Codex rows, one shared,
  // no terminal, and the shared one's status came from the observer.
  const rows = (await (await fetch(API + '/api/tree', { headers: H })).json()).sessions.filter((s) => s.cli === 'codex');
  if (rows.length !== 3 || rows.filter((s) => s.codexShared).length !== 1 || rows.some((s) => s.terminalRunning)) throw new Error('fixture: ' + JSON.stringify(rows.map((s) => [s.id, s.state, s.codexShared, s.terminalRunning])));
  if (!observed.reads) throw new Error('fixture: the bound row never asked the observer\n' + logs.slice(-2000));

  // What background timers do on their own, for the log only.
  await ask('fakefs-reset'); await sleep(3000);
  const idle = (await ask('fakefs-report')).sync;
  // Polls, then typing. The polls span more than the 3 s status cache, so the
  // bound row's status is refreshed inside the window. The FIRST keystroke is
  // included on purpose: touchInput persists the store on the first key of
  // every minute, and that is a cost the typist pays.
  await ask('fakefs-reset');
  const reads = observed.reads;
  for (let i = 0; i < POLLS; i++) { await Promise.all(['/api/tree', '/api/meta', '/api/sessions'].map(get)); await sleep(350); }
  for (let i = 0; i < KEYS; i++) { ws.send(JSON.stringify({ t: 'i', d: 'a' })); await sleep(20); }
  ws.send(JSON.stringify({ t: 'i', d: '\u0015' })); // ^U: clear the line again
  await sleep(500);
  const busy = (await ask('fakefs-report')).sync;
  if (observed.reads === reads) fail('the polls never refreshed the bound row\'s status, so the status path was not measured');
  if (observed.refused.length) fail(`a poll asked the observer for more than a read: ${observed.refused.join(', ')}`);

  console.log(`idle 3s, background (report only):\n${show(idle) || '    none'}`);
  const hot = busy.filter((x) => HOT.includes(x.ctx));
  for (const ctx of HOT) {
    const ctxRows = hot.filter((x) => x.ctx === ctx);
    const per = ctx === 'ws:i' ? `${KEYS} keystrokes` : `${POLLS} requests`;
    console.log(`${ctx}: ${ctxRows.reduce((a, x) => a + x.n, 0)} sync DATA_DIR calls over ${per}${ctxRows.length ? '\n' + show(ctxRows) : ''}`);
  }
  const other = busy.filter((x) => !HOT.includes(x.ctx));
  if (other.length) console.log(`other contexts during the busy window (report only):\n${show(other)}`);

  const seen = new Set(hot.map(key));
  const known = new Set(KNOWN.map((k) => k.join('\t')));
  for (const row of hot) {
    if (!known.has(key(row))) fail(`new sync DATA_DIR call on a hot path: ${row.n}x ${row.ctx} ${row.method} ${row.file}. Make it async or move it off the poll/keystroke path (issue #235).`);
  }
  for (const k of known) {
    if (!seen.has(k)) fail(`KNOWN lists ${k.replaceAll('\t', ' ')} but the hot path no longer makes that call. Delete its line.`);
  }
  // The ws attribution patches `ws` internals and falls back to 'background'
  // if they change; a fallback would hide every keystroke offender as a pass.
  if (logs.includes('[fakefs] ws attribution unavailable')) fail('fakefs-preload could not attribute ws frames; see helpers/fakefs-preload.mjs');
  if (!failed) console.log(`ok: hot paths make no sync DATA_DIR call beyond the ${KNOWN.length} known offender line(s)`);
  ws.close();
} finally {
  try { child.kill('SIGKILL'); } catch {}
  observer.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
