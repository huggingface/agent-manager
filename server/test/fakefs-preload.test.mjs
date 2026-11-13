// The fixture behind hot-path-sync-fs: every sync fs call under FAKEFS_ROOT is
// counted against the HTTP request that caused it, whether the call is made in
// the handler or in a continuation it scheduled (setImmediate, a timer, an
// await), and whether it is fs.x or one of the `.native` variants that hang off
// fs.realpathSync and fs.realpath as their own functions. The preload wraps
// fs.x and then copies the original's properties onto the wrapper; without the
// extra step those copies were the unwrapped originals, so a deferred
// fs.realpathSync.native(DATA_DIR) on /api/tree left the guard green.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-fakefs-'));
const ROOT = path.join(root, 'data'); fs.mkdirSync(ROOT);
const script = path.join(root, 'probe.mjs');
// A server whose one route makes four sync calls under the root: two at once
// and two from continuations, one of each the `.native` variant.
fs.writeFileSync(script, `
import fs from 'node:fs';
import http from 'node:http';
const ROOT = process.env.FAKEFS_ROOT;
http.createServer((req, res) => {
  fs.existsSync(ROOT);
  fs.realpathSync.native(ROOT);
  setImmediate(() => fs.existsSync(ROOT));
  setTimeout(() => { fs.realpathSync.native(ROOT); res.end('ok'); }, 5);
}).listen(Number(process.env.PORT), '127.0.0.1', () => process.send('listening'));
`);

test('direct, deferred and .native sync calls are all counted against their request', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', path.join(HERE, 'helpers', 'fakefs-preload.mjs'), script], {
    cwd: path.resolve(HERE, '..'), stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, FAKEFS_ROOT: ROOT, FAKEFS_MS: '0', PORT: String(port) },
  });
  try {
    await once(child, 'message');
    for (let i = 0; i < 3; i++) assert.equal(await (await fetch(`http://127.0.0.1:${port}/probe`)).text(), 'ok');
    const report = await new Promise((resolve) => { child.on('message', (m) => { if (m?.fakefs === 'report') resolve(m); }); child.send('fakefs-report'); });
    const byMethod = Object.fromEntries(report.sync.filter((x) => x.ctx === 'http GET /probe').map((x) => [x.method, x.n]));
    assert.deepEqual(byMethod, { existsSync: 6, 'realpathSync.native': 6 }, JSON.stringify(report.sync));
    assert.equal(report.sync.filter((x) => x.ctx !== 'http GET /probe').length, 0, 'nothing counted as background: ' + JSON.stringify(report.sync));
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
