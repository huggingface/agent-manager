import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillsService, generatedSkill, skillId, skillTargetDirs } from '../src/skills.js';

function fixture(t, count = 5) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), stateRoot = path.join(root, 'state');
  const targetRoots = Array.from({ length: count }, (_, i) => path.join(root, `harness-${i}`));
  const options = { sourceRoot, stateRoot, targetRoots };
  const source = (name = 'demo.md') => path.join(sourceRoot, name);
  const target = (i = 0, id = 'demo') => path.join(targetRoots[i], id, 'SKILL.md');
  const seed = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const manifest = path.join(stateRoot, 'skills-v1.json');
  return { root, options, source, target, seed, manifest, service: createSkillsService(options) };
}
const read = (p) => fs.readFileSync(p, 'utf8');
const revision = async (s, name = 'demo.md') => (await s.get(name)).revision;
const fail = (message) => Object.assign(new Error(message), { code: 'EIO' });
const rejects = (promise, status = 409) => assert.rejects(promise, (e) => e.status === status);

for (const name of ['', '.', '..', '...', '../demo.md', 'folder/demo.md', 'a\\b.md', '---.md', '__.txt', ' .md']) {
  test(`invalid identity ${JSON.stringify(name)} makes no writes`, async (t) => {
    const f = fixture(t);
    await rejects(f.service.create(name, 'new'), 400);
    assert.deepEqual(fs.readdirSync(f.root), []);
  });
}

test('valid mapping remains compatible and collisions never replace bytes', async (t) => {
  const f = fixture(t);
  assert.equal(skillId('My_skill.v2.md'), 'my-skill-v2');
  assert.equal(skillId('.hidden.md'), 'hidden');
  assert.equal(skillId('a'.repeat(70) + '.md'), 'a'.repeat(40));
  for (const [name, collision] of [['Demo.md', 'demo.MD'], ['hello.md', 'hello.txt'], ['My skill.md', 'My_skill.md'], ['a'.repeat(50) + '.md', 'a'.repeat(51) + '.txt']]) {
    assert.equal((await f.service.create(name, 'original')).ok, true);
    await rejects(f.service.create(collision, 'replacement'));
    await rejects(f.service.create(name, 'replacement'));
    assert.equal(read(f.source(name)), 'original');
  }
});

test('owned lifecycle, restart, all targets, support files and permanent deletion', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.seed(path.join(f.options.targetRoots[i], 'independent', 'SKILL.md'), `unrelated ${i}`);
  assert.equal((await f.service.create('demo.md', '# First')).ok, true);
  for (let i = 0; i < 5; i++) f.seed(path.join(path.dirname(f.target(i)), 'support.txt'), `support ${i}`);
  assert.equal((await f.service.update('demo.md', '# Second', await revision(f.service))).ok, true);
  const restart = createSkillsService(f.options);
  assert.equal((await restart.redistribute()).ok, true);
  const record = JSON.parse(read(f.manifest)).skills['demo.md'];
  assert.equal(record.id, 'demo'); assert.equal(record.targets.length, 5); assert.equal(record.pending, undefined);
  for (let i = 0; i < 5; i++) assert.equal(read(f.target(i)), generatedSkill('demo.md', '# Second'));
  assert.equal((await restart.remove('demo.md', await revision(restart))).ok, true);
  await rejects(restart.remove('demo.md', 'old-tag'), 404);
  assert.equal(fs.existsSync(f.source()), false);
  for (let i = 0; i < 5; i++) {
    assert.equal(fs.existsSync(f.target(i)), false);
    assert.equal(read(path.join(path.dirname(f.target(i)), 'support.txt')), `support ${i}`);
    assert.equal(read(path.join(f.options.targetRoots[i], 'independent', 'SKILL.md')), `unrelated ${i}`);
    assert.ok(fs.statSync(f.options.targetRoots[i]).isDirectory());
  }
  assert.deepEqual(JSON.parse(read(f.manifest)), { version: 1, sourceRoot: f.options.sourceRoot, disabledGenerated: [], skills: {} });
  assert.deepEqual(fs.readdirSync(f.options.stateRoot), ['skills-v1.json']);
  assert.deepEqual(fs.readdirSync(f.options.sourceRoot), []);
});

