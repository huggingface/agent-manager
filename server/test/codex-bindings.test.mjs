import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexBindings, endpointIdentity } from '../src/codex-bindings.js';
const threadId = '11111111-1111-4111-8111-111111111111';
const uuid = '22222222-2222-4222-8222-222222222222';
function fixture(t, io = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bindings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'bindings.json');
  const store = new CodexBindings(file, io);
  const input = { session: { id: 'project-a', cli: 'codex', sessionUuid: uuid }, threadId,
    endpointId: endpointIdentity({ socket: '/local/socket', home: '/local/codex', uid: 1 }), cwd: '/work/a', expectedRevision: 0 };
  return { root, file, store, input };
}
test('binding survives restart and is unique in both directions', (t) => {
  const f = fixture(t), bound = f.store.bind(f.input);
  assert.deepEqual(new CodexBindings(f.file).resolve(f.input.endpointId, threadId), bound);
  assert.deepEqual(f.store.bind(f.input), bound, 'lost-response retry is idempotent');
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  for (const change of [
    { threadId: uuid }, { session: { ...f.input.session, id: 'other' } },
    { session: { ...f.input.session, sessionUuid: threadId } }, { expectedRevision: 42 },
  ]) assert.throws(() => f.store.bind({ ...f.input, ...change }), /binding-conflict/);
  assert.equal(f.store.read().length, 1);
});
test('endpoint identity includes OS user, home and socket but not socket inode', () => {
  const a = { socket: '/s', home: '/h', uid: 1 };
  for (const change of [{ uid: 2 }, { home: '/else' }, { socket: '/else' }]) {
    assert.notEqual(endpointIdentity(a), endpointIdentity({ ...a, ...change }));
  }
  assert.equal(endpointIdentity(a), endpointIdentity(a));
});
test('malformed, duplicated, unsupported and symlinked state fail closed', (t) => {
  const f = fixture(t), r = f.store.bind(f.input);
  for (const text of ['{', '{}', JSON.stringify({ version: 2, bindings: [] }), JSON.stringify({ version: 1, bindings: [r, r] })]) {
    fs.writeFileSync(f.file, text); f.store.invalidate(); // written behind the cache
    assert.throws(() => f.store.read(), /bindings-/);
    assert.throws(() => f.store.bind(f.input), /bindings-/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  }
  fs.unlinkSync(f.file); fs.symlinkSync('/etc/passwd', f.file);
  assert.throws(() => f.store.read(), /bindings-/);
});
test('write, sync and rename failures preserve the previous committed mapping', (t) => {
  let failing = false;
  for (const failurePoint of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  const io = new Proxy(fs, { get(target, key) {
    if (key === failurePoint) return (...args) => { if (failing) throw new Error('private fixture detail'); return target[key](...args); };
    return target[key];
  } });
  failing = false;
  const f = fixture(t, io); f.store.bind(f.input);
  const previous = fs.readFileSync(f.file, 'utf8'); failing = true;
  assert.throws(() => f.store.bind({ ...f.input, session: { ...f.input.session, id: 'other' }, threadId: uuid }), /^Error: bindings-write-failed$/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
  assert.deepEqual(fs.readdirSync(f.root), ['bindings.json']);
  }
});
test('a held or stale write lock refuses rather than deleting somebody’s lock', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file + '.lock', 'test owner');
  assert.throws(() => f.store.bind(f.input), /bindings-busy/);
  assert.equal(fs.readFileSync(f.file + '.lock', 'utf8'), 'test owner');
  assert.deepEqual(f.store.read(), []);
});
test('sync failure after rename reports uncertainty and an exact retry recovers', (t) => {
  let calls = 0;
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'fsyncSync') return (fd) => { if (++calls === 2) throw new Error('fixture'); return target.fsyncSync(fd); };
    return target[key];
  } });
  const f = fixture(t, io);
  assert.throws(() => f.store.bind(f.input), /bindings-write-failed/);
  assert.equal(f.store.bind(f.input).threadId, threadId);
  assert.equal(f.store.read().length, 1);
});

