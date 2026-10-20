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
    fs.writeFileSync(f.file, text);
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