test('stale tabs, missing tags, source and installed edits preserve bytes', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  const tab = await revision(f.service);
  await rejects(f.service.update('demo.md', 'second'), 428);
  await f.service.update('demo.md', 'second', tab);
  await rejects(f.service.update('demo.md', 'stale', tab));
  await rejects(f.service.remove('demo.md', tab));
  const second = await revision(f.service);
  f.seed(f.source(), 'external source');
  await rejects(f.service.update('demo.md', 'third', second));
  await rejects(f.service.remove('demo.md', second));
  assert.equal((await f.service.redistribute()).ok, false);
  assert.equal(read(f.source()), 'external source');
  f.seed(f.source(), 'second');
  f.seed(f.target(2), 'external installation');
  await rejects(f.service.update('demo.md', 'third', await revision(f.service)));
  await rejects(f.service.remove('demo.md', await revision(f.service)));
  assert.equal(read(f.target(0)), generatedSkill('demo.md', 'second'));
  assert.equal(read(f.target(2)), 'external installation');
});

for (const action of ['save', 'delete']) {
  test(`a fresh revision permits ${action} of an externally edited source without claiming edited installations`, async (t) => {
    const f = fixture(t); await f.service.create('demo.md', 'first');
    const mutate = (s, rev) => action === 'save' ? s.update('demo.md', 'published', rev) : s.remove('demo.md', rev);
    const stale = await revision(f.service);
    f.seed(f.source(), 'edited outside Skills');
    await rejects(mutate(f.service, stale));
    const restart = createSkillsService(f.options);
    assert.equal((await restart.redistribute()).ok, false);
    assert.equal(read(f.source()), 'edited outside Skills');
    for (let i = 0; i < 5; i++) assert.equal(read(f.target(i)), generatedSkill('demo.md', 'first'));

    f.seed(f.target(2), 'independent installed edit');
    await rejects(mutate(restart, await revision(restart)));
    assert.equal(read(f.source()), 'edited outside Skills');
    assert.equal(read(f.target(2)), 'independent installed edit');
    f.seed(f.target(2), generatedSkill('demo.md', 'first'));
    assert.equal((await mutate(restart, await revision(restart))).ok, true);
    if (action === 'save') {
      assert.equal(read(f.source()), 'published');
      for (let i = 0; i < 5; i++) assert.equal(read(f.target(i)), generatedSkill('demo.md', 'published'));
    } else {
      assert.equal(fs.existsSync(f.source()), false);
      for (let i = 0; i < 5; i++) assert.equal(fs.existsSync(f.target(i)), false);
    }
  });

  test(`${action} persists the confirmed external source before a failure and keeps retries scoped`, async (t) => {
    const f = fixture(t); await f.service.create('demo.md', 'first');
    f.seed(f.source(), 'confirmed external edit');
    const mutate = (s, rev) => action === 'save' ? s.update('demo.md', 'published', rev) : s.remove('demo.md', rev);
    const s = createSkillsService({ ...f.options, io: { ...fs,
      renameSync(a, b) { if (action === 'save' && b === f.source()) throw fail('source rename'); return fs.renameSync(a, b); },
      unlinkSync(p) { if (action === 'delete' && p === f.target(2)) throw fail('target unlink'); return fs.unlinkSync(p); },
    } });
    assert.equal((await mutate(s, await revision(s))).ok, false);
    assert.equal(read(f.source()), 'confirmed external edit');
    const restart = createSkillsService(f.options);
    assert.equal((await restart.redistribute()).ok, false);
    const stale = await revision(restart);
    f.seed(f.source(), 'another external edit');
    await rejects(mutate(restart, stale));
    assert.equal(read(f.source()), 'another external edit');
    // Reviewing the new source can authorize it, but cannot change the pending
    // save's intended content or add any installation to its original targets.
    if (action === 'save') await rejects(restart.update('demo.md', 'different intent', await revision(restart)));
    assert.equal((await mutate(restart, await revision(restart))).ok, true);
  });
}

