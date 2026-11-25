import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-json-store-'));
const dataDir = path.join(root, 'data');
const localDir = path.join(root, 'local');
const homeDir = path.join(root, 'home');
for (const d of [dataDir, localDir, homeDir]) fs.mkdirSync(d, { recursive: true });

// Configure isolated paths before importing config-bound store singletons.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|OPENCODE_\w+|HERMES_HOME|OPENCLAW_HOME|FX_HOME|XDG_\w+|AM_\w+)$/.test(k)) {
    delete process.env[k];
  }
}
process.env.DATA_DIR = dataDir;
process.env.AM_LOCAL = localDir;
process.env.HOME = homeDir;

const {
  tempPathFor,
  shadowPathFor,
  readJsonStore,
  writeJsonStore,
  createJsonStore,
} = await import('../src/json-store.js');
const sessions = await import('../src/sessions.js');
const groups = await import('../src/groups.js');
const order = await import('../src/order.js');
const readMarks = await import('../src/read-marks.js');
const runstate = await import('../src/runstate.js');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

test('tempPathFor uses a leading dot so target basename is never a strict prefix (hf-mount#207)', () => {
  for (const name of ['sessions.json', 'groups.json', 'order.json', 'read-marks.json', 'runstate.json']) {
    const target = path.join(dataDir, name);
    const tmp = tempPathFor(target);
    assert.equal(path.dirname(tmp), dataDir);
    const tmpBase = path.basename(tmp);
    assert.ok(tmpBase.startsWith(`.${name}.`), `expected leading dot on ${tmpBase}`);
    assert.ok(tmpBase.endsWith('.tmp'), `expected .tmp suffix on ${tmpBase}`);
    assert.equal(
      tmpBase.startsWith(name),
      false,
      `${name} must never be a strict prefix of sibling temp file ${tmpBase}`,
    );
  }
});

test('writeJsonStore opens wx temp, fsyncs before rename, cleans up failed temp, and tolerates FUSE dir fsync codes', () => {
  const dir = fs.mkdtempSync(path.join(root, 'atomic-'));
  const shadowRoot = fs.mkdtempSync(path.join(root, 'atomic-local-'));
  const file = path.join(dir, 'sessions.json');
  const events = [];

  const io = {
    ...fs,
    openSync(p, flags, mode) {
      if (flags === 'wx') {
        events.push(`open:${path.basename(p)}`);
        assert.ok(path.basename(p).startsWith('.'), `temp file must start with dot: ${p}`);
        assert.equal(path.basename(p).startsWith('sessions.json'), false);
      }
      return fs.openSync(p, flags, mode);
    },
    fsyncSync(fd) {
      events.push('fsync');
      // Simulate FUSE rejecting directory fsync on the second fsync (dir fd).
      if (events.filter((e) => e === 'fsync').length === 2) {
        throw Object.assign(new Error('FUSE dir fsync unsupported'), { code: 'EINVAL' });
      }
      return fs.fsyncSync(fd);
    },
    renameSync(from, to) {
      events.push(`rename:${path.basename(from)}->${path.basename(to)}`);
      return fs.renameSync(from, to);
    },
  };

  writeJsonStore(file, [{ id: 's1' }], { io, amLocal: shadowRoot });
  assert.equal(events[0].startsWith('open:.sessions.json.'), true);
  assert.equal(events[1], 'fsync');
  assert.equal(events[2].endsWith('->sessions.json'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 's1' }]);
  assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);

  // Strict dir sync surfaces EINVAL when explicitly requested.
  const strictIo = {
    ...fs,
    fsyncSync(fd) {
      const st = fs.fstatSync(fd);
      if (st.isDirectory()) throw Object.assign(new Error('strict dir fsync'), { code: 'EINVAL' });
      return fs.fsyncSync(fd);
    },
  };
  assert.throws(() => writeJsonStore(file, [{ id: 's2' }], { io: strictIo, amLocal: '', strictDirSync: true }), /strict dir fsync/);

  // Failed write before rename preserves original file and removes temp file.
  const before = fs.readFileSync(file, 'utf8');
  const failingIo = {
    ...fs,
    fsyncSync() {
      throw Object.assign(new Error('simulated file fsync failure'), { code: 'EIO' });
    },
  };
  assert.throws(() => writeJsonStore(file, [{ id: 'clobbered' }], { io: failingIo, amLocal: '' }), /simulated file fsync failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);

  // Pre-existing symlink at a temp path is skipped via wx + retry and never unlinked.
  const sentinel = path.join(dir, 'keep.txt');
  fs.writeFileSync(sentinel, 'DO-NOT-TOUCH');
  const collidedTmp = tempPathFor(file, { uuid: () => 'collision-1' });
  fs.symlinkSync(sentinel, collidedTmp);
  const uuids = ['collision-1', 'collision-2'];
  writeJsonStore(file, [{ id: 'after-collision' }], { amLocal: '', uuid: () => uuids.shift() });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'DO-NOT-TOUCH');
  assert.equal(fs.lstatSync(collidedTmp).isSymbolicLink(), true);
  fs.unlinkSync(collidedTmp);
});

