import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skillsServer } from './fixtures/skills-server.mjs';
import { generatedSkill } from '../src/skills.js';

test('real routes, startup and generated caller share ownership and revisions', async (t) => {
  const f = await skillsServer(); t.after(() => f.cleanup()); await f.start();
  const get = async (name = 'demo.md') => (await f.api(name)).body;
  const environment = await get('environment.md');
  assert.equal(environment.managed, true); assert.equal(environment.installations.length, 5);
  assert.equal((await f.api('demo.md', 'PUT', 'implicit overwrite')).status, 428);
  const created = await f.api('demo.md', 'POST', '# first');
  assert.equal(created.status, 200); assert.equal(created.body.ok, true);
  assert.equal((await f.api('demo.md', 'POST', '# upload')).status, 409);
  assert.equal((await f.api('Demo.txt', 'POST', '# collision')).status, 409);
  assert.equal((await f.api('empty.md', 'POST', '')).body.ok, true);
  assert.equal((await get('empty.md')).content, '');
  const initial = await get();
  const simultaneous = await Promise.all(['# saved', '# other'].map((text) => f.api('demo.md', 'PUT', text, initial.revision)));
  assert.deepEqual(simultaneous.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await f.api('demo.md', 'DELETE', undefined, initial.revision)).status, 409);
  const saved = await get();
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'demo'), 'utf8'), generatedSkill('demo.md', saved.content));
  await f.stop(); await f.start();
  assert.equal((await get()).content, saved.content);
  assert.equal((await get()).revision, saved.revision); // idempotent unchanged boot
  const beforeExternal = await get();
  fs.writeFileSync(f.target(2, 'demo'), 'user-installed copy');
  assert.equal((await f.api('demo.md', 'PUT', '# replace', beforeExternal.revision)).status, 409);
  assert.equal((await f.api('demo.md', 'DELETE', undefined, (await get()).revision)).status, 409);
  assert.equal(fs.readFileSync(f.source('demo.md'), 'utf8'), saved.content);
  fs.writeFileSync(f.target(2, 'demo'), generatedSkill('demo.md', saved.content));
  fs.writeFileSync(path.join(path.dirname(f.target(1, 'demo')), 'support.txt'), 'extra');
  f.fault({ method: 'unlinkSync', path: f.target(2, 'demo') });
  const partial = await f.api('demo.md', 'DELETE', undefined, (await get()).revision);
  assert.equal(partial.status, 207); assert.equal(partial.body.ok, false);
  assert.deepEqual(partial.body.targets.map((r) => r.status), ['removed', 'removed', 'failed', 'removed', 'removed']);
  await f.stop(); await f.start();
  assert.equal((await get()).pending, 'delete');
  assert.equal(fs.existsSync(f.target(0, 'demo')), false);
  assert.equal((await f.api('demo.md', 'POST', 'retry wrong route')).status, 409);
  f.fault({});
  assert.equal((await f.api('demo.md', 'DELETE', undefined, (await get()).revision)).body.ok, true);
  assert.equal((await f.api('demo.md', 'DELETE', undefined, 'old')).status, 404);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.target(1, 'demo')), 'support.txt'), 'utf8'), 'extra');
  assert.equal(fs.existsSync(f.source('demo.md')), false);
  // The actual generated caller must refuse an externally edited installation.
  fs.writeFileSync(f.target(0, 'environment'), 'user environment');
  const res = await fetch(`${f.url}/api/secrets`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' }, body: JSON.stringify({ notes: {} }) });
  assert.equal((await res.json()).skillDistribution.ok, false);
  assert.equal(fs.readFileSync(f.target(0, 'environment'), 'utf8'), 'user environment');
  const envSource = (await get('environment.md')).content;
  fs.writeFileSync(f.target(0, 'environment'), generatedSkill('environment.md', envSource));
  // The generated skill is read-only through the API, whatever revision is presented.
  const env = await get('environment.md');
  assert.equal(env.readOnly, true); assert.match(env.problem, /read-only/);
  assert.equal((await f.api('environment.md', 'PUT', '# My environment', env.revision)).status, 403);
  assert.equal((await f.api('environment.md', 'DELETE', undefined, env.revision)).status, 403);
  assert.equal((await f.api('environment.md', 'POST', '# My environment')).status, 403);
  assert.equal((await get('environment.md')).content, envSource);
  await f.stop(); await f.start(); // a new port: the generated text legitimately changes
  const regenerated = await get('environment.md');
  assert.equal(regenerated.readOnly, true); assert.equal(regenerated.pending, null);
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'environment'), 'utf8'), generatedSkill('environment.md', regenerated.content));
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test('local server defaults never install skills in any harness home', async (t) => {
  const f = await skillsServer(); t.after(() => f.cleanup()); await f.start({ distribute: false });
  assert.equal((await f.api('local.md', 'POST', 'local')).body.ok, true);
  assert.equal((await f.api('environment.md')).body.installations.length, 0);
  for (const root of f.targetRoots) assert.equal(fs.existsSync(root), false);
});

