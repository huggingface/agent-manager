// Production HTTP stack, isolated AM and synthetic Codex endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { nativeFetch as fetch } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-context-http-'));
const data = path.join(root, 'data'), home = path.join(root, 'home'), work = path.join(data, 'workspaces', 'a');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
const threadId = '11111111-1111-4111-8111-111111111111';
const session = { id: 'fixture', name: 'Microduck', cli: 'codex', path: 'a', everStarted: true,
  sessionUuid: '22222222-2222-4222-8222-222222222222', codexSessionId: threadId, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([session]));
const socket = path.join(root, 's'), server = http.createServer(), calls = [];
const wss = new WebSocketServer({ server });
let status = 'idle';
wss.on('connection', (ws) => ws.on('message', (raw) => {
  const msg = JSON.parse(raw); calls.push(msg.method);
  if (msg.method === 'initialized') return;
  ws.send(JSON.stringify({ id: msg.id, result: msg.method === 'initialize' ? { codexHome: home, userAgent: 'fixture/0.162.0' }
    : { thread: { id: msg.params.threadId, name: 'Shared task', cwd: work, status: { type: status }, canAcceptDirectInput: true } } }));
}));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
fs.chmodSync(socket, 0o600);
const free = net.createServer().listen(0, '127.0.0.1'); await once(free, 'listening');
const port = free.address().port; await new Promise((r) => free.close(r));
const base = `http://127.0.0.1:${port}`, preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const original = cp.execFile;
cp.execFile = (...args) => { if (args[1]?.includes('--version')) { queueMicrotask(() => args.at(-1)(new Error('fixture'))); return; } return original(...args); };
syncBuiltinESMExports();
globalThis.fetch = async () => new Response(JSON.stringify({id:'fixture/test',private:process.env.FIXTURE_PUBLIC !== '1'}), {status:200});`);
let child;
async function start({ enabled = false, locked = false } = {}) {
  child = spawn(process.execPath, ['--import', preload, 'src/index.js'], { env: {
    PATH: process.env.PATH, HOME: home, DATA_DIR: data, PORT: String(port), PUBLIC_DIR: path.join(root, 'public'),
    CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
    AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input'), AM_BASHRC: '/nonexistent',
    AM_CODEX_SHARED_SOCKET: socket, AM_CODEX_SHARED_HOME: home, AM_CODEX_BINDINGS_PILOT: enabled ? '1' : '0',
    ...(locked ? { SPACE_ID: 'fixture/test', SPACE_HOST: 'fixture-test.hf.space', FIXTURE_PUBLIC: '1' } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error('AM fixture exited');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('AM fixture timed out');
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
  }
}
async function call(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
try {
  await start();
  const route = '/api/sessions/fixture/codex/binding', request = { threadId, expectedRevision: 0 };
  assert.equal((await call(route, request)).body.code, 'codex-pilot-disabled'); assert.equal(calls.length, 0);
  assert.equal((await call('/api/codex/import', { threadId })).body.code, 'codex-pilot-disabled'); assert.equal(calls.length, 0);
  await stop(); await start({ enabled: true });
  assert.equal((await call('/api/codex/context')).status, 400);
  assert.equal((await call('/api/codex/context?threadId[]=bad')).status, 400);
  assert.equal((await call('/api/codex/context?threadId=' + threadId)).body.code, 'codex-unmapped');
  status = 'notLoaded'; assert.equal((await call(route, request)).body.code, 'codex-handoff-required'); status = 'idle';
  const result = await call(route, request); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.binding.amSessionId, session.id);
  assert.equal((await call(route, request)).body.binding.boundAt, result.body.binding.boundAt);
  assert.equal((await call('/api/codex/context?threadId=' + threadId)).body.amSessionId, session.id);
  const target = await call('/api/codex/client-target?session=Microduck');
  assert.equal(target.status, 200); assert.equal(target.body.socket, socket); assert.equal(target.body.threadId, threadId);
  assert.equal((await call('/api/sessions/fixture/input', { text: 'do not send' })).body.code, 'invalid-input');
  assert.equal((await call('/api/sessions/fixture/stop', {})).body.code, 'codex-shared-stop-unsupported');
  assert.equal((await call('/api/sessions/fixture/archive', {})).status, 200);
  assert.equal((await call('/api/codex/context?threadId=' + threadId)).body.amSessionId, session.id);
  assert.equal((await call('/api/sessions/fixture/unarchive', {})).status, 200);
  assert.equal((await call('/api/codex/import', { threadId })).body.code, 'codex-existing-session');
  assert.equal((await call('/api/codex/import', { threadId: 'bad' })).status, 400);
  const importedThread = '33333333-3333-4333-8333-333333333333';
  status = 'active'; assert.equal((await call('/api/codex/import', { threadId: importedThread })).status, 409); status = 'idle';
  const imported = await call('/api/codex/import', { threadId: importedThread });
  assert.equal(imported.status, 200, JSON.stringify(imported));
  assert.equal(imported.body.session.codexSharedOnly, true);
  assert.equal((await call('/api/codex/import', { threadId: importedThread })).body.session.id, imported.body.session.id);
  assert.equal((await call('/api/codex/context?threadId=' + importedThread)).body.amSessionId, imported.body.session.id);
  const operations = (await call('/api/operations?limit=100')).body.operations;
  assert.ok(operations.some((op) => op.path === route && op.status === 200));
  await stop(); await start();
  assert.equal((await call('/api/codex/context?threadId=' + importedThread)).body.amSessionId, imported.body.session.id);
  assert.equal((await call('/api/codex/context?threadId=' + threadId)).body.amSessionId, session.id);
  assert.equal((await call('/api/codex/client-target?session=Microduck')).status, 200);
  assert.ok(calls.every((method) => ['initialize', 'initialized', 'thread/read'].includes(method)));
  await stop(); await start({ enabled: true, locked: true });
  assert.equal((await call('/api/codex/context?threadId=' + threadId)).status, 403);
  assert.equal((await call('/api/codex/client-target?session=Microduck')).status, 403);
  assert.equal((await call(route, request)).status, 403);
  assert.equal((await call('/api/codex/import', { threadId: importedThread })).status, 403);
  console.log('Codex context HTTP: pilot gate, lookup, mapping, restart, client target, legacy guards, audit and privacy passed.');
} finally {
  await stop(); for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => wss.close(r)); await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