test('unowned installations block create and legacy adoption unless byte identical', async (t) => {
  const f = fixture(t);
  f.seed(f.target(), generatedSkill('demo.md', 'first'));
  await rejects(f.service.create('demo.md', 'first'));
  assert.equal(fs.existsSync(f.source()), false);
  f.seed(f.source(), 'different');
  assert.equal((await f.service.redistribute()).ok, false);
  assert.equal(fs.existsSync(f.manifest), false);
  f.seed(f.source(), 'first');
  f.seed(path.join(path.dirname(f.target()), 'helper.py'), 'user-owned');
  assert.equal((await f.service.redistribute()).ok, true);
  assert.equal(JSON.parse(read(f.manifest)).skills['demo.md'].targets[0].dirOwned, false);
  await f.service.remove('demo.md', await revision(f.service));
  assert.equal(read(path.join(path.dirname(f.target()), 'helper.py')), 'user-owned');
});

test('deletion preserves a pre-existing directory even when removing the skill leaves it empty', async (t) => {
  const f = fixture(t);
  const preexisting = path.dirname(f.target());
  fs.mkdirSync(preexisting, { recursive: true });
  assert.equal((await f.service.create('demo.md', 'first')).ok, true);
  const record = JSON.parse(read(f.manifest)).skills['demo.md'];
  assert.deepEqual(record.targets.map((target) => target.dirOwned), [false, true, true, true, true]);

  const restart = createSkillsService(f.options);
  assert.equal((await restart.remove('demo.md', await revision(restart))).ok, true);
  assert.equal(fs.existsSync(f.source()), false);
  assert.ok(fs.statSync(preexisting).isDirectory());
  assert.deepEqual(fs.readdirSync(preexisting), []);
  for (let i = 0; i < 5; i++) {
    assert.equal(fs.existsSync(f.target(i)), false);
    assert.ok(fs.statSync(f.options.targetRoots[i]).isDirectory());
    if (i > 0) assert.equal(fs.existsSync(path.dirname(f.target(i))), false);
  }
});

test('ambiguous legacy identities adopt neither and unrelated source still distributes', async (t) => {
  const f = fixture(t);
  f.seed(f.source('Demo.md'), 'first'); f.seed(f.source(), 'first');
  f.seed(f.source('unrelated.md'), 'okay');
  f.seed(f.target(), generatedSkill('demo.md', 'first'));
  const boot = await f.service.redistribute();
  assert.equal(boot.ok, false);
  assert.equal(boot.results.filter((r) => r.ok).length, 1);
  assert.deepEqual(Object.keys(JSON.parse(read(f.manifest)).skills), ['unrelated.md']);
  assert.equal(read(f.target()), generatedSkill('demo.md', 'first'));
});

test('missing sources never trigger inferred deletion, valid records permit explicit cleanup', async (t) => {
  const f = fixture(t);
  f.seed(f.target(), 'independent');
  await rejects(f.service.remove('demo.md', 'unknown'), 404);
  assert.equal(read(f.target()), 'independent');
  fs.unlinkSync(f.target());
  await f.service.create('demo.md', 'first'); fs.unlinkSync(f.source());
  assert.equal((await createSkillsService(f.options).redistribute()).ok, false);
  assert.equal(read(f.target()), generatedSkill('demo.md', 'first'));
  await f.service.remove('demo.md', await revision(f.service));
  assert.equal(fs.existsSync(f.target()), false);
});

