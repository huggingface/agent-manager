import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import express from 'express';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-api-boundary-'));
process.env.DATA_DIR = root;
const { ApiError, apiRoutes, apiErrorHandler, apiNotFound, errorEnvelope, pipeResponse } = await import('../src/api-errors.js');
const { createValidator } = await import('../src/api-validation.js');
const { operationMiddleware, readOperations } = await import('../src/operations.js');
const { remoteStream } = await import('../src/api-streams.js');
const secret = 'synthetic-private-data /private/example token_fixture <private-markup>';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const app = express();
app.use(express.json({ limit: '1kb' }));
app.use(operationMiddleware({ resolveOrigin: (raw) => raw === 'operator' ? { id: raw, type: 'operator' } : null }));
app.use(errorEnvelope);
const validate = createValidator({ cliExists: (id) => ['files', 'remote', 'claude'].includes(id), sessionExists: (id) => id === 'one', groupExists: (id) => id === 'group' });
const api = apiRoutes(app, validate);
let effects = 0, completed = 0;
app.use((_req, res, next) => { res.once('finish', () => completed++); next(); });
const action = (req, res) => { effects++; res.json({ body: req.body, query: req.query }); };
for (const route of ['/api/sessions', '/api/groups', '/api/move', '/api/notify', '/api/push/subscribe', '/api/push/unsubscribe', '/api/overview/hidden', '/api/demo', '/api/sessions/:id/input', '/api/sessions/:id/remote/paused', '/api/remote/:name/hello', '/api/crons', '/api/share/access', '/api/trace/import', '/api/sessions/:id/share']) api.post(route, action);
for (const route of ['/api/config', '/api/secrets', '/api/groups/:id', '/api/crons/:id', '/api/trace/:id/source']) api.put(route, action);
api.post('/api/agents/:id/prompt', express.text({ type: '*/*' }), action);
api.put('/api/files/:id/write', express.text({ type: '*/*' }), action);
for (const route of ['/api/trace/:id', '/api/operations', '/api/agents/:id/wait', '/api/agents/:id/tail', '/api/remote/:name/stream']) api.get(route, action);
api.post('/api/failure/:mode', (req, res, next) => {
  if (req.params.mode === 'sync') throw new Error(secret);
  if (req.params.mode === 'immediate') return Promise.reject(new Error(secret));
  if (req.params.mode === 'delayed') return delay(5).then(() => { throw new Error(secret); });
  if (req.params.mode === 'non-error') return Promise.reject(secret);
  if (req.params.mode === 'twice') { next(new Error(secret)); return Promise.reject(new Error(secret)); }
  if (req.params.mode === 'late') { res.json({ ok: true }); return delay(5).then(() => { throw new Error(secret); }); }
  if (req.params.mode === 'disconnected') return delay(100).then(() => res.json({ ok: true }));
});
api.get('/api/expected/:status', (req, _res) => { throw new ApiError(Number(req.params.status), 'fixture-refused', 'Try a different value.', { reason: 'fixture', hits: { rule: 2 }, mtime: 123, tag: 'revision', details: [{ field: 'name', message: 'required' }] }); });
api.get('/api/legacy', (_req, res) => res.status(409).json({ error: 'changed on disk', tag: 'latest' }));
api.get('/api/old-internal', (_req, res) => res.status(500).json({ error: secret, raw: secret }));
api.get('/api/empty', (_req, res) => res.status(204).end());
api.get('/api/partial', (_req, res) => res.json({ ok: false, reason: 'no-devices', failed: 1 }));
api.get('/api/healthy', (_req, res) => res.json({ ok: true }));
let source;
api.get('/api/file/:mode', (req, res, next) => {
  source = new PassThrough();
  res.set({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture"' });
  pipeResponse(source, req, res, next);
  if (req.params.mode === 'before') setTimeout(() => source.destroy(new Error(secret)), 5);
  else { source.write('file bytes'); if (req.params.mode === 'after') setTimeout(() => source.destroy(new Error(secret)), 20); }
});
let released = 0, entry;
api.get('/api/poll/:mode', (req, res, next) => remoteStream(req, res, next, {
  HEARTBEAT_MS: 10,
  pendingFor: () => { if (req.params.mode === 'before') throw new Error(secret); return []; },
  registerStream: (_name, value) => { entry = value; return () => { released++; }; },
  lastSeq: () => { if (req.params.mode === 'timer') throw new Error(secret); return 7; },
}, 'fixture', 0, 0.03));
app.use(apiNotFound);
app.get('*', (_req, res) => res.type('html').send('<html>fixture app</html>'));
app.use(apiErrorHandler);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const request = (url, body, method = 'POST', headers = {}) => fetch(base + url, { method, headers: { 'x-am-origin': 'operator', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000) });

try {
  await test('sync, async, non-Error and duplicate forwarding settle once with safe audit outcomes', async () => {
    const unhandled = [];
    const listener = (error) => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      for (const mode of ['sync', 'immediate', 'delayed', 'non-error', 'twice', 'late']) {
        const count = completed;
        const r = await request(`/api/failure/${mode}`);
        assert.equal(r.status, mode === 'late' ? 200 : 500);
        const body = await r.json();
        if (mode !== 'late') { assert.equal(body.code, 'internal-error'); assert.ok(body.error); }
        assert.ok(!JSON.stringify(body).includes('private'));
        await delay(15);
        assert.equal(completed, count + 1);
      }
      assert.deepEqual(unhandled, []);
      const logs = readOperations(100).filter((entry) => entry.path?.startsWith('/api/failure/'));
      assert.equal(logs.length, 6);
      assert.ok(!JSON.stringify(logs).includes('synthetic-private'));
      assert.equal((await fetch(base + '/api/healthy')).status, 200);
    } finally { process.off('unhandledRejection', listener); }
  });
  await test('validation rejects before fake domain actions; no coercions or duplicate scalar queries', async () => {
    const cases = [
      ['/api/sessions', {}], ['/api/sessions', { cli: 'wrong' }], ['/api/sessions', { cli: 'files', name: [] }], ['/api/sessions', { cli: 'files', path: null }],
      ['/api/groups', null], ['/api/groups', []], ['/api/groups', { name: false }], ['/api/groups/one', { name: '' }, 'PUT'], ['/api/groups/one', { layout: { cols: 0, rows: 1 } }, 'PUT'],
      ['/api/groups/one', { sessionIds: ['gone'] }, 'PUT'], ['/api/move', { ref: 's:gone', to: { kind: 'into', groupId: 'group' } }],
      ['/api/config', { artifacts: { enabled: 'false' } }, 'PUT'], ['/api/config', { revive: { days: 4 } }, 'PUT'], ['/api/config', { jobs: { askAboveUsd: -1 } }, 'PUT'], ['/api/config', { backup: { exclude: null } }, 'PUT'],
      ['/api/secrets', { notes: { fixture: {} } }, 'PUT'], ['/api/notify', { body: '' }], ['/api/notify', { body: 'safe', title: 123 }],
      ['/api/sessions/one/input', { text: [], attachmentIds: [] }], ['/api/sessions/one/input', { attachmentIds: null }], ['/api/sessions/one/remote/paused', { paused: 'false' }],
      ['/api/push/subscribe', { subscription: { endpoint: 'https://fixture.test' } }], ['/api/push/unsubscribe', { endpoint: null }],
      ['/api/overview/hidden', { ref: 's:one', hidden: 0 }], ['/api/demo', { active: null }], ['/api/remote/one/hello', { host: [] }],
      ['/api/crons', { name: 'job', agent: { name: 'one', cli: 'claude' }, prompt: 'fixture', schedule: { cron: '* * * * *', tz: 'UTC' }, runOnRestart: 'false' }],
      ['/api/share/access', { repo: 'a/b', grant: [2] }], ['/api/sessions/one/share', { visibility: 'private' }], ['/api/trace/import', { repo: {} }],
      ['/api/trace/one/source', { ref: 'one', kind: 'wrong' }, 'PUT'], ['/api/files/one/write', { content: 'wrong form' }, 'PUT'],
      ['/api/trace/one?before=0&after=1', undefined, 'GET'], ['/api/trace/one?offset=NaN', undefined, 'GET'], ['/api/trace/one?limit=0', undefined, 'GET'],
      ['/api/operations?limit=1&limit=2', undefined, 'GET'], ['/api/operations?limit[x]=1', undefined, 'GET'], ['/api/agents/one/wait?timeout=301', undefined, 'GET'], ['/api/remote/one/stream?wait=4', undefined, 'GET'],
    ];
    for (const [url, body, method] of cases) {
      const before = effects;
      const r = await request(url, body, method);
      assert.equal(r.status, 400, url);
      assert.equal((await r.json()).code, body === null ? 'invalid-json' : 'invalid-input', url);
      assert.equal(effects, before, url);
    }
    const valid = [
      ['/api/sessions', { cli: 'files', name: '', path: '.' }], ['/api/groups', { name: '' }], ['/api/groups/one', { layout: null, sessionIds: ['one'] }, 'PUT'],
      ['/api/config', { artifacts: { enabled: false }, jobs: { askAboveUsd: 0 }, backup: { exclude: [] }, extension: 'ignored' }, 'PUT'],
      ['/api/secrets', { notes: { anyExtension: '' } }, 'PUT'], ['/api/agents/one/wait?settle=0&timeout=300', undefined, 'GET'], ['/api/trace/one?before=0&bytes=8388608', undefined, 'GET'], ['/api/agents/one/tail?lines=5000', undefined, 'GET'],
    ];
    for (const [url, body, method] of valid) assert.equal((await request(url, body, method)).status, 200, url);
    const text = await fetch(base + '/api/agents/one/prompt', { method: 'POST', headers: { 'x-am-origin': 'operator', 'content-type': 'application/x-www-form-urlencoded' }, body: 'curl text prompt' });
    assert.equal((await text.json()).body, 'curl text prompt');
  });
  await test('a disconnected mutation is recorded once without claiming success or replaying late work', async () => {
    const controller = new AbortController();
    const pending = fetch(base + '/api/failure/disconnected', { method: 'POST', headers: { 'x-am-origin': 'operator' }, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending);
    await delay(150);
    const rows = readOperations(100).filter((entry) => entry.path === '/api/failure/disconnected');
    assert.equal(rows.length, 1); assert.equal(rows[0].ok, false); assert.equal(rows[0].incomplete, true);
  });
  await test('additive codes, legacy fields, deliberate empty/partial responses, routing and parser failures', async () => {
    for (const status of [400, 403, 404, 409, 413, 429]) {
      const r = await fetch(`${base}/api/expected/${status}`);
      assert.equal(r.status, status);
      const b = await r.json();
      assert.equal(b.code, 'fixture-refused'); assert.equal(b.error, 'Try a different value.'); assert.equal(b.tag, 'revision'); assert.equal(b.hits.rule, 2);
    }
    assert.equal((await (await fetch(base + '/api/legacy')).json()).code, 'conflict');
    assert.ok(!(await (await fetch(base + '/api/old-internal')).text()).includes(secret));
    assert.equal(await (await fetch(base + '/api/empty')).text(), '');
    assert.deepEqual(await (await fetch(base + '/api/partial')).json(), { ok: false, reason: 'no-devices', failed: 1 });
    assert.equal((await (await fetch(base + '/api/no-such-route')).json()).code, 'api-not-found');
    assert.match(await (await fetch(base + '/some/spa/path')).text(), /fixture app/);
    const bad = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' + secret });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'invalid-json');
    const large = await request('/api/sessions', { text: 'x'.repeat(2000) }); assert.equal(large.status, 413);
    const charset = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json; charset=unsupported' }, body: '{}' });
    assert.equal(charset.status, 415); assert.equal((await charset.json()).code, 'unsupported-media-type');
    const malformedPath = await fetch(base + '/api/trace/%zz'); assert.equal(malformedPath.status, 400); assert.equal((await malformedPath.json()).code, 'invalid-path');
    const denied = await fetch(base + '/api/sessions', { method: 'POST' }); assert.equal((await denied.json()).code, 'origin-required');
    const before = effects;
    const media = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'x-am-origin': 'operator' }, body: 'not JSON' });
    assert.equal(media.status, 415); assert.equal(effects, before);
  });
  await test('file and remote callbacks terminate committed streams and release resources', async () => {
    const before = await fetch(base + '/api/file/before'); assert.equal(before.status, 500); assert.equal((await before.json()).code, 'internal-error');
    const after = await fetch(base + '/api/file/after'); assert.equal(after.status, 200);
    const reader = after.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'file bytes');
    await assert.rejects(reader.read());
    assert.equal(source.destroyed, true);
    const controller = new AbortController();
    const open = await fetch(base + '/api/file/open', { signal: controller.signal }); await open.body.getReader().read(); controller.abort();
    await delay(20); assert.equal(source.destroyed, true);
    const pre = await fetch(base + '/api/poll/before'); assert.equal(pre.status, 500);
    const old = released;
    const timer = await fetch(base + '/api/poll/timer'); await assert.rejects(timer.text());
    assert.equal(released, old + 1);
    const late = entry; late.deliver([{ seq: 8 }]); assert.equal(released, old + 1);
    const good = await fetch(base + '/api/poll/normal'); const bytes = await good.text();
    assert.match(bytes, /^:connected\n/); assert.match(bytes, /"seq":7/); assert.ok(!bytes.includes('internal-error'));
    const ac = new AbortController(); const poll = await fetch(base + '/api/poll/normal', { signal: ac.signal }); await poll.body.getReader().read(); ac.abort();
    await delay(20); assert.equal(released, old + 3);
  });
} finally {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
