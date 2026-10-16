// entrypoint.sh's dev-preview supervisor, run for real with /app pointed at a
// temp dir and a stub `node`: exit 75 restarts the server in place, a previewed
// build that dies right after starting is rolled back to the image, and TERM
// reaches the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ENTRYPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'entrypoint.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dev-preview-sup-'));

function fixture(name, nodeScript) {
  const dir = path.join(root, name);
  const app = path.join(dir, 'app');
  const local = path.join(dir, 'local');
  const bin = path.join(dir, 'bin');
  // The layout dev-preview.js leaves: four paths behind one `current` link.
  for (const p of ['server', 'scripts', 'public']) {
    fs.mkdirSync(path.join(app, '.image', p), { recursive: true });
    fs.mkdirSync(path.join(app, 'rel', p), { recursive: true });
  }
  fs.writeFileSync(path.join(app, '.image', 'session.bashrc'), '');
  fs.writeFileSync(path.join(app, 'rel', 'session.bashrc'), '');
  fs.symlinkSync(path.join(app, '.image'), path.join(app, 'current'));
  for (const p of ['server', 'scripts', 'public', 'session.bashrc']) fs.symlinkSync(path.join('current', p), path.join(app, p));
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n${nodeScript.replaceAll('$APP', app)}\n`, { mode: 0o755 });
  // The function exactly as shipped, with /app moved into the fixture.
  const src = fs.readFileSync(ENTRYPOINT, 'utf8');
  const fn = src.slice(src.indexOf('supervise_app() {'), src.indexOf('\n}\n', src.indexOf('supervise_app() {')) + 3);
  assert.ok(fn.includes('while :; do'));
  const script = path.join(dir, 'sup.sh');
  fs.writeFileSync(script, `${fn.replaceAll('/app', app)}\nsupervise_app\n`);
  const run = (env = {}) => spawn('sh', [script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, AM_LOCAL: local, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { dir, app, local, run };
}

test('exit 75 restarts in place; a previewed build that crashes on start is rolled back to the image', async () => {
  const f = fixture('cycle', `
    n=$(cat "$APP/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/count"
    case "$n" in
      1) ln -sfn "$APP/rel" "$APP/.c.t" && mv -Tf "$APP/.c.t" "$APP/current"; exit 75 ;;
      2) readlink -f "$APP/server" > "$APP/second-saw"; exit 1 ;;
      *) readlink -f "$APP/server" > "$APP/third-saw"; exit 0 ;;
    esac`);
  const child = f.run();
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  assert.equal(fs.readFileSync(path.join(f.app, 'count'), 'utf8').trim(), '3');
  assert.equal(fs.readFileSync(path.join(f.app, 'second-saw'), 'utf8').trim(), path.join(f.app, 'rel', 'server'));
  assert.equal(fs.readFileSync(path.join(f.app, 'third-saw'), 'utf8').trim(), path.join(f.app, '.image', 'server'));
  assert.equal(fs.readlinkSync(path.join(f.app, 'current')), path.join(f.app, '.image'));
  for (const p of ['server', 'scripts', 'public', 'session.bashrc']) {
    assert.equal(fs.realpathSync(path.join(f.app, p)), path.join(f.app, '.image', p), p);
  }
  assert.match(fs.readFileSync(path.join(f.local, 'dev-preview', 'crashed'), 'utf8'), /^exit 1 from .*\/rel$/m);
  assert.match(out, /asked for a restart/);
  assert.match(out, /rolling back to the image/);
});

test('the image itself crashing is not "rolled back": the supervisor exits with its code', async () => {
  const f = fixture('image-crash', 'exit 3');
  const child = f.run();
  const [code] = await once(child, 'exit');
  assert.equal(code, 3);
  assert.equal(fs.existsSync(path.join(f.local, 'dev-preview', 'crashed')), false);
});

test('TERM is forwarded to the server', async () => {
  const f = fixture('term', `trap 'echo got-term > "$APP/term"; exit 0' TERM; while :; do sleep 0.1; done`);
  const child = f.run();
  for (let i = 0; i < 50 && !fs.existsSync(path.join(f.app, 'server')); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(f.app, 'term'), 'utf8').trim(), 'got-term');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
