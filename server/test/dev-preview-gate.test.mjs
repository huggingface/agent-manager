// The AM_DEV_PREVIEW gate on the real route stack: without it the routes do not
// exist and /api/info says nothing; with it, switch requests are validated
// strictly and audited. No request here is valid enough to start a switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { nativeFetch as fetch } from './native-client.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dev-preview-gate-'));

async function start(name, extraEnv) {
  const dir = path.join(root, name);
  const home = path.join(dir, 'home');
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<html>fixture</html>');
  const free = net.createServer(); free.listen(0, '127.0.0.1'); await once(free, 'listening');
  const port = free.address().port; await new Promise((r) => free.close(r));
  // An explicit allowlist, never the parent's environment: this shell may carry
  // live CLI homes and tokens.
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER,
    env: {
      PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', DATA_DIR: path.join(dir, 'data'), PORT: String(port), PUBLIC_DIR: publicDir,
      CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
      AM_REPIN_DIR: path.join(dir, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(dir, 'input-required'), AM_BASHRC: '/nonexistent',
      AM_LOCAL: path.join(dir, 'local'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { base, child, dir, logs: () => logs }; } catch {}
    if (child.exitCode !== null) throw new Error(`server exited:\n${logs}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${logs}`);
}
const stop = async (s) => { s.child.kill('SIGTERM'); if (s.child.exitCode === null) await once(s.child, 'exit'); };
const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' }, body: JSON.stringify(body),
});

test('gate off: no dev-preview route exists and /api/info says nothing', async () => {
  const s = await start('off', {});
  try {
    for (const route of ['/api/dev-preview/status', '/api/dev-preview/prs']) {
      assert.equal((await fetch(`${s.base}${route}`)).status, 404, route);
    }
    for (const route of ['/api/dev-preview/switch', '/api/dev-preview/rollback']) {
      assert.equal((await post(s.base, route, { prs: [{ number: 1 }] })).status, 404, route);
    }
    const info = await (await fetch(`${s.base}/api/info`)).json();
    assert.equal('devPreview' in info, false);
    // Any value but exactly "1" is off.
  } finally { await stop(s); }
  const t = await start('off-true', { AM_DEV_PREVIEW: 'true' });
  try {
    assert.equal((await fetch(`${t.base}/api/dev-preview/status`)).status, 404);
  } finally { await stop(t); }
});

test('gate on: status and info report the running build; switch input is validated and audited', async () => {
  const s = await start('on', { AM_DEV_PREVIEW: '1' });
  try {
    const status = await (await fetch(`${s.base}/api/dev-preview/status`)).json();
    assert.equal(status.repo, 'huggingface/agent-manager');
    assert.equal(status.supervised, false);
    assert.ok(status.running && typeof status.running.label === 'string');
    const info = await (await fetch(`${s.base}/api/info`)).json();
    assert.equal(info.devPreview.repo, 'huggingface/agent-manager');

    const bad = [
      { prs: [{ number: '182' }] },
      { prs: [{ number: 182 }], repo: 'someone/fork' },
      { prs: [{ number: 182, sha: '$(id)' }] },
      { prs: [{ number: -4 }] },
      { prs: [] },
    ];
    for (const body of bad) {
      const r = await post(s.base, '/api/dev-preview/switch', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal((await r.json()).code, 'invalid-input');
    }
    // Valid, but this server is not under the entrypoint supervisor: it could
    // not restart into the build, so it refuses rather than swap.
    const valid = await post(s.base, '/api/dev-preview/switch', { prs: [{ number: 1 }] });
    assert.equal(valid.status, 409);
    assert.equal((await valid.json()).code, 'not-supervised');
    assert.equal((await post(s.base, '/api/dev-preview/rollback', {})).status, 409);
    // Unattributed calls are refused like every other mutating call.
    const anon = await fetch(`${s.base}/api/dev-preview/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prs":[{"number":1}]}' });
    assert.equal(anon.status, 400);
    // Without the protocol marker a switch never reaches the route.
    const raw = await globalThis.fetch(`${s.base}/api/dev-preview/switch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' }, body: '{"prs":[{"number":1}]}' });
    assert.equal(raw.status, 403);

    const ops = fs.readFileSync(path.join(s.dir, 'data', 'operations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const switches = ops.filter((o) => o.path === '/api/dev-preview/switch');
    assert.equal(switches.length, bad.length + 1);
    assert.ok(switches.every((o) => o.origin.id === 'operator' && o.status >= 400));
  } finally { await stop(s); }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
