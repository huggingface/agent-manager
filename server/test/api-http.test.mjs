// Actual production route stack, isolated state, no real agents or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { nativeFetch as fetch } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-api-http-'));
const home = path.join(root, 'home'); fs.mkdirSync(home);
const publicDir = path.join(root, 'public'); fs.mkdirSync(publicDir); fs.writeFileSync(path.join(publicDir, 'index.html'), '<html>fixture SPA</html>');
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `
  import fs from 'node:fs';
  import childProcess from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  import { isMainThread } from 'node:worker_threads';
  // Startup probes installed CLIs with execFile('--version'). Some write to
  // HOME long after HTTP is ready; keep their parent alive until they close.
  // Workers inherit --import too; only the server's main thread owns probes
  // and receives the fixture shutdown message.
  if (isMainThread) {
    const execFile = childProcess.execFile;
    const commands = new Set();
    childProcess.execFile = (...args) => {
      const command = execFile(...args);
      const closed = new Promise((resolve) => command.once('close', resolve));
      commands.add(closed);
      closed.then(() => commands.delete(closed));
      return command;
    };
    syncBuiltinESMExports();
    // Controlled regression: this grandchild writes only AFTER stop is asked
    // for, rather than relying on whichever CLI happens to be installed.
    const lateWrite = childProcess.execFile(process.execPath, ['-e', ${JSON.stringify(`
    const fs = require('node:fs');
    process.stdin.resume();
    process.stdin.once('end', () => setTimeout(() => {
      fs.mkdirSync(process.env.HOME, { recursive: true });
      fs.writeFileSync(process.env.HOME + '/fixture-command-closed', process.argv[1]);
    }, 100));
  `)}, String(process.pid)], () => {});
    process.once('message', async (message) => {
      if (message !== 'fixture-stop') return;
      lateWrite.stdin.end();
      while (commands.size) await Promise.all([...commands]);
      process.kill(process.pid, 'SIGTERM');
    });
  }
  globalThis.fetch = async () => new Response(JSON.stringify({id:process.env.SPACE_ID,private:process.env.FIXTURE_PUBLIC !== '1',runtime:{volumes:[]}}), {status:200,headers:{'content-type':'application/json'}});
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (/am-config\.json/.test(String(file)) && fs.existsSync(process.env.DATA_DIR + '/reject-write')) throw new Error('synthetic-private-data /private/example token_fixture');
    return write(file, ...args);
  };
`);
const free = net.createServer(); free.listen(0, '127.0.0.1'); await once(free, 'listening');
const port = free.address().port; await new Promise((resolve) => free.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, logs = '';
const start = async (locked = false) => {
  child = spawn(process.execPath, ['--import', preload, 'src/index.js'], {
    env: { PATH: process.env.PATH, HOME: home, DATA_DIR: path.join(root, 'data'), PORT: String(port), PUBLIC_DIR: publicDir,
      CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
      AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
      ...(locked ? { SPACE_ID: 'fixture/test', SPACE_HOST: 'fixture-test.hf.space', FIXTURE_PUBLIC: '1' } : {}),
    }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error('fixture server exited');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('fixture server did not start');
};
const stop = async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.send('fixture-stop');
    await closed;
    assert.equal(fs.readFileSync(path.join(home, 'fixture-command-closed'), 'utf8'), String(child.pid),
      'the shutdown-time writer must finish before the server exits and HOME is removed');
  }
};
const call = async (url, body, method = 'POST', headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'x-am-origin': 'operator', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json() };
};
// Replacing stored settings needs the revision being replaced (#123): read it first.
const putConfig = async (body) => {
  const rev = (await call('/api/config', undefined, 'GET')).body.rev;
  return call(`/api/config${rev ? `?base=${encodeURIComponent(rev)}` : ''}`, body, 'PUT');
};
try {
  await start();
  const initial = await call('/api/tree', undefined, 'GET');
  for (const bad of [{ cli: 'files', name: {} }, { cli: 'files', prompt: false }, { cli: 'files', groupId: 'missing' }]) assert.equal((await call('/api/sessions', bad)).status, 400);
  assert.deepEqual((await call('/api/tree', undefined, 'GET')).body, initial.body);
  const session = await call('/api/sessions', { cli: 'files', path: '.', name: 'fixture' }); assert.equal(session.status, 201);
  const id = session.body.id;
  const group = (await call('/api/groups', { name: 'fixture group' })).body;
  assert.equal((await call(`/api/groups/${group.id}`, { sessionIds: [id], layout: { cols: 1, rows: 1 } }, 'PUT')).status, 200);
  const patch = await call(`/api/groups/${group.id}`, { layout: null }, 'PUT'); assert.deepEqual(patch.body.sessionIds, [id]); assert.equal(patch.body.layout, undefined);
  assert.equal((await putConfig({ artifacts: { enabled: false }, jobs: { askAboveUsd: 0 }, backup: { exclude: [] } })).status, 200);
  const config = (await call('/api/config', undefined, 'GET')).body; assert.equal(config.artifacts.enabled, false); assert.deepEqual(config.backup.exclude, []);
  assert.equal((await putConfig({})).status, 200);
  assert.equal((await call('/api/config', undefined, 'GET')).body.artifacts.enabled, true, 'PUT still replaces with defaults');
  assert.equal((await putConfig({ artifacts: { enabled: null } })).status, 400);
  fs.writeFileSync(path.join(root, 'data', 'reject-write'), 'fixture');
  const failedSave = await putConfig({});
  assert.equal(failedSave.status, 500); assert.equal(failedSave.body.code, 'internal-error');
  assert.equal(failedSave.body.error, 'The request could not be completed. Please try again.');
  assert.ok(!failedSave.body.error.includes('am-config.json'), 'the filename is not free-text 5xx prose');
  assert.deepEqual(failedSave.body.details, [{ field: 'path', message: 'am-config.json' }]);
  assert.ok(!JSON.stringify(failedSave).includes('synthetic-private'));
  assert.ok(!JSON.stringify(failedSave).includes(path.join(root, 'data')));
  fs.unlinkSync(path.join(root, 'data', 'reject-write'));
  const file = path.join(root, 'data', 'workspaces', 'fixture.txt'); fs.writeFileSync(file, 'original');
  const preview = (await call(`/api/files/${id}/preview?path=fixture.txt`, undefined, 'GET')).body;
  const badWrite = await call(`/api/files/${id}/write?path=fixture.txt`, { text: 'wrong body' }, 'PUT'); assert.equal(badWrite.status, 400); assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  fs.writeFileSync(file, 'changed');
  const write = await fetch(`${base}/api/files/${id}/write?path=fixture.txt&base=${encodeURIComponent(preview.tag)}`, { method: 'PUT', headers: { 'x-am-origin': 'operator', 'content-type': 'text/plain' }, body: 'draft' });
  assert.equal(write.status, 409); assert.equal((await write.json()).code, 'file-changed'); assert.equal(fs.readFileSync(file, 'utf8'), 'changed');
  const upload = await fetch(`${base}/api/files/${id}/upload?name=fixture.json`, { method: 'POST', headers: { 'x-am-origin': 'operator', 'content-type': 'application/json' }, body: '{"raw":"file"}' });
  assert.equal(upload.status, 200); assert.equal(fs.readFileSync(path.join(root, 'data', 'workspaces', 'fixture.json'), 'utf8'), '{"raw":"file"}');
  const abortedPath = path.join(root, 'data', 'workspaces', 'aborted-fixture.bin');
  const uploading = http.request(`${base}/api/files/${id}/upload?name=aborted-fixture.bin`, {
    method: 'POST', headers: { 'x-am-origin': 'operator', 'x-am-request': '1', 'content-type': 'application/octet-stream', 'content-length': 1000000 },
  });
  uploading.on('error', () => {});
  uploading.write(Buffer.alloc(1024));
  // Uploads are staged beside the destination and published whole (#122), so
  // the destination never exists mid-stream; the staged part file is the trace.
  const staged = () => fs.readdirSync(path.dirname(abortedPath)).filter((name) => /^\.aborted-fixture\.bin\.am-upload-.*\.part$/.test(name));
  for (let i = 0; i < 100 && !staged().length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(staged().length, 'fixture upload began');
  uploading.destroy();
  for (let i = 0; i < 100 && (staged().length || fs.existsSync(abortedPath)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(!staged().length && !fs.existsSync(abortedPath), 'interrupted upload is cleaned up');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!logs.includes('[uncaughtException]'), 'disconnect must not escape the request boundary');
  const empty = await fetch(`${base}/api/files/${id}/write?path=fixture.txt`, { method: 'PUT', headers: { 'x-am-origin': 'operator', 'content-type': 'text/plain' }, body: '' });
  assert.equal(empty.status, 200); assert.equal(fs.readFileSync(file, 'utf8'), '');
  const remote = (await call('/api/sessions', { cli: 'remote', name: 'fixture-remote' })).body;
  const name = remote.remote.name;
  const prompt = await fetch(`${base}/api/remote/${name}/messages`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'synthetic agent response' });
  assert.equal(prompt.status, 200, 'remote route fallback remains attributed');
  const messages = (await call(`/api/sessions/${remote.id}/remote`, undefined, 'GET')).body.messages;
  const rejected = await call(`/api/remote/${name}/messages`, { text: [] }); assert.equal(rejected.status, 400);
  assert.deepEqual((await call(`/api/sessions/${remote.id}/remote`, undefined, 'GET')).body.messages, messages);
  assert.equal((await call(`/api/sessions/${remote.id}/remote/paused`, { paused: true })).status, 200);
  const paused = await call(`/api/remote/${name}/messages`, { text: 'fixture' }); assert.equal(paused.status, 409); assert.equal(paused.body.stop, true); assert.ok(paused.body.reason); assert.ok(paused.body.code);
  const client = (await call('/api/sessions', { cli: 'claude', name: 'not-started' })).body;
  const emptyAttachment = await fetch(`${base}/api/sessions/${client.id}/attachments`, {
    method: 'POST', headers: { 'x-am-origin': 'operator', 'x-am-request': '1', 'content-type': 'application/octet-stream', 'x-file-name': 'empty.txt' }, body: '', signal: AbortSignal.timeout(2000),
  });
  assert.equal(emptyAttachment.status, 413); assert.equal((await emptyAttachment.json()).code, 'payload-too-large');
  const trace = await call(`/api/trace/${client.id}?tail=1&v=2`, undefined, 'GET'); assert.equal(trace.status, 404); assert.equal(trace.body.code, 'no-trace');
  const noShare = await call(`/api/sessions/${client.id}/share`, { visibility: 'public' }); assert.equal(noShare.status, 403); assert.equal(noShare.body.code, 'no-hf-token');
  assert.equal((await call(`/api/sessions/${client.id}/input`, { text: null })).status, 400);
  assert.equal((await call('/api/relaunch')).body.reason, 'no-space');
  const emptyCommand = await call('/api/relaunch', undefined, 'POST', { 'content-type': 'application/json' });
  assert.equal(emptyCommand.status, 200); assert.equal(emptyCommand.body.reason, 'no-space');
  assert.equal((await call('/api/backup/run')).status, 403);
  assert.equal((await call('/api/not-real', undefined, 'GET')).body.code, 'api-not-found');
  assert.match(await (await fetch(base + '/nested/page')).text(), /fixture SPA/);
  const operations = (await call('/api/operations?limit=500', undefined, 'GET')).body.operations;
  const interrupted = operations.filter((entry) => entry.query?.name === 'aborted-fixture.bin');
  assert.equal(interrupted.length, 1); assert.equal(interrupted[0].ok, false);
  assert.ok(operations.some((entry) => entry.status === 500)); assert.ok(!JSON.stringify(operations).includes('synthetic-private')); assert.ok(!logs.includes('synthetic-private'));
  await stop(); await start(true);
  // Locked from boot with reason 'checking' until the visibility monitor has a verdict (#131).
  for (let i = 0; i < 400 && (await call('/api/visibility', undefined, 'GET')).body.reason === 'checking'; i++) await new Promise((r) => setTimeout(r, 25));
  const locked = await call('/api/sessions', { cli: 'files' }); assert.equal(locked.status, 403); assert.equal(locked.body.code, 'locked'); assert.equal(locked.body.reason, 'public-space');
  console.log('Production HTTP: validation, side effects, settings/group semantics, streams/uploads, conflicts, traces, origins, lock and safe errors passed');
} finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
