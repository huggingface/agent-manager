import { nativeFetch as fetch } from './native-client.mjs';
// Range requests on the raw-bytes routes the video/audio previews play from:
// 206 with exactly the asked bytes, open-ended and suffix ranges, 416 for a
// range that can't be met, and the same lock and path checks as before. The
// ranges themselves are res.sendFile's (the `send` module); this pins them.
// Real server process on an isolated DATA_DIR; never touches the live workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { kindOfName, mimeOf } from '../src/preview.js';

// Kinds and types: real media types, still nosniff-safe (nothing scriptable).
for (const [name, kind, mime] of [
  ['a.mp4', 'video', 'video/mp4'], ['a.webm', 'video', 'video/webm'], ['a.MOV', 'video', 'video/quicktime'],
  ['a.m4v', 'video', 'video/mp4'], ['a.ogv', 'video', 'video/ogg'], ['a.mkv', 'video', 'video/x-matroska'],
  ['a.mp3', 'audio', 'audio/mpeg'], ['a.wav', 'audio', 'audio/wav'], ['a.ogg', 'audio', 'audio/ogg'],
  ['a.m4a', 'audio', 'audio/mp4'], ['a.flac', 'audio', 'audio/flac'],
]) {
  assert.equal(kindOfName(name), kind, name);
  assert.equal(mimeOf(name, kind), mime, name);
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-media-range-'));
const WORK = path.join(DATA_DIR, 'workspaces');
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const PORT = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, DATA_DIR: inheritedData, PORT: inheritedPort,
  PUBLIC_DIR, ...BASE_ENV } = process.env;
let server, log = '';
// `locked` boots it as a Space the (fake) Hub reports public, which the manager
// answers by refusing every privileged route, /raw included.
const boot = async (locked = false) => {
  server = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...BASE_ENV, PORT: String(PORT), DATA_DIR, HOME: path.join(DATA_DIR, 'home'),
      AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1', HF_TOKEN: '', AM_FILE_LINK_ROOTS: '{}',
      ...(locked ? { SPACE_ID: 'fixture/media', SPACE_HOST: `127.0.0.1:${PORT}`, HF_ENDPOINT: HUB } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await fetch(`${API}/api/health`).then((response) => response.ok).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`server did not start: ${log.slice(-1000)}`);
};
const halt = async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
};

// The fake Hub the locked boot asks whether this Space is private.
const hub = express();
hub.get('/api/spaces/:owner/:name', (req, res) => res.json({ id: 'fixture/media', private: false, runtime: { volumes: [] } }));
const hubServer = hub.listen(0, '127.0.0.1');
await new Promise((resolve) => hubServer.once('listening', resolve));
const HUB = `http://127.0.0.1:${hubServer.address().port}`;

try {
  await boot();
  const created = await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' },
    body: JSON.stringify({ name: 'media', cli: 'files', path: 'media' }),
  }).then((r) => r.json());
  assert.ok(created?.id, JSON.stringify(created));
  fs.mkdirSync(path.join(WORK, 'media'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'media', 'clip.webm'), BYTES);
  fs.writeFileSync(path.join(DATA_DIR, 'outside.webm'), BYTES);
  fs.symlinkSync(path.join(DATA_DIR, 'outside.webm'), path.join(WORK, 'media', 'escape.webm'));

  const routes = {
    files: (file) => `${API}/api/files/${created.id}/raw?path=${encodeURIComponent(file)}`,
    // Every check runs against both raw routes, on the real app (its error
    // handling included): the Files pane's and shared links'.
    links: (file) => `${API}/api/file-links/raw?${new URLSearchParams({ root: 'workspace', file: `media/${file}` })}`,
  };
  for (const [label, url] of Object.entries(routes)) {
    const get = (range, init = {}) => fetch(url('clip.webm'), { ...init, headers: range ? { range } : {} });

    const whole = await get();
    assert.equal(whole.status, 200, label);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes', `${label}: advertises ranges`);
    assert.equal(whole.headers.get('content-type'), 'video/webm', label);
    assert.equal(whole.headers.get('x-content-type-options'), 'nosniff', label);
    assert.ok(BYTES.equals(Buffer.from(await whole.arrayBuffer())), label);

    for (const [range, start, end] of [
      ['bytes=0-99', 0, 99], ['bytes=500-', 500, 999], ['bytes=-100', 900, 999],
      ['bytes=990-5000', 990, 999], ['bytes=0-0', 0, 0],
    ]) {
      const r = await get(range);
      assert.equal(r.status, 206, `${label} ${range}`);
      assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/1000`, `${label} ${range}`);
      assert.equal(r.headers.get('content-length'), String(end - start + 1), `${label} ${range}`);
      assert.equal(r.headers.get('accept-ranges'), 'bytes', `${label} ${range}`);
      assert.equal(r.headers.get('content-type'), 'video/webm', `${label} ${range}`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${label} ${range}`);
      assert.match(r.headers.get('content-security-policy'), /^sandbox /, `${label} ${range}`);
      assert.ok(BYTES.subarray(start, end + 1).equals(Buffer.from(await r.arrayBuffer())), `${label} ${range} bytes`);
    }
    const head = await get('bytes=10-19', { method: 'HEAD' });
    assert.equal(head.status, 206, `${label} HEAD`);
    assert.equal(head.headers.get('content-range'), 'bytes 10-19/1000', `${label} HEAD`);

    // Unsatisfiable or malformed: 416 with `bytes */size`. send (behind
    // res.sendFile) serves the whole file for a multi-range request or another
    // unit, both of which HTTP allows.
    for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0', 'bytes=50-10', 'bytes=abc']) {
      const r = await get(range);
      assert.equal(r.status, 416, `${label} ${range}`);
      assert.equal(r.headers.get('content-range'), 'bytes */1000', `${label} ${range}`);
      await r.arrayBuffer();
    }
    for (const range of ['bytes=0-9,20-29', 'items=0-9']) {
      const r = await get(range);
      assert.equal(r.status, 200, `${label} ${range}`);
      assert.ok(BYTES.equals(Buffer.from(await r.arrayBuffer())), `${label} ${range}`);
    }

    // The path checks run before any range is looked at.
    for (const file of ['../outside.webm', 'escape.webm', 'missing.webm']) {
      const r = await fetch(url(file), { headers: { range: 'bytes=0-9' } });
      assert.ok(r.status === 403 || r.status === 404, `${label} ${file}: ${r.status}`);
      assert.equal(r.headers.get('content-range'), null, `${label} ${file}`);
      await r.arrayBuffer();
    }
  }

  // The privacy lock still applies: a locked manager serves no bytes, ranged
  // or not.
  await halt(); await boot(true);
  for (let i = 0; i < 400 && (await fetch(`${API}/api/visibility`).then((r) => r.json())).reason === 'checking'; i++) await sleep(25);
  const lockedRead = await fetch(routes.files('clip.webm'), { headers: { range: 'bytes=0-9' } });
  assert.equal(lockedRead.status, 403);
  assert.equal((await lockedRead.json()).code, 'locked');
  console.log('media range: ok');
} finally {
  await halt();
  hubServer.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
