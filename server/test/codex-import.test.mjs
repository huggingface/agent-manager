import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-import-'));
process.env.DATA_DIR = path.join(root, 'state');
process.env.AM_WORKSPACES_DIR = path.join(root, 'projects');
fs.mkdirSync(process.env.DATA_DIR); fs.mkdirSync(process.env.AM_WORKSPACES_DIR);
const cwd = path.join(process.env.AM_WORKSPACES_DIR, 'existing'); fs.mkdirSync(cwd);
const { importSharedThread, configuredEndpoint } = await import('../src/codex-context.js');
const { CodexBindings } = await import('../src/codex-bindings.js');
const store = await import('../src/sessions.js');
const { commandFor, ensureRunning } = await import('../src/runner.js');
const threadId = '11111111-1111-4111-8111-111111111111';
const config = { socket: path.join(root, 'socket'), home: root }; fs.writeFileSync(config.socket, 'fixture');
const endpoint = configuredEndpoint(config);
const file = path.join(process.env.DATA_DIR, 'sessions.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  fs.writeFileSync(file, '[]'); store.init();
  const calls = [];
  const facts = { thread: { id: threadId, name: 'Existing task', cwd, status: { type: 'idle' }, canAcceptDirectInput: true } };
  const bindings = new CodexBindings(path.join(root, `bindings-${Math.random()}.json`));
  const deps = { store, bindings, config, isRunning: () => false, connect: async () => ({ endpoint, closed: false,
    close() { this.closed = true; }, async call(method) { calls.push(method); return { thread: facts.thread }; } }) };
  return { facts, calls, bindings, deps, run: () => importSharedThread({ threadId }, deps) };
}
test('imports the exact existing thread with a durable protective marker, and retries without duplicates', async () => {
  const f = fixture(); const first = await f.run(); const second = await f.run();
  assert.equal(first.session.id, second.session.id);
  assert.equal(first.session.codexSessionId, threadId); assert.equal(first.session.path, 'existing');
  assert.equal(first.session.codexSharedOnly, true);
  assert.equal(first.binding.threadId, threadId); assert.equal(store.list().length, 1);
  store.init(); assert.equal(store.get(first.session.id).codexSharedOnly, true);
  assert.ok(f.calls.every((m) => m === 'thread/read'));
});
test('refuses active/unloaded/child/noninteractive/wrong-id/outside-root tasks before creating a session', async () => {
  for (const patch of [{ status: { type: 'active' } }, { status: { type: 'notLoaded' } },
    { parentThreadId: threadId }, { canAcceptDirectInput: false }, { canAcceptDirectInput: undefined }, { id: 'other' }, { cwd: root }]) {
    const f = fixture(); Object.assign(f.facts.thread, patch);
    await assert.rejects(f.run()); assert.equal(store.list().length, 0); assert.equal(f.bindings.read().length, 0);
  }
  const f = fixture(); const link = path.join(process.env.AM_WORKSPACES_DIR, 'escape'); fs.symlinkSync(root, link);
  f.facts.thread.cwd = link; await assert.rejects(f.run()); assert.equal(store.list().length, 0);
});
test('never adopts an existing legacy AM pin or an ambiguous pin', async () => {
  const f = fixture(); const original = store.create({ name: 'Legacy', cli: 'codex', path: 'existing' });
  store.update(original.id, { codexSessionId: threadId });
  await assert.rejects(f.run(), /already belongs/); assert.equal(store.list().length, 1);
  const second = store.create({ name: 'Duplicate', cli: 'codex', path: 'existing' });
  store.update(second.id, { codexSessionId: threadId });
  await assert.rejects(f.run(), /More than one/);
});
test('an archived imported view is not silently reactivated', async () => {
  const f = fixture(); const { session } = await f.run();
  store.update(session.id, { archivedAt: new Date().toISOString() });
  await assert.rejects(f.run(), /archived/); assert.equal(store.list().length, 1);
});
test('failed binding leaves a recoverable reference that cannot launch a standalone TUI', async () => {
  const f = fixture(); const bind = f.bindings.bind.bind(f.bindings);
  f.bindings.bind = () => { throw new Error('simulated disk failure'); };
  await assert.rejects(f.run(), /disk failure/);
  const pending = store.list()[0]; assert.ok(pending.codexSharedOnly);
  assert.throws(() => commandFor(pending), /Finish adding/);
  assert.throws(() => ensureRunning(pending), /Finish adding/);
  store.init(); assert.equal(store.get(pending.id).codexSharedOnly, true);
  f.bindings.bind = bind;
  assert.equal((await f.run()).session.id, pending.id); assert.equal(store.list().length, 1);
});
test('privacy/cancellation and failure to persist prevent binding', async () => {
  const f = fixture(); f.deps.beforeCommit = () => { throw new Error('locked'); };
  await assert.rejects(f.run(), /locked/); assert.equal(store.list().length, 0);
  const g = fixture(); g.deps.signal = AbortSignal.abort();
  await assert.rejects(g.run(), /Connection lost/); assert.equal(store.list().length, 0);
  const h = fixture(); h.deps.store = { ...store, createCodexReference() { throw new Error('disk full'); } };
  await assert.rejects(h.run(), /disk full/); assert.equal(h.bindings.read().length, 0);
});
