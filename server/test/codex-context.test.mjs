import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CodexBindings } from '../src/codex-bindings.js';
import { run, tuiSpec } from '../../scripts/am-codex-context.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-context-'));
process.env.DATA_DIR = root;
const { bindExistingThread, configuredEndpoint, contextForThread, codexBindings } = await import('../src/codex-context.js');
const { commandFor } = await import('../src/runner.js');
const threadId = '11111111-1111-4111-8111-111111111111';
const sessionUuid = '22222222-2222-4222-8222-222222222222';
const work = path.join(root, 'workspaces', 'a'); fs.mkdirSync(work, { recursive: true });
const config = { socket: path.join(root, 's'), home: root };
process.env.AM_CODEX_SHARED_SOCKET = config.socket;
process.env.AM_CODEX_SHARED_HOME = config.home;
fs.writeFileSync(config.socket, 'fixture path');
const endpoint = configuredEndpoint(config);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(t) {
  const session = { id: 'a', name: 'Microduck', cli: 'codex', sessionUuid, codexSessionId: threadId, path: 'a' };
  const bindings = new CodexBindings(path.join(root, `map-${Math.random()}.json`));
  const facts = { running: false, sessions: [session] };
  const calls = [];
  const client = { endpoint, closed: false, close() { this.closed = true; }, async call(method, params) {
    calls.push({ method, params }); return { thread: { id: threadId, cwd: work, status: { type: 'idle' } } };
  } };
  const deps = { getSession: () => facts.sessions[0], sessions: () => facts.sessions, isRunning: () => facts.running,
    bindings, config, connect: async () => client };
  return { session, bindings, facts, calls, client, deps, request: { sessionId: 'a', threadId, expectedRevision: 0 } };
}
test('binds an already shared thread; native lookup survives independent reader restart', async (t) => {
  const f = fixture(t);
  const b = await bindExistingThread(f.request, f.deps);
  const answer = contextForThread(threadId, { sessions: f.facts.sessions, bindings: new CodexBindings(f.bindings.file), endpoint });
  assert.equal(answer.amSessionId, 'a'); assert.equal(answer.threadId, threadId);
  assert.equal(answer.workdir, work); assert.equal(b.revision, 1);
  assert.deepEqual(f.calls, [{ method: 'thread/read', params: { threadId, includeTurns: false } }]);
  assert.equal(f.client.closed, true);
  f.session.name = 'New display name';
  assert.equal(contextForThread(threadId, { sessions: f.facts.sessions, bindings: f.bindings, endpoint }).name, 'New display name');
  f.session.codexSessionId = sessionUuid;
  assert.throws(() => contextForThread(threadId, { sessions: f.facts.sessions, bindings: f.bindings, endpoint }), /no longer matches/);
});
test('running owner, queued input, duplicate pin and wrong pin are refused before contacting server', async (t) => {
  for (const change of [(f) => f.facts.running = true, (f) => f.session.pendingPrompt = 'unsent',
    (f) => f.session.pendingImagePaths = ['/image'], (f) => f.facts.sessions.push({ ...f.session, id: 'other' }),
    (f) => f.session.codexSessionId = sessionUuid]) {
    const f = fixture(t); change(f);
    await assert.rejects(bindExistingThread(f.request, f.deps)); assert.equal(f.calls.length, 0); assert.equal(f.bindings.read().length, 0);
  }
});
test('unloaded, active, unknown, wrong ID and wrong workspace cannot be adopted', async (t) => {
  for (const thread of [
    { id: threadId, cwd: work, status: { type: 'notLoaded' } },
    { id: threadId, cwd: work, status: { type: 'active', activeFlags: [] } },
    { id: threadId, cwd: work }, { id: sessionUuid, cwd: work, status: { type: 'idle' } },
    { id: threadId, cwd: root, status: { type: 'idle' } },
  ]) {
    const f = fixture(t); f.client.call = async () => ({ thread });
    await assert.rejects(bindExistingThread(f.request, f.deps)); assert.equal(f.bindings.read().length, 0); assert.ok(f.client.closed);
  }
});
test('rechecks owner and session after network waits; cancellation does not commit', async (t) => {
  for (const change of [(f) => f.facts.running = true, (f) => f.session.path = '',
    (f) => f.deps.signal = AbortSignal.abort(), (f) => f.client.closed = true]) {
    const f = fixture(t); const call = f.client.call;
    f.client.call = async (...args) => { const result = await call(...args); change(f); return result; };
    // signal is captured on entry, so cancellation fixture supplies its own controller.
    const controller = new AbortController(); f.deps.signal = controller.signal;
    const previous = f.client.call;
    f.client.call = async (...args) => { const result = await previous(...args); if (f.deps.signal !== controller.signal) controller.abort(); return result; };
    await assert.rejects(bindExistingThread(f.request, f.deps)); assert.equal(f.bindings.read().length, 0);
  }
});
test('a durable binding prevents legacy standalone relaunch even without endpoint config', () => {
  codexBindings.bind({ session: { id: 'protected', cli: 'codex', sessionUuid }, endpointId: endpoint.id, cwd: work, threadId, expectedRevision: 0 });
  const session = { id: 'protected', cli: 'codex', codexSessionId: threadId, codexRollout: '/old' };
  const launch = commandFor(session);
  assert.match(launch, /am-codex-context.mjs/);
  assert.match(launch, /tui 'protected'/);
  assert.ok(!launch.includes('--last') && !launch.includes('/old'));
  assert.ok(!commandFor({ id: 'unrelated', cli: 'codex' }).includes('am-codex-context'));
  assert.ok(!commandFor({ id: 'protected', cli: 'claude' }).includes('am-codex-context'));
});
test('helper uses native ID and explicit local AM config; no inherited AM attribution fallback', async () => {
  const file = path.join(root, 'client.json'); fs.writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:1234' }));
  const output = [], requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return Response.json({ amSessionId: 'a', threadId }); };
  await run(['--config', file, 'resolve', '--id-only'], { env: { AM_ID: 'wrong', CODEX_THREAD_ID: threadId }, fetchImpl, print: (x) => output.push(x) });
  assert.deepEqual(output, ['a']); assert.ok(requests[0].url.endsWith(threadId));
  assert.equal(requests[0].options.headers['x-am-request'], '1'); assert.equal(requests[0].options.redirect, 'error');
  await assert.rejects(run(['--config', file], { env: { AM_ID: 'wrong' }, fetchImpl }), /CODEX_THREAD_ID/);
  await assert.rejects(run(['--config', file], { env: { CODEX_THREAD_ID: threadId }, fetchImpl: async () => new Response('private', { status: 403 }) }), /HTTP 403/);
  fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://external.example' }));
  await assert.rejects(run(['--config', file], { env: { CODEX_THREAD_ID: threadId }, fetchImpl }), /local AM/);
});
test('TUI uses exact remote resume and clears inherited AM attribution without a shell', async () => {
  const target = { socket: '/tmp/socket with spaces', codexHome: '/tmp/home', workdir: work, threadId };
  const spec = tuiSpec(target, { PATH: '/bin', AM_ID: 'wrong', AM_PANE_PID: '123', CODEX_THREAD_ID: sessionUuid });
  assert.deepEqual(spec.args, ['--remote', 'unix:///tmp/socket with spaces', 'resume', threadId]);
  assert.deepEqual(spec.options.env, { PATH: '/bin', CODEX_HOME: '/tmp/home' });
  const file = path.join(root, 'tui.json'); fs.writeFileSync(file, '{"baseUrl":"http://localhost:1234"}');
  let launched;
  const code = await run(['--config', file, 'tui', 'Microduck'], { fetchImpl: async () => Response.json(target), launch: (...args) => {
    launched = args; const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(code, 0); assert.equal(launched[0], 'codex'); assert.deepEqual(launched[1], spec.args);
});