// The cache (issue #235, A1): read() is on every sidebar poll, and on the Space
// the file lives on a FUSE bucket where one openSync parks the event loop for
// 40-115 ms whether or not the file exists.
const counting = (file) => {
  const opens = { n: 0 };
  const io = new Proxy(fs, { get: (target, key) => key === 'openSync'
    ? (...args) => { if (args[0] === file) opens.n++; return target.openSync(...args); } : target[key] });
  return { io, opens };
};
test('the file is read once and answered from memory after that, missing file included', (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-bindings-')), 'bindings.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { io, opens } = counting(file);
  const store = new CodexBindings(file, io);
  for (let i = 0; i < 5; i++) assert.deepEqual(store.read(), []);
  assert.equal(opens.n, 1, 'ENOENT is cached too: that is the common case and the expensive one');
  assert.deepEqual(store.read({ fresh: true }), []); assert.equal(opens.n, 2, 'fresh goes to the file');
  store.invalidate(); store.read(); assert.equal(opens.n, 3, 'so does the read after invalidate()');
  fs.writeFileSync(file, '{'); store.invalidate();
  assert.throws(() => store.read(), /bindings-unavailable/);
  assert.throws(() => store.read(), /bindings-unavailable/);
  assert.equal(opens.n, 4, 'an unreadable file is cached as unreadable, not re-read on every poll');
});
test('bind replaces the cache with what it wrote, and a failed bind drops it', (t) => {
  const f = fixture(t);
  const { io, opens } = counting(f.file);
  const store = new CodexBindings(f.file, io);
  assert.deepEqual(store.read(), []);
  const bound = store.bind(f.input);
  const after = opens.n;
  assert.deepEqual(store.read(), [bound]); assert.deepEqual(store.forSession('project-a'), bound);
  assert.equal(opens.n, after, 'the record is served from memory');
  const failing = new CodexBindings(f.file, new Proxy(io, { get: (target, key) => key === 'renameSync' ? () => { throw new Error('fixture'); } : target[key] }));
  assert.deepEqual(failing.read(), [bound]);
  assert.throws(() => failing.bind({ ...f.input, session: { ...f.input.session, id: 'other' }, threadId: uuid }), /bindings-write-failed/);
  const before = opens.n; failing.read();
  assert.equal(opens.n, before + 1, 'after a failed write the next read looks at the file');
});
test('a write from outside the process reaches the cache off the main thread, within staleMs', async (t) => {
  const f = fixture(t);
  const { io, opens } = counting(f.file);
  const store = new CodexBindings(f.file, io, { staleMs: 20 });
  assert.deepEqual(store.read(), []); assert.equal(opens.n, 1);
  const bound = new CodexBindings(f.file).bind(f.input); // an operator's repair, a bucket restore
  assert.deepEqual(store.read(), [], 'served from memory until the cache is stale');
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(store.read(), [], 'stale: the re-read starts, the stale answer is served meanwhile');
  assert.ok(store.refreshing, 'and it runs in the background');
  await store.refreshing;
  assert.deepEqual(store.read(), [bound]);
  assert.equal(opens.n, 1, 'no sync open after the first: the re-read used fs.promises');
});
test('a re-read that started before a bind never puts the old file back', async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  // fs.promises.open that answers with the file as it was when the call was
  // made (ENOENT stays ENOENT), only once the test lets it.
  const promises = { ...fs.promises, async open(file, flags) {
    const snapshot = `${file}.snapshot`;
    try { fs.copyFileSync(file, snapshot); } catch { /* no file: the open below answers ENOENT */ }
    await gate;
    return fs.promises.open(snapshot, flags);
  } };
  const io = new Proxy(fs, { get: (target, key) => (key === 'promises' ? promises : target[key]) });
  const f = fixture(t, io);
  f.store.staleMs = 0;
  assert.deepEqual(f.store.read(), []);
  assert.deepEqual(f.store.read(), [], 'stale at once: a re-read starts and parks at the gate, seeing no file');
  const bound = f.store.bind(f.input);
  release(); await f.store.refreshing;
  assert.deepEqual(f.store.read(), [bound], 'the late empty answer is discarded, not stored over the bind');
});
