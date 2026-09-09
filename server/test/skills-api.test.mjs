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
