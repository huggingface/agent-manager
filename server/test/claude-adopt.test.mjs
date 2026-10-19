// Adopting an existing Claude conversation: validation unit checks, the am-adopt
// helper, and the real HTTP routes against an isolated AM. Nothing is launched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {nativeFetch as fetch} from './native-client.mjs';
import {checkAdoption, findTranscripts, projectDirName} from '../src/claude-adopt.js';
import {parseArgs, newestTranscript, workspaceFolder} from '../../scripts/am-adopt.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-adopt-'));
const data = path.join(root, 'data'), home = path.join(root, 'home'), claudeDir = path.join(home, 'claude');
const workspaces = path.join(data, 'workspaces'), folder = path.join(workspaces, 'proj');
for (const d of [home, folder, path.join(root, 'public')]) fs.mkdirSync(d, {recursive: true});
fs.writeFileSync(path.join(root, 'public', 'index.html'), '<html>fixture</html>');
const transcript = (cwd, uuid) => {
  const dir = path.join(claudeDir, 'projects', projectDirName(cwd));
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({type: 'user', sessionId: uuid, cwd}) + '\n');
  return file;
};
const atRoot = randomUUID(), inProj = randomUUID(), owned = randomUUID(), missing = randomUUID();
transcript(workspaces, atRoot); transcript(folder, inProj); transcript(workspaces, owned);

// ---- unit: validation ----
assert.equal(projectDirName('/home/u/srv/agent-manager-data/workspaces'), '-home-u-srv-agent-manager-data-workspaces');
assert.deepEqual(findTranscripts(atRoot, claudeDir).length, 1);
const sessions = [{id: 'owner', cli: 'claude', sessionUuid: owned, archivedAt: '2026-01-01'}];
const check = (over) => checkAdoption({uuid: atRoot, cli: 'claude', prompt: '', workdir: workspaces, sessions, configDir: claudeDir, ...over});
assert.ok(check({}).transcript.endsWith(`${atRoot}.jsonl`));
assert.equal(check({cli: 'codex'}).code, 'adopt-cli');
for (const uuid of ['nope', atRoot.toUpperCase(), undefined, `${atRoot}/../x`]) assert.equal(check({uuid}).code, 'adopt-uuid', String(uuid));
assert.equal(check({prompt: 'start working'}).code, 'adopt-prompt');
assert.equal(check({uuid: owned}).code, 'adopt-in-use', 'archived sessions still own their conversation');
assert.equal(check({uuid: missing}).code, 'adopt-no-transcript');
assert.equal(check({uuid: inProj}).code, 'adopt-wrong-folder', 'resume only works from the recorded folder');
assert.ok(check({uuid: inProj, workdir: folder}).transcript);

