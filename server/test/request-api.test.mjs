import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { REQUEST_HEADERS } from '../src/request-admission.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-request-api-'));
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const data = path.join(root, 'data');
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
// Allowlist the environment: never inherit live roots, credentials, Space
// identity, skill distribution, jobs, lifecycle transports or user startup rc.
const env = {
  PATH: process.env.PATH, HOME: home, DATA_DIR: data, PORT: String(port),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, '.config'), AM_REPIN_DIR: path.join(root, 'repin'),
  AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
};
let server, logs = '';
const start = async (extra = {}) => {
  server = spawn(process.execPath, ['src/index.js'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { logs += chunk; });
  server.stderr.on('data', (chunk) => { logs += chunk; });
  for (let n = 0; n < 100; n++) {
    if (await fetch(origin + '/api/health').then((res) => res.ok).catch(() => false)) return;
    if (server.exitCode !== null) throw new Error('isolated backend exited during startup');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('isolated backend startup timed out');
};
const stop = async () => {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
};
const json = async (route, init = {}, intent = true) => {
  const res = await fetch(origin + route, { ...init, headers: {
    ...(intent ? REQUEST_HEADERS : {}), 'x-am-origin': 'operator', 'content-type': 'application/json', ...init.headers,
  } });
  return { status: res.status, body: await res.json() };
};
const operations = () => json('/api/operations?limit=100').then((res) => res.body.operations);
try {
  await start();
  const auditBefore = await operations();
  for (const route of ['/api/sessions', '/api/agents?from=operator', '/api/config', '/api/sessions/fixture/attachments', '/api/files/fixture/upload?path=fixture']) {
    const denied = await json(route, { method: 'POST', body: 'not-json-fixture' }, false);
    assert.equal(denied.status, 403, route);
    assert.equal(denied.body.code, 'request-not-allowed');
  }
  assert.deepEqual((await json('/api/sessions')).body, []);
  assert.deepEqual(await operations(), auditBefore, 'no rejected contents reach audit capture');
  const unknown = await json('/api/sessions?from=unknown-fixture', { method: 'POST', body: '{}' });
  assert.equal(unknown.status, 400, 'intent does not substitute for audit attribution');
  const shell = (await json('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'shell', name: 'fixture-shell' }) })).body;
  const info = () => json('/api/sessions').then((res) => res.body.find((session) => session.id === shell.id));
  const initial = await info();
  assert.equal(initial.running, false);
  const badSocket = new WebSocket(origin.replace('http:', 'ws:') + `/ws?session=${shell.id}`, { origin: 'null' });
  const deniedStatus = await new Promise((resolve, reject) => {
    badSocket.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); badSocket.terminate(); });
    badSocket.on('error', () => {});
    badSocket.on('open', () => reject(new Error('unexpected terminal upgrade')));
  });
  assert.equal(deniedStatus, 403);
  assert.equal((await info()).running, initial.running, 'a rejected terminal must not start the stopped shell');
  const file = path.join(data, 'workspaces', 'fixture.txt');
  const uploadRoute = `/api/files/${shell.id}/upload?path=.&name=fixture.txt`;
  const uploaded = await fetch(origin + uploadRoute, { method: 'POST', headers: { ...REQUEST_HEADERS, 'x-am-origin': 'operator', 'content-type': 'application/octet-stream' }, body: 'fixture file' });
  assert.equal(uploaded.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture file');
  const deniedUpload = await fetch(origin + uploadRoute, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'blocked fixture' });
  assert.equal(deniedUpload.status, 403);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture file');
  const raw = await fetch(origin + `/api/files/${shell.id}/raw?path=fixture.txt`);
  assert.equal(await raw.text(), 'fixture file');
  assert.match(raw.headers.get('content-security-policy'), /sandbox/);
  assert.ok(!raw.headers.get('content-security-policy').includes('allow-same-origin'));
  const reader = (await json('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'codex', name: 'fixture-reader' }) })).body;
  const attachment = await fetch(origin + `/api/sessions/${reader.id}/attachments`, { method: 'POST', headers: {
    ...REQUEST_HEADERS, 'x-am-origin': 'operator', 'content-type': 'text/plain', 'x-file-name': 'fixture.txt',
  }, body: 'fixture attachment' });
  assert.equal(attachment.status, 201);
  const attachmentId = (await attachment.json()).id;
  assert.ok(attachmentId);

  const remote = (await json('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'remote', name: 'fixture-peer', prompt: 'fixture work' }) })).body;
  const remoteState = () => json(`/api/sessions/${remote.id}/remote`).then((res) => res.body);
  const before = await remoteState();
  for (const route of ['/api/remote/fixture-peer/stream', '/api/remote/fixture-peer/messages?agent=1']) {
    assert.equal((await json(route, {}, false)).status, 403);
    assert.equal((await fetch(origin + route, { method: 'HEAD' })).status, 403);
  }
  assert.deepEqual(await remoteState(), before, 'rejected reads cannot establish contact or acknowledge work');
  assert.equal((await json('/api/remote/fixture-peer/hello', { method: 'POST', headers: { 'content-type': 'application/json', 'x-am-origin': 'remote:fixture-peer' }, body: '{}' })).status, 200);
  const stream = await fetch(origin + '/api/remote/fixture-peer/stream?since=0&wait=5', { headers: REQUEST_HEADERS });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /fixture work/);
  const reply = await fetch(origin + '/api/remote/fixture-peer/messages', { method: 'POST', headers: {
    ...REQUEST_HEADERS, 'content-type': 'text/plain',
  }, body: 'fixture reply' });
  assert.equal(reply.status, 200);
  const waiting = new AbortController();
  const pending = await fetch(origin + '/api/remote/fixture-peer/stream?since=99&wait=5', { headers: REQUEST_HEADERS, signal: waiting.signal });
  assert.equal(pending.status, 200); waiting.abort();
  const prompt = await fetch(origin + '/api/remote/fixture-peer/prompt').then((res) => res.text());
  assert.match(prompt, /X-AM-Request: 1/);
  const skill = fs.readFileSync(path.join(data, 'workspaces', 'skills', 'environment.md'), 'utf8');
  for (const line of skill.split('\n').filter((line) => line.includes('curl ') && line.includes('-X '))) assert.match(line, /X-AM-Request: 1/);
  assert.ok(!logs.includes('not-json-fixture'));
  assert.ok(!JSON.stringify(await operations()).includes('blocked fixture'));
  await stop();
  await start({ AM_ALLOW_MISSING_ORIGIN: '1' });
  assert.equal((await json('/api/sessions', { method: 'POST', body: '{}' }, false)).status, 403, 'audit-only test relaxation cannot disable admission');
  console.log('PASS real API ordering, attribution, raw uploads, attachment, preview isolation, terminal refusal, remote contact/stream/cancel, generated clients, audit bypass separation');
} finally {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
}
