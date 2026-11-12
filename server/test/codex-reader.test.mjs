import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-reader-shared-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.AM_WORKSPACES_DIR = path.join(root, 'projects');
for (const dir of [process.env.DATA_DIR, process.env.AM_WORKSPACES_DIR, path.join(root, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
const { sharedCodexRollout } = await import('../src/codex-reader.js');
const { CodexBindings } = await import('../src/codex-bindings.js');
const { configuredEndpoint } = await import('../src/codex-context.js');
const config = { home: root, socket: path.join(root, 'socket') };
fs.writeFileSync(config.socket, 'fixture');
const endpoint = configuredEndpoint(config);
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const cwd = process.env.AM_WORKSPACES_DIR;
let n = 0;
function fixture() {
 const session = { id: 'am', cli: 'codex', path: '', sessionUuid: other, codexSessionId: id, codexSharedOnly: true };
 const bindings = new CodexBindings(path.join(root, 'bindings-' + ++n + '.json'));
 bindings.bind({ session, threadId: id, endpointId: endpoint.id, cwd, expectedRevision: 0 });
 const rollout = path.join(root, 'sessions', `rollout-${n}.jsonl`);
 const meta = { type: 'session_meta', payload: { id, cwd, source: 'cli' } };
 const write = () => fs.writeFileSync(rollout, JSON.stringify(meta) + '\n'); write();
 const thread = { id, cwd, path: rollout, status: { type: 'active' } };
 const calls = []; let closed = false;
 const deps = { bindings, config, connect: async () => ({ endpoint, closed: false,
   async call(method, params) { calls.push([method, params]); return { thread }; }, close() { closed = true; } }) };
 return { session, bindings, rollout, meta, write, thread, deps, calls, closed: () => closed,
   run: () => sharedCodexRollout(session, deps) };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('resolves the exact active shared thread read-only and closes the observer', async () => {
 const f = fixture(); assert.equal(await f.run(), f.rollout);
 assert.deepEqual(f.calls, [['thread/read', { threadId: id, includeTurns: false }]]);
 assert.ok(f.closed());
 f.session.codexSharedOnly = false; f.session.codexRollout = '/old/incorrect.jsonl';
 assert.equal(await f.run(), f.rollout);
});
test('legacy sessions keep their resolver; incomplete imports never use it', async () => {
 const f = fixture(); const deps = { bindings: new CodexBindings(path.join(root, 'empty.json')) };
 assert.equal(await sharedCodexRollout({ ...f.session, codexSharedOnly: false }, deps), undefined);
 await assert.rejects(sharedCodexRollout(f.session, deps), { code: 'codex-reader-unavailable' });
});
test('rejects wrong identity, stale incarnation, changed workspace/endpoint, and child tasks', async () => {
 for (const mutate of [f => f.session.codexSessionId = other, f => f.session.sessionUuid = id,
   f => f.thread.id = other, f => f.thread.cwd = root, f => f.thread.parentThreadId = other,
   f => f.meta.payload.id = other, f => f.meta.payload.cwd = root,
   f => f.meta.payload.source = { subagent: {} }, f => f.meta.type = 'other',
   f => f.deps.connect = async () => ({ endpoint: { ...endpoint, home: cwd }, close() {} })]) {
   const f = fixture(); mutate(f); f.write();
   await assert.rejects(f.run(), { code: 'codex-reader-unavailable' });
 }
});
test('rejects outside files, symlink escapes, unavailable daemon, invalid headers and removed binding', async () => {
 const f = fixture(); const outside = path.join(root, 'outside.jsonl'); fs.copyFileSync(f.rollout, outside);
 f.thread.path = outside; await assert.rejects(f.run());
 const link = path.join(root, 'sessions', 'escape.jsonl'); fs.symlinkSync(outside, link);
 f.thread.path = link; await assert.rejects(f.run());
 f.thread.path = f.rollout; fs.writeFileSync(f.rollout, 'not a header\n'); await assert.rejects(f.run());
 fs.writeFileSync(f.rollout, 'x'.repeat(128 * 1024)); await assert.rejects(f.run());
 f.write(); f.deps.connect = async () => { throw new Error('private detail'); };
 await assert.rejects(f.run(), e => e.code === 'codex-reader-unavailable' && !e.message.includes('private'));
 const g = fixture(); const connect = g.deps.connect;
 g.deps.connect = async () => { const client = await connect(); fs.writeFileSync(g.bindings.file, '{"version":1,"bindings":[]}'); return client; };
 await assert.rejects(g.run()); assert.ok(g.closed());
});