// ---- unit: am-adopt helper ----
assert.deepEqual(parseArgs([atRoot, '--name', 'Doc', '--group', 'g', '--dry-run']), {uuid: atRoot, name: 'Doc', group: 'g', dryRun: true});
assert.throws(() => parseArgs(['--name']), /needs a value/);
assert.throws(() => parseArgs([atRoot, 'extra']), /unexpected/);
assert.equal(workspaceFolder(workspaces, workspaces), '');
assert.equal(workspaceFolder(folder, workspaces), 'proj');
assert.equal(workspaceFolder(root, workspaces), null);
const later = transcript(folder, randomUUID());
fs.utimesSync(later, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
assert.equal(newestTranscript(folder, claudeDir), path.basename(later, '.jsonl'));
assert.equal(newestTranscript(path.join(root, 'nowhere'), claudeDir), null);

// ---- HTTP: real routes, isolated state ----
const caller = {id: 'caller', name: 'caller', cli: 'shell', path: 'proj', sessionUuid: randomUUID(), createdAt: new Date().toISOString()};
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([caller, {...sessions[0], name: 'owner', path: ''}]));
const free = net.createServer().listen(0, '127.0.0.1'); await once(free, 'listening');
const port = free.address().port; await new Promise((r) => free.close(r));
const base = `http://127.0.0.1:${port}`;
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const orig=cp.execFile;cp.execFile=(...a)=>{if(a[1]?.includes('--version')){queueMicrotask(()=>a.at(-1)(new Error('fixture')));return;}return orig(...a)};syncBuiltinESMExports();globalThis.fetch=async()=>new Response(JSON.stringify({private:true}),{status:200});`);
const call = async (route, {json, text} = {}) => {
  const headers = {'x-am-request': '1', 'x-am-message-id': randomUUID()};
  if (json) { headers['content-type'] = 'application/json'; headers['x-am-origin'] = 'operator'; }
  if (text !== undefined) headers['content-type'] = 'text/plain';
  const r = await fetch(base + route, {method: json || text !== undefined ? 'POST' : 'GET', headers, body: json ? JSON.stringify(json) : text, signal: AbortSignal.timeout(10000)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
const post = (route, opts = {}) => call(route, {text: '', ...opts});
let child;
try {
  child = spawn(process.execPath, ['--import', preload, 'src/index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {PATH: process.env.PATH, HOME: home, DATA_DIR: data, PORT: String(port), AM_BIND_HOST: '127.0.0.1', PUBLIC_DIR: path.join(root, 'public'), CLAUDE_CONFIG_DIR: claudeDir, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'), AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input'), AM_BASHRC: '/nonexistent'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await call('/api/health')).status === 200; } catch {}
    if (child.exitCode !== null) throw new Error('AM fixture exited');
    if (!ready) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready);

  // Operator route: POST /api/sessions with adoptSessionUuid.
  const refusedPrompt = await call('/api/sessions', {json: {cli: 'claude', path: '', adoptSessionUuid: atRoot, prompt: 'go'}});
  assert.equal(refusedPrompt.status, 400); assert.equal(refusedPrompt.body.code, 'adopt-prompt');
  assert.equal((await call('/api/sessions', {json: {cli: 'codex', path: '', adoptSessionUuid: atRoot}})).body.code, 'adopt-cli');
  assert.equal((await call('/api/sessions', {json: {cli: 'claude', path: '', adoptSessionUuid: owned}})).status, 409);
  assert.equal((await call('/api/sessions', {json: {cli: 'claude', path: '', adoptSessionUuid: missing}})).status, 404);
  const made = await call('/api/sessions', {json: {cli: 'claude', name: 'HF doc', path: '', adoptSessionUuid: atRoot}});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.sessionUuid, atRoot); assert.equal(made.body.everStarted, true);
  assert.equal(made.body.state, 'stopped'); assert.equal(made.body.path, ''); assert.match(made.body.note, /Exit the original Claude process/);
  assert.equal((await call('/api/sessions', {json: {cli: 'claude', path: '', adoptSessionUuid: atRoot}})).body.code, 'adopt-in-use', 'no second adoption');

  // Agent routes: alias and ?adoptSessionUuid on POST /api/agents; default folder is the caller's.
  assert.equal((await post(`/api/agents/adopt?adoptSessionUuid=${inProj}&from=caller`, {text: 'do work'})).body.code, 'adopt-prompt');
  assert.equal((await post(`/api/agents/adopt?adoptSessionUuid=${inProj}&path=&from=caller`)).body.code, 'adopt-wrong-folder');
  assert.equal((await post(`/api/agents/adopt?adoptSessionUuid=${inProj}`)).status, 400, 'from is required');
  assert.equal((await post(`/api/agents?cli=codex&adoptSessionUuid=${inProj}&from=caller`)).body.code, 'adopt-cli');
  const agent = await post(`/api/agents?cli=claude&adoptSessionUuid=${inProj}&name=Adopted&group=none&from=caller`);
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  assert.equal(agent.body.path, 'proj'); assert.equal(agent.body.cli, 'claude'); assert.equal(agent.body.adopted, true);
  const row = (await call(`/api/agents/${agent.body.id}`)).body;
  assert.equal(row.state, 'stopped');
  const persisted = JSON.parse(fs.readFileSync(path.join(data, 'sessions.json'), 'utf8'));
  for (const id of [made.body.id, agent.body.id]) {
    const s = persisted.find((x) => x.id === id);
    assert.equal(s.everStarted, true); assert.ok(!s.pendingPrompt); assert.ok(s.adoptedAt);
  }
  assert.equal((await call(`/api/agents/${made.body.id}`)).body.state, 'stopped', 'nothing was launched');
  console.log('Claude adopt: validation, am-adopt helper, operator and agent routes, no launch — passed.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  fs.rmSync(root, {recursive: true, force: true});
}
