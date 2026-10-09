// am-test: manual — requires installed Codex and local sockets; isolated homes, no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { nativeFetch as fetch, NativeWebSocket } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-shared-pilot-'));
const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), data = path.join(root, 'data');
const cwd = path.join(data, 'workspaces', 'work'), socket = path.join(root, 's');
for (const dir of [home, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), `model="fixture"
model_provider="fixture"
[model_providers.fixture]
name="isolated fixture"
base_url="http://127.0.0.1:9/v1"
wire_api="responses"
requires_openai_auth=false
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
`);
const codexBin = process.env.PATH.split(path.delimiter).find((dir) => fs.existsSync(path.join(dir, 'codex')));
assert.ok(codexBin);
fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH=${JSON.stringify(codexBin)}:"$PATH"\n`);
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
const children = new Set(); let rpc, terminal, am, daemon;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await done; } finally { clearTimeout(force); children.delete(child); }
}
function startChild(cmd, args, extra = {}) {
  const child = spawn(cmd, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  children.add(child); child.stdout.resume(); child.stderr.resume(); return child;
}
async function connect() {
  const ws = new WebSocket('ws://localhost/', { createConnection: () => net.connect(socket) });
  await once(ws, 'open'); let seq = 0; const pending = new Map(), events = new Set();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method) { for (const fn of events) fn(msg); return; }
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error('Fixture RPC rejected: ' + p.method)); else p.resolve(msg.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer, method }); ws.send(JSON.stringify({ id, method, params }));
  });
  const init = await call('initialize', { clientInfo: { name: 'am_pilot_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' })); assert.equal(init.codexHome, codexHome);
  const shell = async (threadId, command, onStart = () => {}) => {
    let output = '', finish, timer;
    const done = new Promise((resolve, reject) => { finish = resolve; timer = setTimeout(() => reject(new Error('Shell fixture timeout')), 15000); });
    const fn = (m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === 'item/started' && m.params.item.type === 'commandExecution') onStart();
      if (m.method === 'item/completed' && m.params.item.type === 'commandExecution') output += m.params.item.aggregatedOutput || '';
      if (m.method === 'turn/completed') finish();
    };
    events.add(fn);
    try { await Promise.all([done, call('thread/shellCommand', { threadId, command, timeoutMs: 10000 })]); return output; }
    finally { clearTimeout(timer); events.delete(fn); }
  };
  return { call, shell, ws, init, close: () => ws.terminate() };
}
const free = net.createServer().listen(0, '127.0.0.1'); await once(free, 'listening');
const port = free.address().port; await new Promise((r) => free.close(r)); const base = `http://127.0.0.1:${port}`;
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const original=cp.execFile; cp.execFile=(...args)=>{if(args[1]?.includes('--version')){queueMicrotask(()=>args.at(-1)(new Error('fixture')));return;}return original(...args);};syncBuiltinESMExports();`);
async function startAM() {
  am = startChild(process.execPath, ['--import', preload, 'src/index.js'], { cwd: process.cwd(), env: {
    ...env, DATA_DIR: data, PORT: String(port), AM_CODEX_SHARED_SOCKET: socket, AM_CODEX_SHARED_HOME: codexHome, AM_CODEX_BINDINGS_PILOT: '1',
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
    AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input'), AM_BASHRC: '/nonexistent',
  } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    assert.equal(am.exitCode, null); await sleep(50);
  }
  throw new Error('AM startup timeout');
}
async function call(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-am-origin': 'operator', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
try {
  daemon = startChild('codex', ['app-server', '--listen', `unix://${socket}`]);
  for (let i = 0; !fs.existsSync(socket) && i < 100; i++) { assert.equal(daemon.exitCode, null); await sleep(50); }
  rpc = await connect();
  const started = await rpc.call('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never' });
  const threadId = started.thread.id;
  assert.match(await rpc.shell(threadId, 'printf am-pilot-original'), /am-pilot-original/);
  fs.writeFileSync(path.join(data, 'sessions.json'), '[]');
  await startAM();
  const imported = await call('/api/codex/import', { threadId });
  const amId = imported.session.id;
  assert.equal(imported.session.codexSharedOnly, true);
  assert.equal((await call('/api/codex/import', { threadId })).session.id, amId);
  // Fixed, explicit user-shell command only. No model or untrusted shell input.
  const helper = path.resolve('../scripts/am-codex-context.mjs');
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const lookup = `${quote(process.execPath)} ${quote(helper)} --base-url ${quote(base)} resolve --id-only`;
  assert.equal((await rpc.shell(threadId, lookup)).trim(), amId);
  const target = await call('/api/codex/client-target?session=' + amId); assert.equal(target.threadId, threadId);
  terminal = new NativeWebSocket(base.replace('http:', 'ws:') + '/ws?session=' + amId + '&cols=120&rows=34');
  let output = '';
  terminal.on('message', (raw) => {
    const text = raw.toString(); output += text;
    if (text.includes('\x1b[6n')) terminal.send(JSON.stringify({ t: 'i', d: '\x1b[1;1R' }));
    if (text.includes('\x1b[c')) terminal.send(JSON.stringify({ t: 'i', d: '\x1b[?1;2c' }));
  });
  await once(terminal, 'open');
  for (let i = 0; i < 200 && !output.includes('am-pilot-original'); i++) {
    if (terminal.readyState === WebSocket.CLOSED) throw new Error('Pilot terminal closed before showing history: ' + output.slice(-1000));
    await sleep(50);
  }
  assert.ok(output.includes('am-pilot-original'), 'AM TUI must show the exact thread history: ' + output.slice(-1500));
  // Work occurs in the disposable server while AM alone exits/restarts.
  terminal.send(JSON.stringify({ t: 'i', d: '\x03' }));
  await sleep(100);
  assert.equal(terminal.readyState, WebSocket.OPEN, 'one Ctrl-C must not kill the wrapper');
  let began;
  const startedWork = new Promise((resolve) => { began = resolve; });
  const work = rpc.shell(threadId, 'sleep 2; printf am-pilot-survived', began);
  await Promise.race([startedWork, work.then(() => { throw new Error('command did not start before completion'); })]);
  await stop(am); assert.match(await work, /am-pilot-survived/);
  assert.equal(daemon.exitCode, null);
  await startAM();
  assert.equal((await call('/api/codex/context?threadId=' + threadId)).amSessionId, amId);
  assert.equal((await rpc.call('thread/read', { threadId, includeTurns: false })).thread.id, threadId);
  console.log(JSON.stringify({ codex: rpc.init.userAgent.split(' ')[0], importExistingThread: true, idempotentImport: true, nativeLookup: true, amTuiExactHistory: true, amRestartPreservesServerWork: true, bindingSurvivesRestart: true, modelCalls: 0 }));
} finally {
  terminal?.terminate(); rpc?.close();
  for (const child of [...children].reverse()) await stop(child);
  fs.rmSync(root, { recursive: true, force: true });
}