for (const kind of ['source', 'target', 'dangling-source', 'dangling-target', 'parent']) {
  test(`${kind} symlink is rejected without changing independent data`, async (t) => {
    const f = fixture(t); f.seed(path.join(f.root, 'independent'), 'safe');
    const isSource = kind.includes('source');
    const p = kind === 'parent' ? path.dirname(f.target()) : isSource ? f.source() : f.target();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(path.join(f.root, kind.startsWith('dangling') ? 'absent' : 'independent'), p);
    await rejects(f.service.create('demo.md', 'new'));
    assert.equal(read(path.join(f.root, 'independent')), 'safe');
    assert.ok(fs.lstatSync(p).isSymbolicLink());
  });
}

test('temporary symlinks are neither followed nor cleaned up', async (t) => {
  const f = fixture(t); f.seed(path.join(f.root, 'independent'), 'safe');
  fs.mkdirSync(f.options.stateRoot);
  const tmp = path.join(f.options.stateRoot, '.am-skill-fixed.tmp');
  fs.symlinkSync(path.join(f.root, 'independent'), tmp);
  const s = createSkillsService({ ...f.options, nonce: () => 'fixed' });
  await assert.rejects(s.create('demo.md', 'new'), /EEXIST/);
  assert.equal(read(path.join(f.root, 'independent')), 'safe');
  assert.ok(fs.lstatSync(tmp).isSymbolicLink());
  assert.equal(fs.existsSync(f.source()), false);
});

test('configured aliases deduplicate and later root redirection is rejected', async (t) => {
  const f = fixture(t, 1);
  fs.mkdirSync(f.options.targetRoots[0]);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.options.targetRoots[0], alias);
  const options = { ...f.options, targetRoots: [alias, f.options.targetRoots[0], alias] };
  const s = createSkillsService(options);
  await s.create('demo.md', 'first');
  assert.equal((await s.get('demo.md')).installations.length, 1);
  fs.renameSync(f.options.targetRoots[0], path.join(f.root, 'moved'));
  fs.symlinkSync(path.join(f.root, 'moved'), f.options.targetRoots[0]);
  await rejects(s.remove('demo.md', await revision(s)));
  assert.equal(read(path.join(f.root, 'moved', 'demo', 'SKILL.md')), generatedSkill('demo.md', 'first'));
});

for (const state of ['corrupt', 'unreadable', 'unwritable', 'outside-path', 'outside-root']) {
  test(`${state} manifest cannot authorize any mutations`, async (t) => {
    const f = fixture(t); await f.service.create('demo.md', 'first');
    const m = JSON.parse(read(f.manifest));
    let io = fs;
    if (state === 'corrupt') f.seed(f.manifest, '{broken');
    if (state === 'outside-path') { m.skills['demo.md'].targets[0].path = path.join(f.root, 'independent'); f.seed(f.manifest, JSON.stringify(m)); }
    if (state === 'outside-root') { m.skills['demo.md'].targets[0].root = f.root; m.skills['demo.md'].targets[0].path = path.join(f.root, 'demo', 'SKILL.md'); f.seed(f.manifest, JSON.stringify(m)); }
    if (state === 'unreadable') io = { ...fs, readFileSync(p, ...args) { if (p === f.manifest) throw fail('manifest read'); return fs.readFileSync(p, ...args); } };
    if (state === 'unwritable') io = { ...fs, renameSync(a, b) { if (b === f.manifest) throw fail('manifest write'); return fs.renameSync(a, b); } };
    const s = createSkillsService({ ...f.options, io });
    await assert.rejects(async () => s.remove('demo.md', await revision(s)));
    assert.equal(read(f.source()), 'first');
    assert.equal(read(f.target()), generatedSkill('demo.md', 'first'));
  });
}