test('corrupt manifest degrades skills while the actual server stays available', async (t) => {
  const f = await skillsServer(); t.after(() => f.cleanup());
  const state = path.join(f.env.DATA_DIR, 'state', 'skills'); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'skills-v1.json'), '{bad');
  await f.start();
  assert.equal((await f.api('demo.md', 'POST', 'new')).status, 503);
  assert.equal(fs.existsSync(f.source('environment.md')), false);
  for (const root of f.targetRoots) assert.equal(fs.existsSync(root), false);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
  assert.match(f.log, /degraded distribution/);
});

test('real routes allow reviewed external source edits after restart while rejecting stale revisions', async (t) => {
  const f = await skillsServer(); t.after(() => f.cleanup()); await f.start();
  await f.api('demo.md', 'POST', '# Original');
  const stale = (await f.api('demo.md')).body.revision;
  fs.writeFileSync(f.source('demo.md'), '# Edited in Files or by an agent');
  assert.equal((await f.api('demo.md', 'PUT', '# Stale save', stale)).status, 409);
  assert.equal((await f.api('demo.md', 'DELETE', undefined, stale)).status, 409);
  await f.stop(); await f.start();
  const reviewed = (await f.api('demo.md')).body;
  assert.equal(reviewed.content, '# Edited in Files or by an agent');
  assert.match(reviewed.problem, /Source was modified/);
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'demo'), 'utf8'), generatedSkill('demo.md', '# Original'));
  const saved = await f.api('demo.md', 'PUT', '# Reviewed and published', reviewed.revision);
  assert.equal(saved.status, 200); assert.equal(saved.body.ok, true);
  await f.stop(); await f.start();
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'demo'), 'utf8'), generatedSkill('demo.md', '# Reviewed and published'));
  fs.writeFileSync(f.source('demo.md'), '# Another external edit');
  const confirmed = (await f.api('demo.md')).body;
  const deleted = await f.api('demo.md', 'DELETE', undefined, confirmed.revision);
  assert.equal(deleted.status, 200); assert.equal(deleted.body.ok, true);
  assert.equal(fs.existsSync(f.source('demo.md')), false);
  for (let i = 0; i < 5; i++) assert.equal(fs.existsSync(f.target(i, 'demo')), false);
});

test('the environment skill regenerates after an interrupted generation, through Settings and on startup', async (t) => {
  const f = await skillsServer(); t.after(() => f.cleanup()); await f.start();
  // The generated text embeds the jobs cost limit, so a Settings save with a
  // new limit is a generation with genuinely different content.
  const settings = (askAboveUsd) => fetch(`${f.url}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' }, body: JSON.stringify({ jobs: { askAboveUsd } }) }).then((r) => r.json());
  const before = (await f.api('environment.md')).body;
  // Boot N: the regeneration triggered by a Settings save fails on one target.
  f.fault({ method: 'renameSync', path: f.target(2, 'environment') });
  const broken = await settings(11);
  assert.equal(broken.skillDistribution.ok, false);
  assert.equal((await f.api('environment.md')).body.pending, 'write');
  // The inputs change again; the old intended bytes can no longer be produced.
  f.fault({});
  const recovered = await settings(22);
  assert.equal(recovered.skillDistribution.ok, true, JSON.stringify(recovered.skillDistribution));
  const after = (await f.api('environment.md')).body;
  assert.equal(after.pending, null);
  assert.notEqual(after.content, before.content);
  assert.match(after.content, /\$22\b/);
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'environment'), 'utf8'), generatedSkill('environment.md', after.content));
  // Boot N+1 with an interrupted generation left over from boot N.
  f.fault({ method: 'renameSync', path: f.target(0, 'environment') });
  assert.equal((await settings(33)).skillDistribution.ok, false);
  f.fault({});
  await f.stop(); await f.start();
  const booted = (await f.api('environment.md')).body;
  assert.equal(booted.pending, null); assert.equal(booted.readOnly, true);
  assert.match(booted.content, /\$33\b/);
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'environment'), 'utf8'), generatedSkill('environment.md', booted.content));
  assert.doesNotMatch(f.log, /An incomplete save must be retried/);
});
