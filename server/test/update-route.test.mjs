// POST /api/update as a route: it ANSWERS, it never throws.
//
// Every failure in this route used to reach the operator as "Request failed."
// — errorEnvelope replaces the body of any 5xx wholesale, so a thrown error
// arrives with nothing to act on. Each refusal now carries a reason.
//
// The temp-directory failure that used to jam the single-run latch is pinned in
// update-deploy.test.mjs instead, over `exclusively`, which this route now
// holds the latch with. It cannot be driven from here: the route needs a Space
// and a token, and a Space with a token locks itself until it has verified its
// own privacy against the Hub — so the 403 that comes back is the lock, not the
// updater. Holding the latch in a helper with nothing between taking it and the
// try is what makes the leak unrepresentable; the unit test is what checks it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUEST_HEADERS } from '../src/request-admission.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(extra, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-update-route-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, stdio: ['ignore', 'ignore', 'ignore'], env: {
    PATH: process.env.PATH, HOME: home, DATA_DIR: path.join(root, 'data'), PORT: String(port),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), AM_REPIN_DIR: path.join(root, 'repin'),
    AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent', ...extra,
  } });
  const post = async (route) => {
    const res = await fetch(origin + route, { method: 'POST',
      headers: { ...REQUEST_HEADERS, 'x-am-origin': 'operator', 'content-type': 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    for (let n = 0; ; n++) {
      if (await fetch(`${origin}/api/health`).then((r) => r.ok).catch(() => false)) break;
      assert.ok(n < 150 && server.exitCode === null, 'isolated backend started');
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn({ post });
  } finally {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('what it cannot do, it says, as an answer rather than a 500', async () => {
  await withServer({ SPACE_ID: 'someone/space', SPACE_HOST: 'someone-space.hf.space' }, async ({ post }) => {
    const answer = await post('/api/update');
    assert.equal(answer.status, 200, 'a 5xx body would be replaced with "Request failed."');
    assert.deepEqual(answer.body, { ok: false, reason: 'no-token' });
  });
  await withServer({}, async ({ post }) => {
    const answer = await post('/api/update');
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: false, reason: 'no-space' });
  });
});