test('a manifest cannot redirect deletion to another skill inside an allowed target root', async (t) => {
  const f = fixture(t);
  await f.service.create('demo.md', 'first');
  await f.service.create('other.md', 'independent');
  const m = JSON.parse(read(f.manifest));
  const sibling = m.skills['other.md'].targets[0];
  // Keep the allowed root and copy the sibling's real hash: neither root
  // containment nor external-edit checks should mask the wrong skill identity.
  Object.assign(m.skills['demo.md'].targets[0], { path: sibling.path, hash: sibling.hash });
  const tampered = JSON.stringify(m);
  f.seed(f.manifest, tampered);

  const restart = createSkillsService(f.options);
  await rejects(async () => restart.remove('demo.md', await revision(restart)), 503);
  assert.equal(read(f.manifest), tampered);
  assert.equal(read(f.source()), 'first');
  assert.equal(read(f.source('other.md')), 'independent');
  for (let i = 0; i < 5; i++) {
    assert.equal(read(f.target(i)), generatedSkill('demo.md', 'first'));
    assert.equal(read(f.target(i, 'other')), generatedSkill('other.md', 'independent'));
  }
});

test('loss of a manifest allows only verified legacy adoption, never removal', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  fs.unlinkSync(f.manifest);
  await rejects(f.service.remove('demo.md', await revision(f.service)), 404);
  f.seed(f.target(1), 'independent change');
  assert.equal((await f.service.redistribute()).ok, false);
  assert.equal(read(f.target(1)), 'independent change');
});

for (const stage of ['source-write', 'target-write', 'target-rename', 'manifest-intent', 'manifest-final']) {
  test(`${stage} failure is truthful and retryable without historical content`, async (t) => {
    const f = fixture(t); await f.service.create('demo.md', 'first');
    let fired = false, manifestRenames = 0;
    const io = { ...fs,
      writeFileSync(fd, content, ...args) {
        if (!fired && ((stage === 'source-write' && content === 'second') || (stage === 'target-write' && content === generatedSkill('demo.md', 'second')))) { fired = true; throw fail(stage); }
        return fs.writeFileSync(fd, content, ...args);
      },
      renameSync(a, b) {
        if (b === f.manifest) manifestRenames++;
        if (!fired && ((stage === 'target-rename' && b === f.target(2)) || (stage === 'manifest-intent' && b === f.manifest) || (stage === 'manifest-final' && b === f.manifest && manifestRenames === 2))) { fired = true; throw fail(stage); }
        return fs.renameSync(a, b);
      },
    };
    const s = createSkillsService({ ...f.options, io });
    if (stage === 'manifest-intent') {
      await assert.rejects(s.update('demo.md', 'second', await revision(s)), /manifest-intent/);
      assert.equal(read(f.source()), 'first');
      assert.equal(read(f.target()), generatedSkill('demo.md', 'first'));
    } else {
      const r = await s.update('demo.md', 'second', await revision(s));
      assert.equal(r.ok, false); assert.equal(r.status, 'partial');
      assert.equal(r.manifest, stage === 'manifest-final' ? 'failed' : 'persisted');
      if (stage === 'source-write') assert.equal(read(f.source()), 'first');
      if (stage === 'target-write') assert.equal(read(f.target()), generatedSkill('demo.md', 'first'));
      if (stage === 'target-rename') assert.equal(read(f.target(2)), generatedSkill('demo.md', 'first'));
    }
    const restart = createSkillsService(f.options);
    assert.equal((await restart.update('demo.md', 'second', await revision(restart))).ok, true);
    for (let i = 0; i < 5; i++) assert.equal(read(f.target(i)), generatedSkill('demo.md', 'second'));
    assert.deepEqual(fs.readdirSync(f.options.stateRoot), ['skills-v1.json']);
    assert.deepEqual(fs.readdirSync(f.options.sourceRoot), ['demo.md']);
  });
}