test('ENOENT on fresh Space initializes all 5 control-plane stores cleanly and mirrors to AM_LOCAL', () => {
  resetDir(dataDir);
  resetDir(localDir);
  process.env.AM_LOCAL = localDir;

  sessions.init();
  groups.init();
  order.init();
  readMarks.init();
  const prevRunstate = runstate.init();

  assert.equal(sessions.isPoisoned(), false);
  assert.equal(groups.isPoisoned(), false);
  assert.equal(order.isPoisoned(), false);
  assert.equal(readMarks.isPoisoned(), false);
  assert.equal(runstate.isPoisoned(), false);

  assert.deepEqual(sessions.list(), []);
  assert.deepEqual(groups.list(), []);
  assert.deepEqual(order.list(), []);
  assert.equal(readMarks.initialized(), false);
  assert.equal(prevRunstate, null);

  const s = sessions.create({ name: 'Fresh Session', cli: 'shell', path: 'fresh' });
  const g = groups.create('Core');
  groups.attach(g.id, s.id);
  order.prepend(`g:${g.id}`);
  assert.equal(readMarks.baseline(new Map([[s.id, { src: 'trace-1', seq: 2, hash: 'abcd' }]])), true);
  runstate.saveRunstate();

  for (const name of ['sessions.json', 'groups.json', 'order.json', 'read-marks.json', 'runstate.json']) {
    const primary = path.join(dataDir, name);
    const shadow = shadowPathFor(primary, localDir);
    assert.equal(fs.existsSync(primary), true, `missing primary ${name}`);
    assert.equal(fs.existsSync(shadow), true, `missing shadow for ${name}`);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(shadow, 'utf8')),
      JSON.parse(fs.readFileSync(primary, 'utf8')),
      `shadow mismatch for ${name}`,
    );
  }
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((n) => n.includes('.tmp')),
    [],
    'no leftover .tmp files in DATA_DIR',
  );
  assert.deepEqual(
    fs.readdirSync(path.join(localDir, 'am-control-plane')).filter((n) => n.includes('.tmp')),
    [],
    'no leftover .tmp files in AM_LOCAL/am-control-plane',
  );
});

test('init() seeds AM_LOCAL shadow when booting with pre-existing DATA_DIR files and empty AM_LOCAL', () => {
  resetDir(dataDir);
  resetDir(localDir);
  process.env.AM_LOCAL = localDir;

  const sessionsFile = path.join(dataDir, 'sessions.json');
  const seeded = [{
    id: 'seeded-1',
    name: 'Seeded',
    cli: 'claude',
    path: 'seeded',
    sessionUuid: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-01-01T00:00:00.000Z',
    everStarted: true,
  }];
  fs.writeFileSync(sessionsFile, JSON.stringify(seeded, null, 2));
  assert.equal(fs.existsSync(shadowPathFor(sessionsFile, localDir)), false);

  sessions.init();
  assert.equal(sessions.isPoisoned(), false);
  assert.equal(sessions.list().length, 1);
  assert.equal(fs.existsSync(shadowPathFor(sessionsFile, localDir)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(shadowPathFor(sessionsFile, localDir), 'utf8')), seeded);
});

