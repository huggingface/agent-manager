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
// A port nothing listens on unless a test serves /api/health there.
const port = 20000 + Math.floor(Math.random() * 20000);
const FAST = { AM_DEV_PREVIEW_START_DEADLINE: '2', AM_DEV_PREVIEW_HEALTH_EVERY: '1', AM_DEV_PREVIEW_HEALTH_FAILS: '2' };
const SWITCH = 'ln -sfn "$APP/rel" "$APP/.c.t" && mv -Tf "$APP/.c.t" "$APP/current"; exit 75';

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
  // The stub answers the image's launch check too: allowed, unless a test lists
  // answers in $APP/check-answers (one line per call; "ok" or a refusal).
  const checker = `case "$1" in *.image/server/src/dev-preview-check.js)
    echo "$2" >> "$APP/checked"
    n=$(wc -l < "$APP/checked")
    ans=$(sed -n "\${n}p" "$APP/check-answers" 2>/dev/null)
    [ -z "$ans" ] || [ "$ans" = ok ] && exit 0
    echo "$ans"; exit 1 ;;
esac`;
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n${checker.replaceAll('$APP', app)}\n${nodeScript.replaceAll('$APP', app)}\n`, { mode: 0o755 });
  // The function exactly as shipped, with /app moved into the fixture.
  const src = fs.readFileSync(ENTRYPOINT, 'utf8');
  const from = src.indexOf('preview_health_watch() {');
  const fn = src.slice(from, src.indexOf('\n}\n', src.indexOf('supervise_app() {')) + 3);
  assert.ok(fn.includes('while :; do') && fn.includes('preview_health_watch'));
  const script = path.join(dir, 'sup.sh');
  fs.writeFileSync(script, `${fn.replaceAll('/app', app)}\nsupervise_app\n`);
  const run = (env = {}) => spawn('sh', [script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, AM_LOCAL: local, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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

test('a previewed build that never answers /api/health is stopped and rolled back by the image\'s supervisor', async () => {
  const f = fixture('hung', `
    n=$(cat "$APP/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/count"
    case "$n" in
      1) ${SWITCH} ;;
      2) exec sleep 600 ;;
      *) readlink -f "$APP/server" > "$APP/third-saw"; exit 0 ;;
    esac`);
  const child = f.run(FAST);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  assert.match(out, /did not answer \/api\/health within 2s; stopping it/);
  assert.equal(fs.readlinkSync(path.join(f.app, 'current')), path.join(f.app, '.image'));
  assert.equal(fs.readFileSync(path.join(f.app, 'third-saw'), 'utf8').trim(), path.join(f.app, '.image', 'server'));
  assert.match(fs.readFileSync(path.join(f.local, 'dev-preview', 'crashed'), 'utf8'), /^did not answer \/api\/health within 2s from .*\/rel$/m);
});

test('a previewed build that exits cleanly, at any time, is rolled back too', async () => {
  const f = fixture('clean-exit', `
    n=$(cat "$APP/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/count"
    case "$n" in
      1) ${SWITCH} ;;
      2) exit 0 ;;
      *) exit 0 ;;
    esac`);
  const child = f.run(FAST);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(f.app, 'count'), 'utf8').trim(), '3', 'the image was started after the rollback');
  assert.match(fs.readFileSync(path.join(f.local, 'dev-preview', 'crashed'), 'utf8'), /^exit 0 from/);
});

test('a healthy previewed build is left running', async () => {
  const www = path.join(root, 'www');
  fs.mkdirSync(path.join(www, 'api'), { recursive: true });
  fs.writeFileSync(path.join(www, 'api', 'health'), '{"ok":true}');
  const f = fixture('healthy', `
    n=$(cat "$APP/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/count"
    case "$n" in
      1) ${SWITCH} ;;
      *) exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory ${JSON.stringify(www)} ;;
    esac`);
  const child = f.run(FAST);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  await new Promise((r) => setTimeout(r, 6000)); // three deadlines' worth
  child.kill('SIGTERM');
  await once(child, 'exit');
  assert.doesNotMatch(out, /stopping it|rolling back/);
  assert.equal(fs.readlinkSync(path.join(f.app, 'current')), path.join(f.app, 'rel'));
  assert.equal(fs.existsSync(path.join(f.local, 'dev-preview', 'crashed')), false);
});

test('every relaunch of a previewed build is re-checked by the image: write revoked → the image runs instead', async () => {
  const f = fixture('revoked', `
    n=$(cat "$APP/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/count"
    readlink -f "$APP/server" >> "$APP/ran"
    case "$n" in
      1) ${SWITCH} ;;
      2) exit 75 ;;
      *) exit 0 ;;
    esac`);
  // first launch of the build: allowed; the relaunch after its exit 75: refused
  fs.writeFileSync(path.join(f.app, 'check-answers'), 'ok\nPR #1 cannot be previewed: its author w has read permission\n');
  const child = f.run(FAST);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  // checked twice, both times against the build, never against the image
  assert.deepEqual(fs.readFileSync(path.join(f.app, 'checked'), 'utf8').trim().split('\n'), [path.join(f.app, 'rel'), path.join(f.app, 'rel')]);
  // image, the build once, then the image again: the relaunch never ran it
  assert.deepEqual(fs.readFileSync(path.join(f.app, 'ran'), 'utf8').trim().split('\n'),
    [path.join(f.app, '.image', 'server'), path.join(f.app, 'rel', 'server'), path.join(f.app, '.image', 'server')]);
  assert.match(out, /refused at launch: PR #1 cannot be previewed: its author w has read permission; not starting .*\/rel, rolling back to the image/);
  assert.equal(fs.readlinkSync(path.join(f.app, 'current')), path.join(f.app, '.image'));
  assert.match(fs.readFileSync(path.join(f.local, 'dev-preview', 'crashed'), 'utf8'), /^refused at launch: PR #1 cannot be previewed/);
});

test('a check that cannot run is a refusal, and a build refused at its first launch never runs', async () => {
  const f = fixture('first-refused', `
    n=$(cat "$APP/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/count"
    readlink -f "$APP/server" >> "$APP/ran"
    case "$n" in
      1) ${SWITCH} ;;
      *) exit 0 ;;
    esac`);
  // a refusal with no explanation at all, as when node itself cannot start
  fs.writeFileSync(path.join(f.app, 'check-answers'), ' \n');
  const child = f.run(FAST);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.app, 'ran'), 'utf8').trim().split('\n'),
    [path.join(f.app, '.image', 'server'), path.join(f.app, '.image', 'server')]);
  assert.match(fs.readFileSync(path.join(f.local, 'dev-preview', 'crashed'), 'utf8'), /^refused at launch/);
});

test('a rollback that cannot repoint /app/current stops the supervisor instead of relaunching the build forever', async () => {
  // the build crashes, and the rollback link cannot be written
  const f = fixture('stuck', `
    n=$(cat "$APP/../count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/../count"
    case "$n" in
      1) ${SWITCH} ;;
      2) chmod 555 "$APP"; exit 3 ;;
      *) exit 0 ;;
    esac`);
  const child = f.run(FAST);
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const [code] = await once(child, 'exit');
  fs.chmodSync(f.app, 0o755);
  assert.equal(code, 3, 'the build\'s own exit code');
  assert.match(err, /could not roll back to the image; exiting/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'count'), 'utf8').trim(), '2', 'not relaunched');
  assert.equal(fs.readlinkSync(path.join(f.app, 'current')), path.join(f.app, 'rel'));

  // refused at launch with the same unwritable /app: exit 1, nothing runs
  const g = fixture('stuck-refused', `
    n=$(cat "$APP/../count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP/../count"
    case "$n" in
      1) ${SWITCH.replace('exit 75', 'chmod 555 "$APP"; exit 75')} ;;
      *) exit 0 ;;
    esac`);
  fs.writeFileSync(path.join(g.app, 'check-answers'), 'refused\n');
  const child2 = g.run(FAST);
  const [code2] = await once(child2, 'exit');
  fs.chmodSync(g.app, 0o755);
  assert.equal(code2, 1);
  assert.equal(fs.readFileSync(path.join(g.dir, 'count'), 'utf8').trim(), '1', 'the refused build never started');
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