test('partial deletion retains source, skips boot publication, freezes targets and protects external edits on retry', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  const s = createSkillsService({ ...f.options, io: { ...fs, unlinkSync(p) { if (p === f.target(2)) throw fail('target unlink'); return fs.unlinkSync(p); } } });
  const r = await s.remove('demo.md', await revision(s));
  assert.equal(r.ok, false); assert.equal(r.source, 'retained');
  assert.deepEqual(r.targets.map((t) => t.status), ['removed', 'removed', 'failed', 'removed', 'removed']);
  assert.equal(read(f.source()), 'first');
  const extra = path.join(f.root, 'new-target');
  const restart = createSkillsService({ ...f.options, targetRoots: [...f.options.targetRoots, extra] });
  assert.equal((await restart.redistribute()).ok, false);
  assert.equal(fs.existsSync(f.target()), false);
  assert.equal(fs.existsSync(extra), false);
  f.seed(f.target(2), 'user replacement');
  await rejects(restart.remove('demo.md', await revision(restart)));
  assert.equal(read(f.target(2)), 'user replacement');
  f.seed(f.target(2), generatedSkill('demo.md', 'first'));
  assert.equal((await restart.remove('demo.md', await revision(restart))).ok, true);
  assert.equal(fs.existsSync(extra), false);
});

for (const stage of ['source-unlink', 'manifest-final']) {
  test(`delete ${stage} can restart and finish only the recorded operation`, async (t) => {
    const f = fixture(t); await f.service.create('demo.md', 'first');
    let commits = 0;
    const s = createSkillsService({ ...f.options, io: { ...fs,
      unlinkSync(p) { if (stage === 'source-unlink' && p === f.source()) throw fail(stage); return fs.unlinkSync(p); },
      renameSync(a, b) { if (b === f.manifest && ++commits === 2 && stage === 'manifest-final') throw fail(stage); return fs.renameSync(a, b); },
    } });
    const r = await s.remove('demo.md', await revision(s)); assert.equal(r.ok, false);
    assert.equal(r.source, stage === 'source-unlink' ? 'failed' : 'removed');
    const restart = createSkillsService(f.options);
    assert.equal((await restart.redistribute()).ok, false);
    assert.equal((await restart.remove('demo.md', await revision(restart))).ok, true);
  });
}