test('recovers sessions from AM_LOCAL/am-control-plane shadow on EIO, EISDIR phantom dir, and truncated JSON', (t) => {
  resetDir(dataDir);
  resetDir(localDir);
  process.env.AM_LOCAL = localDir;

  sessions.init();
  const a = sessions.create({ name: 'Alpha', cli: 'claude', path: 'alpha' });
  const b = sessions.create({ name: 'Beta', cli: 'codex', path: 'beta' });
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const shadowFile = shadowPathFor(sessionsFile, localDir);
  assert.equal(fs.existsSync(shadowFile), true);

  // 1. EISDIR: hf-mount synthesizes a phantom directory where sessions.json should be.
  fs.unlinkSync(sessionsFile);
  fs.mkdirSync(path.join(sessionsFile, 'workspaces'), { recursive: true });
  sessions.init();
  assert.equal(sessions.isPoisoned(), false);
  assert.deepEqual(sessions.list().map((s) => s.id), [a.id, b.id]);

  // Once the phantom directory clears, writes persist the full recovered + new set.
  fs.rmSync(sessionsFile, { recursive: true, force: true });
  const c = sessions.create({ name: 'Gamma', cli: 'shell', path: 'gamma' });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).map((s) => s.id),
    [a.id, b.id, c.id],
  );

  // 2. EIO: transient FUSE read failure on primary sessions.json.
  const realReadFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(sessionsFile)) {
      throw Object.assign(new Error('Input/output error'), { code: 'EIO' });
    }
    return realReadFileSync.call(fs, target, ...rest);
  });
  sessions.init();
  assert.equal(sessions.isPoisoned(), false);
  assert.deepEqual(sessions.list().map((s) => s.id), [a.id, b.id, c.id]);
  t.mock.restoreAll();

  // 3. Truncated JSON on primary sessions.json.
  fs.writeFileSync(sessionsFile, '[{"id":"truncated-half-write"');
  sessions.init();
  assert.equal(sessions.isPoisoned(), false);
  assert.deepEqual(sessions.list().map((s) => s.id), [a.id, b.id, c.id]);
});

test('refuses to overwrite sessions.json with [newSession] when init() hits EIO or EISDIR without a shadow', (t) => {
  resetDir(dataDir);
  resetDir(localDir);
  process.env.AM_LOCAL = ''; // No local shadow configured / empty container without shadow

  sessions.init();
  const s1 = sessions.create({ name: 'Precious One', cli: 'claude', path: 'p1' });
  const s2 = sessions.create({ name: 'Precious Two', cli: 'codex', path: 'p2' });
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const preciousBytes = fs.readFileSync(sessionsFile, 'utf8');

  // Simulate transient EIO during boot init() when no shadow exists.
  const realReadFileSync = fs.readFileSync;
  let failReads = true;
  t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (failReads && typeof target === 'string' && path.resolve(target) === path.resolve(sessionsFile)) {
      throw Object.assign(new Error('FUSE transient EIO'), { code: 'EIO' });
    }
    return realReadFileSync.call(fs, target, ...rest);
  });

  sessions.init();
  assert.equal(sessions.isPoisoned(), true);
  assert.deepEqual(sessions.list(), []);

  // Even after the FUSE mount becomes writable again, persist() MUST NOT overwrite
  // sessions.json with [intruder], nor write a poisoned shadow!
  failReads = false;
  process.env.AM_LOCAL = localDir;
  sessions.create({ name: 'Intruder Session', cli: 'shell', path: 'intruder' });
  assert.equal(
    fs.readFileSync(sessionsFile, 'utf8'),
    preciousBytes,
    'poisoned store must NEVER clobber sessions.json on disk with [newSession]',
  );
  assert.equal(
    fs.existsSync(shadowPathFor(sessionsFile, localDir)),
    false,
    'poisoned store must not write partial in-memory state to local shadow either',
  );

  // Explicit fail-closed operations throw EJSONSTOREPOISONED while poisoned.
  assert.throws(
    () => sessions.createCodexReference({ name: 'ref', path: '.', threadId: 't-1' }),
    (err) => err.code === 'EJSONSTOREPOISONED',
  );
  assert.equal(fs.readFileSync(sessionsFile, 'utf8'), preciousBytes);

  // Also verify EISDIR poisoning on createJsonStore directly.
  const eisdirDir = fs.mkdtempSync(path.join(root, 'eisdir-poison-'));
  const eisdirFile = path.join(eisdirDir, 'sessions.json');
  fs.mkdirSync(eisdirFile);
  const directStore = createJsonStore(eisdirFile, {
    empty: () => [],
    validate: (v) => { if (!Array.isArray(v)) throw new TypeError('array'); return v; },
    amLocal: '',
  });
  assert.deepEqual(directStore.load(), []);
  assert.equal(directStore.isPoisoned(), true);
  fs.rmdirSync(eisdirFile);
  fs.writeFileSync(eisdirFile, preciousBytes);
  assert.throws(
    () => directStore.save([{ id: 'would-clobber' }]),
    (err) => err.code === 'EJSONSTOREPOISONED',
  );
  assert.equal(fs.readFileSync(eisdirFile, 'utf8'), preciousBytes);

  // Once a valid init()/load() succeeds, poison clears and both precious sessions return!
  t.mock.restoreAll();
  sessions.init();
  assert.equal(sessions.isPoisoned(), false);
  assert.deepEqual(sessions.list().map((s) => s.id), [s1.id, s2.id]);
  const s3 = sessions.create({ name: 'Legit Three', cli: 'shell', path: 'p3' });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).map((s) => s.id),
    [s1.id, s2.id, s3.id],
  );
});

