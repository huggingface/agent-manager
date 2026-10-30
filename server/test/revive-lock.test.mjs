// A privacy lock drops a revived agent's pending continue message for good.
//
// Boot privately, start reviving a pane that takes a while to load, make the
// Space public while it loads (the manager locks itself), then private again
// before it is ready. The message was scheduled before the lock; it must not
// be typed after the unlock. Through a real server and a local fake Hub — the
// first version of the feature opened its lock scope only after the wait, and
// delivered here (review of #228).
//
// Run with: node test/revive-lock.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${String(e.message).split('\n')[0]}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(50); } return false; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-lock-'));
const [data, home, local, pub] = ['data', 'home', 'local', 'public'].map((d) => path.join(root, d));
for (const d of [data, home, local, pub]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(pub, 'index.html'), 'fixture');
const input = path.join(root, 'input'), started = path.join(root, 'started'), prompted = path.join(root, 'prompted');
const fixture = path.join(root, 'fixture.mjs');
// Loads for 6 s, then shows an empty prompt — a CLI replaying a long conversation.
fs.writeFileSync(fixture, `import fs from 'node:fs';
process.stdin.setRawMode(true);
fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(input)}, d));
const t = setInterval(() => process.stdout.write('Loading...\\r\\n'), 200);
setTimeout(() => { clearInterval(t); process.stdout.write('> '); fs.writeFileSync(${JSON.stringify(prompted)}, '1'); }, 6000);
setInterval(() => {}, 1000);
`);
const id = 'lock-fixture';
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id, name: 'lock-fixture', cli: 'test-repaint', path: 'fixture', everStarted: true, lastInputAt: Date.now() }]));
fs.writeFileSync(path.join(data, 'runstate.json'), JSON.stringify({ at: new Date().toISOString(), sessions: { [id]: { running: true } } }));

let isPrivate = true;
const hub = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture/space', private: isPrivate, runtime: {} })); });
await new Promise((r) => hub.listen(0, '127.0.0.1', r));
const port = await freePort();
const env = {
  PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, DATA_DIR: data, AM_LOCAL: local, PORT: String(port), PUBLIC_DIR: pub,
  AM_BASHRC: '/nonexistent', AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'),
  SPACE_ID: 'fixture/space', SPACE_HOST: 'fixture-space.hf.space', HF_TOKEN: 'hf_fixture_not_a_real_token',
  HF_ENDPOINT: `http://127.0.0.1:${hub.address().port}`, AM_VISIBILITY_CHECK_MS: '150', AM_VISIBILITY_GRACE_MS: '2500',
  AM_TEST_REPAINT_CMD: `${process.execPath} ${fixture}`,
};
const proc = spawn(process.execPath, ['src/index.js'], { cwd: path.join(HERE, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
proc.stdout.on('data', (d) => { logs += d; });
proc.stderr.on('data', (d) => { logs += d; });
const info = () => fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.json());

try {
  assert.ok(await until(() => fs.existsSync(started), 30_000), `revival did not start\n${logs.slice(-1500)}`);
  isPrivate = false;
  const lockedUp = await until(async () => (await info()).locked, 4000);
  check('the manager locks itself while the pane is still loading', () => {
    assert.ok(lockedUp);
    assert.ok(!fs.existsSync(prompted), 'the fixture was ready before the lock — the case was not exercised');
  });
  isPrivate = true;
  const unlocked = await until(async () => !(await info()).locked, 4000);
  check('and unlocks again before it is ready', () => {
    assert.ok(unlocked);
    assert.ok(!fs.existsSync(prompted), 'the fixture was ready before the unlock — the case was not exercised');
  });
  await until(() => fs.existsSync(prompted), 15_000);
  await sleep(4000); // well past the quiet window: the old code typed here
  check('the pane reached its empty prompt', () => assert.ok(fs.existsSync(prompted)));
  check('but the message scheduled before the lock is never typed', () => {
    assert.equal(fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '', '');
    assert.ok(!logs.includes('told to continue'), 'logged as delivered');
    assert.match(logs, /locked itself — not telling it to continue/);
  });
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.message}`);
} finally {
  proc.kill('SIGTERM');
  await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  await new Promise((r) => hub.close(r));
  if (failed) console.log(logs.split('\n').filter((l) => /revive|visibility/.test(l)).join('\n'));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