test('concurrent operations and boot share serialization without losing updates', async (t) => {
  const f = fixture(t);
  const creates = await Promise.allSettled([f.service.create('demo.md', 'first'), f.service.create('Demo.txt', 'other')]);
  assert.equal(creates.filter((r) => r.status === 'fulfilled').length, 1);
  const rev = await revision(f.service);
  const updates = await Promise.allSettled([f.service.update('demo.md', 'second', rev), f.service.update('demo.md', 'third', rev)]);
  assert.equal(updates.filter((r) => r.status === 'fulfilled').length, 1);
  const bootRev = await revision(f.service);
  await Promise.allSettled([f.service.redistribute(), f.service.update('demo.md', 'after boot', bootRev)]);
  assert.equal(read(f.source()), 'after boot');
  await Promise.all([f.service.update('demo.md', 'before boot', await revision(f.service)), f.service.redistribute()]);
  assert.equal(read(f.source()), 'before boot');
  assert.equal(read(f.target()), generatedSkill('demo.md', 'before boot'));
  const deleteRev = await revision(f.service);
  const deletes = await Promise.allSettled([f.service.remove('demo.md', deleteRev), f.service.remove('demo.md', deleteRev)]);
  assert.equal(deletes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(fs.existsSync(f.source()), false);
});

test('generated skills obey ordinary ownership, collisions and pending deletion', async (t) => {
  const f = fixture(t);
  assert.equal((await f.service.generate('environment.md', 'first')).ok, true);
  assert.equal((await f.service.generate('environment.md', 'second')).ok, true);
  f.seed(f.target(0, 'environment'), 'user copy');
  await rejects(f.service.generate('environment.md', 'third'));
  assert.equal(read(f.source('environment.md')), 'second');
  f.seed(f.source('ENVIRONMENT.txt'), 'collision');
  await rejects(f.service.generate('environment.md', 'third'));
});

test('development guard keeps all real target homes out of distribution', async (t) => {
  const f = fixture(t);
  const env = { HOME: path.join(f.root, 'home'), CLAUDE_CONFIG_DIR: path.join(f.root, 'claude'), GEMINI_CLI_HOME: path.join(f.root, 'gemini'), OPENCLAW_HOME: path.join(f.root, 'openclaw') };
  assert.deepEqual(skillTargetDirs(env), []);
  const targets = skillTargetDirs({ ...env, AM_DISTRIBUTE_SKILLS: '1' });
  assert.equal(targets.length, 5); assert.ok(targets.every((p) => p.startsWith(f.root + '/')));
  assert.deepEqual(skillTargetDirs({ ...env, SPACE_ID: 'fixture/space' }), targets);
  const s = createSkillsService({ ...f.options, targetRoots: [] });
  assert.equal((await s.create('demo.md', 'first')).targets.length, 0);
  assert.equal(fs.existsSync(env.HOME), false);
});

test('an incomplete create retries with the original content and cannot become an overwrite', async (t) => {
  const f = fixture(t);
  const s = createSkillsService({ ...f.options, io: { ...fs, writeFileSync(fd, content, ...args) {
    if (content === 'first') throw fail('source create');
    return fs.writeFileSync(fd, content, ...args);
  } } });
  const r = await s.create('demo.md', 'first');
  assert.equal(r.ok, false); assert.equal(r.source, 'failed');
  assert.equal(r.skill.sourceExists, false); assert.equal(r.skill.pending, 'write');
  const restart = createSkillsService(f.options);
  assert.equal((await restart.redistribute()).ok, false);
  await rejects(restart.create('demo.md', 'new'));
  await rejects(restart.update('demo.md', 'new', await revision(restart)));
  assert.equal((await restart.create('independent.md', 'untouched')).ok, true);
  assert.equal((await restart.update('demo.md', 'first', await revision(restart))).ok, true);
  assert.equal(read(f.source('independent.md')), 'untouched');
});

test('a fresh revision cannot claim an unrelated source after its initial creation failed', async (t) => {
  const f = fixture(t);
  const s = createSkillsService({ ...f.options, io: { ...fs, writeFileSync(fd, content, ...args) {
    if (content === 'intended') throw fail('initial source write');
    return fs.writeFileSync(fd, content, ...args);
  } } });
  assert.equal((await s.create('demo.md', 'intended')).source, 'failed');
  const manifest = read(f.manifest);
  f.seed(f.source(), 'independent source');
  const restart = createSkillsService(f.options);
  await rejects(restart.update('demo.md', 'intended', await revision(restart)));
  assert.equal(read(f.source()), 'independent source');
  assert.equal(read(f.manifest), manifest);
  for (let i = 0; i < 5; i++) assert.equal(fs.existsSync(f.target(i)), false);
});

test('a changed configured target set invalidates prepared deletion without broadening it', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  const confirmed = await revision(f.service);
  const extra = path.join(f.root, 'new-destination');
  const restart = createSkillsService({ ...f.options, targetRoots: [...f.options.targetRoots, extra] });
  await rejects(restart.remove('demo.md', confirmed));
  assert.equal(read(f.source()), 'first');
  assert.equal((await restart.remove('demo.md', await revision(restart))).ok, true);
  assert.equal(fs.existsSync(extra), false);
});

test('source and state aliases work, and overlapping ownership roots are refused', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.options.sourceRoot); fs.mkdirSync(f.options.stateRoot);
  const sourceAlias = path.join(f.root, 'source-alias'), stateAlias = path.join(f.root, 'state-alias');
  fs.symlinkSync(f.options.sourceRoot, sourceAlias); fs.symlinkSync(f.options.stateRoot, stateAlias);
  const s = createSkillsService({ ...f.options, sourceRoot: sourceAlias, stateRoot: stateAlias });
  assert.equal((await s.create('demo.md', 'first')).ok, true);
  const overlapping = createSkillsService({ ...f.options, targetRoots: [f.options.sourceRoot] });
  await rejects(overlapping.create('other.md', 'second'));
  assert.equal(read(f.source()), 'first');
});

