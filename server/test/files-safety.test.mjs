// Real file routes in an isolated server: conditional upload publication and
// configured-folder dependency guards. Never touches the live workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-files-safety-'));
const WORK = path.join(DATA_DIR, 'workspaces');
// An old record with no explicit path is migrated to its id at boot. Dependency
// checks must use that same effective default, even though it is stopped.
fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify([{
  id: 'legacy-default', name: 'legacy-default-agent', cli: 'shell',
  createdAt: '2026-09-01T00:00:00.000Z', everStarted: false,
}]));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const PORT = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const API = `http://127.0.0.1:${PORT}`;
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, DATA_DIR: inheritedData, PORT: inheritedPort,
  PUBLIC_DIR, ...BASE_ENV } = process.env;
const server = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...BASE_ENV, PORT: String(PORT), DATA_DIR, HOME: path.join(DATA_DIR, 'home'),
    AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const api = async (route, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (init.method && init.method !== 'GET') headers.set('x-am-origin', 'operator');
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${API}${route}`, { ...init, headers });
  const responseBody = await response.json().catch(() => null);
  return { status: response.status, body: responseBody };
};
const createSession = async (name, cli, workspace) => (await api('/api/sessions', {
  method: 'POST', body: JSON.stringify({ name, cli, path: workspace }),
})).body;
const upload = (id, folder, name, bytes, token) => api(
  `/api/files/${id}/upload?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`,
  { method: 'POST', headers: {
    'content-type': 'application/octet-stream',
    ...(token ? { 'x-am-replace-token': token } : {}),
  }, body: bytes },
);

try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await fetch(`${API}/api/health`).then((response) => response.ok).catch(() => false)) break;
    await sleep(100);
  }
  assert.ok(log.includes(`:${PORT}`), `server did not start: ${log.slice(-1000)}`);

  const files = await createSession('files', 'files', '.');
  const nested = await createSession('nested-agent', 'shell', 'team/nested');
  const sharedOne = await createSession('shared-one', 'shell', 'shared');
  await createSession('shared-two', 'shell', 'shared');
  assert.ok(files?.id && nested?.id && sharedOne?.id);
  fs.writeFileSync(path.join(WORK, 'team', 'nested', 'sentinel.txt'), 'NESTED');
  fs.writeFileSync(path.join(WORK, 'shared', 'sentinel.txt'), 'SHARED');
  fs.writeFileSync(path.join(WORK, 'legacy-default', 'sentinel.txt'), 'DEFAULT');

  const renameAncestor = await api(`/api/files/${files.id}/rename`, {
    method: 'POST', body: JSON.stringify({ path: 'team', name: 'renamed-team' }),
  });
  assert.equal(renameAncestor.status, 409);
  assert.match(renameAncestor.body.error, /nested-agent.*workspace/);
  assert.equal(fs.readFileSync(path.join(WORK, 'team', 'nested', 'sentinel.txt'), 'utf8'), 'NESTED');

  const deleteAncestor = await api(`/api/files/${files.id}/entry?path=team`, { method: 'DELETE' });
  assert.equal(deleteAncestor.status, 409);
  const moveAncestor = await api(`/api/files/${files.id}/move`, {
    method: 'POST', body: JSON.stringify({ path: 'team', to: '' }),
  });
  assert.equal(moveAncestor.status, 200, 'moving a protected folder to its current parent is a safe no-op');
  const renameNoop = await api(`/api/files/${files.id}/rename`, {
    method: 'POST', body: JSON.stringify({ path: 'team', name: 'team' }),
  });
  assert.equal(renameNoop.status, 200, 'renaming a protected folder to its current name is a safe no-op');

  const exactShared = await api(`/api/files/${files.id}/entry?path=shared`, { method: 'DELETE' });
  assert.equal(exactShared.status, 409);
  assert.match(exactShared.body.error, /shared-one.*workspace/);
  const exactDefault = await api(`/api/files/${files.id}/entry?path=legacy-default`, { method: 'DELETE' });
  assert.equal(exactDefault.status, 409);
  assert.match(exactDefault.body.error, /legacy-default-agent.*workspace/);
  const skills = await api(`/api/files/${files.id}/rename`, {
    method: 'POST', body: JSON.stringify({ path: 'skills', name: 'skills-away' }),
  });
  assert.equal(skills.status, 409);
  assert.match(skills.body.error, /shared skills/);

  fs.symlinkSync(path.join(WORK, 'team'), path.join(WORK, 'team-alias'));
  const alias = await api(`/api/files/${files.id}/rename`, {
    method: 'POST', body: JSON.stringify({ path: 'team-alias', name: 'alias-away' }),
  });
  assert.equal(alias.status, 409);
  assert.match(alias.body.error, /nested-agent.*workspace/);

  fs.mkdirSync(path.join(WORK, 'teamish'));
  fs.writeFileSync(path.join(WORK, 'teamish', 'unrelated.txt'), 'UNRELATED');
  const sibling = await api(`/api/files/${files.id}/rename`, {
    method: 'POST', body: JSON.stringify({ path: 'teamish', name: 'teamish-renamed' }),
  });
  assert.equal(sibling.status, 200);
  assert.equal(fs.readFileSync(path.join(WORK, 'teamish-renamed', 'unrelated.txt'), 'utf8'), 'UNRELATED');

  const sessionsBefore = fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8');
  assert.equal(fs.existsSync(path.join(WORK, 'team', 'nested')), true);
  assert.equal(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'), sessionsBefore,
    'forbidden file operations do not rewrite session configuration');

  const created = await upload(files.id, '', 'report.txt', 'ORIGINAL');
  assert.equal(created.status, 200);
  const collision = await upload(files.id, '', 'report.txt', 'SILENT-OVERWRITE');
  assert.equal(collision.status, 409);
  assert.deepEqual({ code: collision.body.code, name: collision.body.name, path: collision.body.path },
    { code: 'file-exists', name: 'report.txt', path: 'report.txt' });
  assert.match(collision.body.revision, /^sha256:/);
  assert.match(collision.body.replaceToken, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(WORK, 'report.txt'), 'utf8'), 'ORIGINAL');

  const replaced = await upload(files.id, '', 'report.txt', 'DELIBERATE', collision.body.replaceToken);
  assert.equal(replaced.status, 200);
  assert.equal(fs.readFileSync(path.join(WORK, 'report.txt'), 'utf8'), 'DELIBERATE');
  const staleChoice = await upload(files.id, '', 'report.txt', 'x');
  fs.writeFileSync(path.join(WORK, 'report.txt'), 'CHANGED-BY-AGENT');
  const stale = await upload(files.id, '', 'report.txt', 'STALE', staleChoice.body.replaceToken);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'replacement-stale');
  assert.notEqual(stale.body.replaceToken, staleChoice.body.replaceToken);
  assert.equal(fs.readFileSync(path.join(WORK, 'report.txt'), 'utf8'), 'CHANGED-BY-AGENT');

  const simultaneous = await Promise.all([
    upload(files.id, '', 'race.txt', 'RACE-A'),
    upload(files.id, '', 'race.txt', 'RACE-B'),
  ]);
  assert.deepEqual(simultaneous.map((result) => result.status).sort(), [200, 409]);
  assert.ok(['RACE-A', 'RACE-B'].includes(fs.readFileSync(path.join(WORK, 'race.txt'), 'utf8')));

  fs.writeFileSync(path.join(WORK, 'replace-race.txt'), 'BEFORE');
  const replaceRaceChoice = await upload(files.id, '', 'replace-race.txt', 'x');
  const replaceRace = await Promise.all([
    upload(files.id, '', 'replace-race.txt', 'REPLACE-A', replaceRaceChoice.body.replaceToken),
    upload(files.id, '', 'replace-race.txt', 'REPLACE-B', replaceRaceChoice.body.replaceToken),
  ]);
  assert.deepEqual(replaceRace.map((result) => result.status).sort(), [200, 409]);
  assert.equal(replaceRace.find((result) => result.status === 409).body.code, 'replacement-stale');

  const outside = path.join(DATA_DIR, 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE');
  fs.symlinkSync(outside, path.join(WORK, 'outside-link.txt'));
  const existingLink = await upload(files.id, '', 'outside-link.txt', 'FOLLOW');
  assert.equal(existingLink.status, 400);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
  fs.symlinkSync(path.join(WORK, 'not-there'), path.join(WORK, 'dangling-link.txt'));
  const danglingLink = await upload(files.id, '', 'dangling-link.txt', 'FOLLOW');
  assert.equal(danglingLink.status, 400);
  assert.equal(fs.existsSync(path.join(WORK, 'not-there')), false);

  const outsideDir = path.join(DATA_DIR, 'outside-folder');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(WORK, 'outside-parent'));
  const outsideParent = await upload(files.id, 'outside-parent', 'escaped.txt', 'FOLLOW');
  assert.equal(outsideParent.status, 400);
  assert.equal(fs.existsSync(path.join(outsideDir, 'escaped.txt')), false);

  fs.mkdirSync(path.join(WORK, 'actual-a'));
  fs.mkdirSync(path.join(WORK, 'actual-b'));
  const switcher = path.join(WORK, 'switcher');
  fs.symlinkSync(path.join(WORK, 'actual-a'), switcher);
  const switched = await new Promise((resolve, reject) => {
    const request = http.request(`${API}/api/files/${files.id}/upload?path=switcher&name=switched.txt`, {
      method: 'POST', headers: { 'x-am-origin': 'operator', 'content-type': 'application/octet-stream', 'content-length': 16 },
    }, (response) => {
      let text = ''; response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.write('FIRST-HALF');
    setTimeout(() => {
      fs.unlinkSync(switcher);
      fs.symlinkSync(path.join(WORK, 'actual-b'), switcher);
      request.end('SECOND');
    }, 50);
  });
  assert.equal(switched.status, 409);
  assert.equal(switched.body.code, 'destination-changed');
  assert.equal(fs.existsSync(path.join(WORK, 'actual-a', 'switched.txt')), false);
  assert.equal(fs.existsSync(path.join(WORK, 'actual-b', 'switched.txt')), false);

  fs.writeFileSync(path.join(WORK, 'abort.txt'), 'SURVIVES');
  const abortChoice = await upload(files.id, '', 'abort.txt', 'x');
  await new Promise((resolve) => {
    const request = http.request(`${API}/api/files/${files.id}/upload?path=&name=abort.txt`, {
      method: 'POST', headers: {
        'x-am-origin': 'operator', 'x-am-replace-token': abortChoice.body.replaceToken,
        'content-type': 'application/octet-stream', 'content-length': 100_000,
      },
    });
    request.on('error', () => resolve());
    request.write(Buffer.alloc(1024, 1));
    setTimeout(() => { request.destroy(); resolve(); }, 40);
  });
  await sleep(120);
  assert.equal(fs.readFileSync(path.join(WORK, 'abort.txt'), 'utf8'), 'SURVIVES');
  assert.equal(fs.readdirSync(WORK).some((name) => name.endsWith('.part')), false);

  console.log('file route safety tests passed');
} catch (error) {
  console.error(error);
  console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(3000)]);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
