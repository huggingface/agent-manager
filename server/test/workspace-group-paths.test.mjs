// Workspace path normalization, root-session folder isolation, and persistent
// group folders.
//
// Run with: node test/workspace-group-paths.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ws-group-paths-'));
const UNIT_DATA = path.join(TMP, 'unit-data');
const HTTP_DATA = path.join(TMP, 'http-data');
const HOME_DIR = path.join(TMP, 'home');
const BIN_DIR = path.join(TMP, 'bin');
const PUBLIC_DIR = path.join(TMP, 'public');
for (const dir of [UNIT_DATA, HTTP_DATA, HOME_DIR, BIN_DIR, PUBLIC_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');
// Stub claude binary so POST /api/agents?cli=claude runs offline with zero tokens.
fs.writeFileSync(
  path.join(BIN_DIR, 'claude'),
  '#!/bin/sh\n[ "$1" = --version ] && { echo "1.0.0-stub"; exit 0; }\nsleep 30\n',
  { mode: 0o755 },
);

process.env.DATA_DIR = UNIT_DATA;
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude-cfg');
process.env.CODEX_HOME = path.join(TMP, 'codex-home');

const cfg = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const groups = await import('../src/groups.js');
const runner = await import('../src/runner.js');
cfg.ensureDirs();
sessions.init();
groups.init();

// ---------- 1. cleanRelPath ----------
console.log('1. cleanRelPath normalizes in-root absolute paths and rejects outside/traversal paths');
const WS = '/data/workspaces';
assert.equal(cfg.cleanRelPath('/data/workspaces/foo', WS), 'foo');
assert.equal(cfg.cleanRelPath('/data/workspaces/foo/bar', WS), 'foo/bar');
assert.equal(cfg.cleanRelPath('/data/workspaces', WS), '');
assert.equal(cfg.cleanRelPath('/data/workspaces/', WS), '');
assert.equal(cfg.cleanRelPath('data/workspaces/foo', WS), 'foo');
assert.equal(cfg.cleanRelPath('data/workspaces', WS), '');
assert.equal(cfg.cleanRelPath('/etc/passwd', WS), null);
assert.equal(cfg.cleanRelPath('/data/workspaces2/foo', WS), null);
assert.equal(cfg.cleanRelPath('/data/workspaces/../escape', WS), null);
assert.equal(cfg.cleanRelPath('/data/workspaces/foo/../bar', WS), null);
assert.equal(cfg.cleanRelPath('../escape', WS), null);
assert.equal(cfg.cleanRelPath('sub/../escape', WS), null);
assert.equal(cfg.cleanRelPath('.', WS), '');
assert.equal(cfg.cleanRelPath('', WS), '');
assert.equal(cfg.cleanRelPath('   ', WS), '');
assert.equal(cfg.cleanRelPath('sub/dir', WS), 'sub/dir');
assert.equal(cfg.cleanRelPath('./sub/dir/', WS), 'sub/dir');
assert.equal(cfg.cleanRelPath('workspaces/legit', WS), 'workspaces/legit');
assert.equal(cfg.cleanRelPath(null, WS), null);

// ---------- 2. foldersOverlap & folderIsShared ----------
console.log('2. foldersOverlap / folderIsShared isolate root sessions from subfolder projects');
assert.equal(runner.foldersOverlap(WS, path.join(WS, 'proj-a'), WS), false);
assert.equal(runner.foldersOverlap(path.join(WS, 'proj-a'), WS, WS), false);
assert.equal(runner.foldersOverlap(WS, WS, WS), true);
assert.equal(runner.foldersOverlap(path.join(WS, 'proj-a'), path.join(WS, 'proj-a'), WS), true);
assert.equal(runner.foldersOverlap(path.join(WS, 'proj-a'), path.join(WS, 'proj-a', 'wt'), WS), true);
assert.equal(runner.foldersOverlap(path.join(WS, 'proj-a', 'wt'), path.join(WS, 'proj-a'), WS), true);
assert.equal(runner.foldersOverlap(path.join(WS, 'proj-a'), path.join(WS, 'proj-b'), WS), false);
assert.equal(runner.foldersOverlap(path.join(WS, 'proj-a'), path.join(WS, 'proj-a2'), WS), false);

if (!runner.ghosttyReady()) {
  console.log('  SKIP live PTY folderIsShared check (libghostty-vt unavailable)');
} else {
  const unitWs = cfg.WORKSPACES_DIR;
  const projADir = path.join(unitWs, 'proj-a');
  const projAWtDir = path.join(unitWs, 'proj-a', 'wt');
  fs.mkdirSync(projAWtDir, { recursive: true });
  const rootOne = sessions.create({ name: 'root-1', cli: 'shell', path: '' });
  const rootTwo = sessions.create({ name: 'root-2', cli: 'shell', path: '' });
  const projA = sessions.create({ name: 'proj-a-main', cli: 'shell', path: 'proj-a' });
  const projAWt = sessions.create({ name: 'proj-a-wt', cli: 'shell', path: 'proj-a/wt' });
  try {
    runner.ensureRunning(rootOne, 80, 24);
    runner.ensureRunning(projA, 80, 24);
    assert.equal(
      runner.folderIsShared(projA.id, projADir, 'shell'),
      false,
      'running root session (path: "") must NOT poison /workspaces/proj-a',
    );
    assert.equal(
      runner.folderIsShared(rootOne.id, unitWs, 'shell'),
      false,
      'running subfolder session must NOT mark the root as shared',
    );
    runner.ensureRunning(rootTwo, 80, 24);
    assert.equal(
      runner.folderIsShared(rootOne.id, unitWs, 'shell'),
      true,
      'two running root sessions (path: "") DO share the root',
    );
    runner.ensureRunning(projAWt, 80, 24);
    assert.equal(
      runner.folderIsShared(projA.id, projADir, 'shell'),
      true,
      'proj-a and proj-a/wt DO overlap',
    );
    assert.equal(
      runner.folderIsShared(projAWt.id, projAWtDir, 'shell'),
      true,
      'proj-a/wt sees proj-a as overlapping',
    );
  } finally {
    for (const s of [rootOne, rootTwo, projA, projAWt]) runner.stop(s.id);
  }
}

// ---------- 3. groups unit checks ----------
console.log('3. groups.create / update / effectivePath unit checks');
const plainGroup = groups.create('Plain');
assert.equal(plainGroup.path, undefined);
assert.equal(groups.effectivePath(plainGroup.id), undefined);

const memberSess = sessions.create({ name: 'member-1', cli: 'claude', path: 'derived-dir' });
const filesSess = sessions.create({ name: 'files-1', cli: 'files', path: '' });
groups.attach(plainGroup.id, filesSess.id);
groups.attach(plainGroup.id, memberSess.id);
assert.equal(groups.effectivePath(plainGroup.id), 'derived-dir', 'skips passive panes and derives member path');

const folderGroup = groups.create('With Folder', { path: 'explicit-dir' });
assert.equal(folderGroup.path, 'explicit-dir');
assert.equal(groups.effectivePath(folderGroup.id), 'explicit-dir');
groups.update(folderGroup.id, { name: 'Renamed Folder Group' });
assert.equal(groups.get(folderGroup.id).path, 'explicit-dir', 'unrelated update keeps path');
groups.update(folderGroup.id, { path: null });
assert.equal(groups.get(folderGroup.id).path, undefined, 'path: null clears stored path');

// ---------- 4. HTTP routes: /api/sessions, /api/groups, /api/agents + reload ----------
console.log('4. HTTP routes persist group path across reload, reject traversal, and route root spawns');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const serverCwd = fileURLToPath(new URL('../', import.meta.url));
const httpWorkspaces = path.join(HTTP_DATA, 'workspaces');

let srv = null;
let srvLogs = '';
async function startServer() {
  const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...baseEnv } = process.env;
  srv = spawn(process.execPath, ['src/index.js'], {
    cwd: serverCwd,
    env: {
      ...baseEnv,
      PATH: `${BIN_DIR}:${baseEnv.PATH || ''}`,
      HOME: HOME_DIR,
      DATA_DIR: HTTP_DATA,
      PORT: String(port),
      AM_BIND_HOST: '127.0.0.1',
      PUBLIC_DIR,
      CLAUDE_CONFIG_DIR: path.join(HOME_DIR, 'claude'),
      CODEX_HOME: path.join(HOME_DIR, 'codex'),
      XDG_CONFIG_HOME: path.join(HOME_DIR, 'config'),
      XDG_DATA_HOME: path.join(HOME_DIR, 'share'),
      AM_REPIN_DIR: path.join(TMP, 'http-repin'),
      AM_INPUT_REQUIRED_DIR: path.join(TMP, 'http-input'),
      AM_LOCAL: path.join(TMP, 'local'),
      AM_BASHRC: '/nonexistent',
      ANTHROPIC_API_KEY: 'sk-ant-test-dummy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { srvLogs += d; });
  srv.stderr.on('data', (d) => { srvLogs += d; });
  for (let i = 0; i < 150; i++) {
    const ok = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    if (srv.exitCode !== null) throw new Error(`server exited early:\n${srvLogs}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server startup timed out:\n${srvLogs}`);
}

async function stopServer() {
  if (srv && srv.exitCode === null && srv.signalCode === null) {
    const done = once(srv, 'exit');
    srv.kill('SIGTERM');
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    if (srv.exitCode === null) srv.kill('SIGKILL');
  }
}

async function call(route, method = 'GET', body = undefined) {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: {
      'x-am-request': '1',
      'x-am-origin': 'operator',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

try {
  await startServer();

  // Absolute path inside WORKSPACES_DIR on POST /api/sessions strips prefix cleanly.
  const absSess = await call('/api/sessions', 'POST', {
    name: 'abs-in-ws',
    cli: 'shell',
    path: path.join(httpWorkspaces, 'my-proj'),
  });
  assert.equal(absSess.status, 201, JSON.stringify(absSess.body));
  assert.equal(absSess.body.path, 'my-proj');
  assert.equal(fs.existsSync(path.join(httpWorkspaces, 'data')), false, 'no double-prefixed folder created');

  // Absolute path outside WORKSPACES_DIR is rejected.
  const outsideSess = await call('/api/sessions', 'POST', {
    name: 'outside',
    cli: 'shell',
    path: '/etc/passwd',
  });
  assert.equal(outsideSess.status, 400);
  assert.equal(outsideSess.body.error, 'bad path');

  // Empty group creation with path: "my-team" persists across POST, GET, tree, and reload.
  const createdGroup = await call('/api/groups', 'POST', { name: 'My Team', path: 'my-team' });
  assert.equal(createdGroup.status, 201, JSON.stringify(createdGroup.body));
  assert.equal(createdGroup.body.path, 'my-team');
  assert.deepEqual(createdGroup.body.sessionIds, []);

  const listedBefore = await call('/api/groups', 'GET');
  assert.equal(listedBefore.status, 200);
  assert.equal(listedBefore.body.find((g) => g.id === createdGroup.body.id)?.path, 'my-team');

  const treeBefore = await call('/api/tree', 'GET');
  assert.equal(treeBefore.body.groups.find((g) => g.id === createdGroup.body.id)?.path, 'my-team');

  // Restart server and verify group path persisted on disk.
  await stopServer();
  await startServer();

  const listedAfter = await call('/api/groups', 'GET');
  assert.equal(listedAfter.status, 200);
  assert.equal(listedAfter.body.find((g) => g.id === createdGroup.body.id)?.path, 'my-team');

  // POST /api/groups rejects traversal and outside paths.
  const badCreate = await call('/api/groups', 'POST', { name: 'Bad', path: '../bad' });
  assert.equal(badCreate.status, 400);
  assert.equal(badCreate.body.error, 'bad path');

  const absGroup = await call('/api/groups', 'POST', {
    name: 'Abs Group',
    path: path.join(httpWorkspaces, 'abs-team'),
  });
  assert.equal(absGroup.status, 201);
  assert.equal(absGroup.body.path, 'abs-team');

  // PUT /api/groups/:id updates, preserves, rejects traversal, and clears path.
  const updatedPath = await call(`/api/groups/${createdGroup.body.id}`, 'PUT', { path: 'updated-team' });
  assert.equal(updatedPath.status, 200);
  assert.equal(updatedPath.body.path, 'updated-team');

  const renamedOnly = await call(`/api/groups/${createdGroup.body.id}`, 'PUT', { name: 'My Team Renamed' });
  assert.equal(renamedOnly.status, 200);
  assert.equal(renamedOnly.body.path, 'updated-team');

  const badUpdate = await call(`/api/groups/${createdGroup.body.id}`, 'PUT', { path: '../bad' });
  assert.equal(badUpdate.status, 400);
  assert.equal(badUpdate.body.error, 'bad path');
  assert.equal((await call('/api/groups', 'GET')).body.find((g) => g.id === createdGroup.body.id)?.path, 'updated-team');

  // Root-level coordinator spawning into a group with an effectivePath lands in the group's folder.
  const rootCoord = (await call('/api/sessions', 'POST', { name: 'coord', cli: 'shell', path: '.' })).body;
  assert.equal(rootCoord.path, '');
  const spawnIntoGroup = await fetch(
    `${base}/api/agents?cli=claude&name=worker-1&group=${encodeURIComponent(createdGroup.body.id)}&from=${encodeURIComponent(rootCoord.id)}`,
    {
      method: 'POST',
      headers: { 'x-am-request': '1', 'content-type': 'text/plain' },
      body: 'implement feature',
    },
  );
  const spawnedBody = await spawnIntoGroup.json();
  assert.equal(spawnIntoGroup.status, 201, JSON.stringify(spawnedBody));
  assert.equal(spawnedBody.path, 'updated-team');

  // Non-root caller still defaults to its own folder even when spawning into another group.
  const ownDirCaller = (await call('/api/sessions', 'POST', { name: 'own-caller', cli: 'shell', path: 'caller-own' })).body;
  const spawnFromOwn = await fetch(
    `${base}/api/agents?cli=claude&name=worker-2&group=${encodeURIComponent(createdGroup.body.id)}&from=${encodeURIComponent(ownDirCaller.id)}`,
    {
      method: 'POST',
      headers: { 'x-am-request': '1', 'content-type': 'text/plain' },
      body: 'review code',
    },
  );
  const spawnedOwnBody = await spawnFromOwn.json();
  assert.equal(spawnFromOwn.status, 201, JSON.stringify(spawnedOwnBody));
  assert.equal(spawnedOwnBody.path, 'caller-own');

  // Clearing g.path with null removes it cleanly.
  const cleared = await call(`/api/groups/${createdGroup.body.id}`, 'PUT', { path: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.path, undefined);

  console.log('workspace-group-paths: all unit and HTTP checks passed');
} finally {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
}