test('update versus delete with one revision commits only the first intent', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  const rev = await revision(f.service);
  const results = await Promise.allSettled([f.service.update('demo.md', 'saved', rev), f.service.remove('demo.md', rev)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(read(f.source()), 'saved');
  const m = JSON.parse(read(f.manifest)); assert.equal(m.skills['demo.md'].pending, undefined);
});

test('ownership cannot move to another source root by reusing its manifest', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  const otherRoot = path.join(f.root, 'other-source'); f.seed(path.join(otherRoot, 'demo.md'), 'first');
  const moved = createSkillsService({ ...f.options, sourceRoot: otherRoot });
  await rejects(moved.remove('demo.md', await revision(f.service)), 503);
  assert.equal(read(path.join(otherRoot, 'demo.md')), 'first');
  assert.equal(read(f.target()), generatedSkill('demo.md', 'first'));
});

test('atomic publication works on roots without hard-link support', async (t) => {
  const f = fixture(t);
  const s = createSkillsService({ ...f.options, io: { ...fs, linkSync() { throw Object.assign(new Error('Hard links unsupported'), { code: 'ENOTSUP' }); } } });
  assert.equal((await s.create('demo.md', 'first')).ok, true);
  assert.equal((await s.update('demo.md', 'second', await revision(s))).ok, true);
  assert.equal(read(f.source()), 'second');
  assert.equal(read(f.target()), generatedSkill('demo.md', 'second'));
});

test('deleting and recreating identical bytes cannot revive an old confirmation', async (t) => {
  const f = fixture(t); await f.service.create('demo.md', 'first');
  const oldConfirmation = await revision(f.service);
  await f.service.remove('demo.md', oldConfirmation);
  await f.service.create('demo.md', 'first');
  await rejects(f.service.remove('demo.md', oldConfirmation));
  await rejects(f.service.update('demo.md', 'stale edit', oldConfirmation));
  assert.equal(read(f.source()), 'first');
});

test('permanently deleted generated skills stay absent on restart until explicitly recreated', async (t) => {
  const f = fixture(t); await f.service.generate('environment.md', 'generated');
  await f.service.remove('environment.md', await revision(f.service, 'environment.md'));
  const restart = createSkillsService(f.options);
  assert.equal((await restart.redistribute()).ok, true);
  const r = await restart.generate('environment.md', 'new generation');
  assert.equal(r.source, 'generation-disabled');
  assert.equal(fs.existsSync(f.source('environment.md')), false);
  for (let i = 0; i < 5; i++) assert.equal(fs.existsSync(f.target(i, 'environment')), false);
  await restart.create('environment.md', 'explicit recreation');
  await restart.remove('environment.md', await revision(restart, 'environment.md'));
  assert.equal((await restart.generate('environment.md', 'must stay deleted')).source, 'generation-disabled');
  await restart.create('environment.md', 'explicit recreation');
  assert.equal((await restart.generate('environment.md', 'new generation')).source, 'generation-disabled');
  assert.equal(read(f.source('environment.md')), 'explicit recreation');
});

test('an explicit edit to a generated skill pauses regeneration without preventing ordinary publication', async (t) => {
  const f = fixture(t); await f.service.generate('environment.md', 'generated');
  await f.service.update('environment.md', 'operator customization', await revision(f.service, 'environment.md'));
  const restart = createSkillsService(f.options);
  assert.equal((await restart.generate('environment.md', 'new generation')).source, 'generation-disabled');
  assert.equal((await restart.redistribute()).ok, true);
  assert.equal(read(f.source('environment.md')), 'operator customization');
  for (let i = 0; i < 5; i++) assert.equal(read(f.target(i, 'environment')), generatedSkill('environment.md', 'operator customization'));
  assert.match((await restart.get('environment.md')).problem, /regeneration is paused/);
});

test('automatic generation cannot take over a user-created managed skill', async (t) => {
  const f = fixture(t); await f.service.create('environment.md', 'user-created');
  await rejects(f.service.generate('environment.md', 'generated'));
  assert.equal(read(f.source('environment.md')), 'user-created');
  for (let i = 0; i < 5; i++) assert.equal(read(f.target(i, 'environment')), generatedSkill('environment.md', 'user-created'));
});
