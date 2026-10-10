import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { observationConfig, observeSharedCodex, ObservationClient, taskStatus } from '../src/codex-shared.js';

async function fixture(t, respond, { mode = 0o600, wrongHome = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'am-observe-'));
  const config = { socket: path.join(root, 's'), home: root };
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const calls = [];
  wss.on('connection', (ws) => ws.on('message', (data) => {
    const m = JSON.parse(data); calls.push(m);
    if (m.method === 'initialized') return;
    const answer = m.method === 'initialize'
      ? { result: { userAgent: 'fixture/0.162.0 (test)', codexHome: wrongHome ? '/' : root } }
      : respond(m, ws);
    if (answer !== undefined) ws.send(JSON.stringify({ id: m.id, ...answer }));
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
  await fs.chmod(config.socket, mode);
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { config, calls };
}
const page = (data = [], nextCursor = null) => ({ result: { data, nextCursor } });

test('no configuration does not discover or connect to a daemon', async () => {
  assert.equal(observationConfig({}), null);
  const result = await observeSharedCodex();
  assert.equal(result.connection, 'not-configured');
  assert.equal(result.launchEnabled, false);
});
test('configuration requires both absolute paths', () => {
  for (const env of [{ AM_CODEX_SHARED_SOCKET: '/s' }, { AM_CODEX_SHARED_SOCKET: 's', AM_CODEX_SHARED_HOME: '/h' }]) {
    assert.throws(() => observationConfig(env), /configuration/);
  }
});
test('runtime state is independent from a terminal or thread history', () => {
  assert.equal(taskStatus({ type: 'notLoaded' }), 'unloaded');
  assert.equal(taskStatus({ type: 'idle' }), 'idle');
  assert.equal(taskStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'needs-input');
  assert.equal(taskStatus({ type: 'active', activeFlags: [] }), 'working');
  assert.equal(taskStatus({ type: 'active' }), 'unknown');
  assert.equal(taskStatus({ type: 'future-status' }), 'unknown');
});
test('uses only bounded metadata reads and exact AM thread pins', async (t) => {
  const f = await fixture(t, (m) => m.method === 'thread/list'
    ? page([{ id: 'thread-a', name: 'Same project', cwd: '/work', preview: 'private transcript' }], 'page-2')
    : { result: { thread: { id: m.params.threadId, status: { type: 'active', activeFlags: [] }, turns: ['private'] } } });
  const result = await observeSharedCodex({ config: f.config, sessions: [
    { id: 'right', name: 'A', cli: 'codex', codexSessionId: 'thread-a' },
    { id: 'wrong', name: 'Same project', cli: 'codex', path: '/work', codexSessionId: 'thread-b' },
  ] });
  assert.equal(result.connection, 'connected');
  assert.equal(result.serverVersion, '0.162.0');
  assert.equal(result.launchEnabled, false);
  assert.equal(result.nextCursor, 'page-2');
  assert.deepEqual(result.tasks[0].amSessions, [{ id: 'right', name: 'A' }]);
  assert.equal(result.tasks[0].status, 'working');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(f.calls.map((c) => c.method), ['initialize', 'initialized', 'thread/list', 'thread/read']);
  assert.deepEqual(f.calls[2].params, { limit: 20, cursor: null, useStateDbOnly: true });
  assert.deepEqual(f.calls[3].params, { threadId: 'thread-a', includeTurns: false });
});
test('pagination is bounded and never automatically follows all history', async (t) => {
  const f = await fixture(t, (m) => { assert.equal(m.params.cursor, 'page-2'); return page([], 'page-3'); });
  assert.equal((await observeSharedCodex({ config: f.config, cursor: 'page-2' })).nextCursor, 'page-3');
  assert.equal(f.calls.filter((c) => c.method === 'thread/list').length, 1);
});
test('a failed or mismatched read reports unknown, never an idle guess', async (t) => {
  const f = await fixture(t, (m) => m.method === 'thread/list' ? page([{ id: 'a' }, { id: 'b' }])
    : m.params.threadId === 'a' ? { error: { message: 'private backend detail' } }
      : { result: { thread: { id: 'wrong', status: { type: 'idle' } } } });
  const r = await observeSharedCodex({ config: f.config });
  assert.deepEqual(r.tasks.map((x) => x.status), ['unknown', 'unknown']);
});
test('refuses sockets accessible by other users before handshake', async (t) => {
  const f = await fixture(t, () => page(), { mode: 0o666 });
  await assert.rejects(observeSharedCodex({ config: f.config }), /socket-permissions/);
  assert.equal(f.calls.length, 0);
});
test('refuses a daemon with a different Codex home before listing threads', async (t) => {
  const f = await fixture(t, () => page(), { wrongHome: true });
  await assert.rejects(observeSharedCodex({ config: f.config }), /home-mismatch/);
  assert.deepEqual(f.calls.map((x) => x.method), ['initialize']);
});
test('transport rejects all execution and full-history operations', async (t) => {
  const f = await fixture(t, () => page());
  const client = await ObservationClient.connect(f.config);
  try {
    for (const method of ['thread/start', 'thread/resume', 'turn/interrupt', 'command/exec', 'remoteControl/enable']) {
      await assert.rejects(client.call(method, {}), /read-only/);
    }
    await assert.rejects(client.call('thread/read', { threadId: 'a', includeTurns: true }), /read-only/);
    await assert.rejects(client.call('thread/list', { limit: 999 }), /read-only/);
    await assert.rejects(client.call('thread/turns/list', {threadId:'a',limit:2,itemsView:'summary',sortDirection:'desc'}), /read-only/);
    await assert.rejects(client.call('thread/turns/list', {threadId:'a',limit:1,itemsView:'full',sortDirection:'desc'}), /read-only/);
  } finally { client.close(); }
  assert.ok(f.calls.every((x) => ['initialize', 'initialized'].includes(x.method)));
});
test('malformed pages are refused', async (t) => {
  const f = await fixture(t, () => page(Array.from({ length: 21 }, () => ({ id: 'a' }))));
  await assert.rejects(observeSharedCodex({ config: f.config }), /protocol/);
});
test('a silent daemon cannot leave requests pending forever', async (t) => {
  const f = await fixture(t, () => undefined);
  const start = Date.now();
  await assert.rejects(observeSharedCodex({ config: f.config, timeoutMs: 60 }));
  assert.ok(Date.now() - start < 1000);
});
test('unexpected server requests are never approved', async (t) => {
  const f = await fixture(t, (_m, ws) => { ws.send(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval' })); });
  await assert.rejects(observeSharedCodex({ config: f.config }));
  assert.ok(!f.calls.some((x) => x.id === 'approval'));
});
test('caller cancellation closes the observer connection', async (t) => {
  const f = await fixture(t, () => undefined);
  const controller = new AbortController();
  const p = observeSharedCodex({ config: f.config, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(p);
});