test('quarantines corrupt JSON to .sessions.json.corrupt-* when no shadow exists and recovers cleanly', () => {
  resetDir(dataDir);
  resetDir(localDir);
  process.env.AM_LOCAL = '';

  const sessionsFile = path.join(dataDir, 'sessions.json');
  const corruptPayload = '[{"id":"half-written-json",\n';
  fs.writeFileSync(sessionsFile, corruptPayload);

  sessions.init();
  assert.equal(sessions.isPoisoned(), false);
  assert.deepEqual(sessions.list(), []);

  const quarantined = fs.readdirSync(dataDir).filter((name) => /^\.sessions\.json\.corrupt-\d+/.test(name));
  assert.equal(quarantined.length, 1, `expected one quarantine file, got: ${quarantined.join(', ')}`);
  assert.equal(quarantined[0].startsWith('.sessions.json.corrupt-'), true);
  assert.equal(quarantined[0].startsWith('sessions.json'), false, 'quarantine file must start with a dot');
  assert.equal(fs.readFileSync(path.join(dataDir, quarantined[0]), 'utf8'), corruptPayload);

  // Store remains usable after quarantining corrupt bytes.
  const fresh = sessions.create({ name: 'Recovered', cli: 'shell', path: 'rec' });
  const saved = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, fresh.id);

  // Invalid top-level shape (object instead of array) also quarantines when no shadow exists.
  const wrongShape = '{"unexpected":"object"}';
  const res = readJsonStore(path.join(dataDir, 'groups.json'), {
    amLocal: '',
    empty: () => [],
    validate(v) {
      if (!Array.isArray(v)) throw new TypeError('expected array');
      return v;
    },
    io: {
      ...fs,
      readFileSync(target, ...rest) {
        if (target === path.join(dataDir, 'groups.json')) return Buffer.from(wrongShape, 'utf8');
        return fs.readFileSync(target, ...rest);
      },
    },
  });
  assert.equal(res.poisoned, false);
  assert.deepEqual(res.value, []);
  assert.ok(res.quarantinedTo && path.basename(res.quarantinedTo).startsWith('.groups.json.corrupt-'));
  assert.equal(fs.readFileSync(res.quarantinedTo, 'utf8'), wrongShape);
});

test('groups, order, read-marks, and runstate also recover from shadow and refuse poisoned overwrites', () => {
  resetDir(dataDir);
  resetDir(localDir);
  process.env.AM_LOCAL = localDir;

  sessions.init();
  groups.init();
  order.init();
  readMarks.init();
  runstate.init();

  const g = groups.create('Infra');
  order.prepend(`g:${g.id}`);
  assert.equal(readMarks.acknowledge('sess-1', { src: 'gen1', seq: 3, hash: 'h3' }, { src: 'gen1', seq: 3, hash: 'h3' }), 'ok');
  const snapPayload = { at: new Date().toISOString(), sessions: { 'sess-1': { running: true, work: false } } };
  writeJsonStore(path.join(dataDir, 'runstate.json'), snapPayload, { amLocal: localDir });

  // Corrupt / phantom-dir all four files on DATA_DIR; AM_LOCAL shadows must recover all four!
  for (const name of ['groups.json', 'order.json', 'read-marks.json', 'runstate.json']) {
    const f = path.join(dataDir, name);
    fs.unlinkSync(f);
    fs.mkdirSync(f); // EISDIR phantom directory
  }

  groups.init();
  order.init();
  readMarks.init();
  const recoveredSnap = runstate.init();

  assert.equal(groups.isPoisoned(), false);
  assert.equal(order.isPoisoned(), false);
  assert.equal(readMarks.isPoisoned(), false);
  assert.equal(runstate.isPoisoned(), false);
  assert.equal(groups.get(g.id)?.name, 'Infra');
  assert.deepEqual(order.list(), [`g:${g.id}`]);
  assert.equal(readMarks.get('sess-1')?.seq, 3);
  assert.deepEqual(recoveredSnap, snapPayload);

  // Without AM_LOCAL shadows, EISDIR poisons all four so writes refuse to clobber.
  process.env.AM_LOCAL = '';
  groups.init();
  order.init();
  readMarks.init();
  runstate.init();

  assert.equal(groups.isPoisoned(), true);
  assert.equal(order.isPoisoned(), true);
  assert.equal(readMarks.isPoisoned(), true);
  assert.equal(runstate.isPoisoned(), true);
  assert.throws(
    () => readMarks.acknowledge('sess-1', { src: 'gen1', seq: 4, hash: 'h4' }, { src: 'gen1', seq: 4, hash: 'h4' }),
    (err) => err.code === 'EJSONSTOREPOISONED',
  );
});
