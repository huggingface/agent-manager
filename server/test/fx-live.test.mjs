// The default stub reproduces fx's session directory and persistent lock without
// a model request. Set AM_TEST_FX_BIN to repeat the check with a real binary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-live-'));
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
let command;
if (process.env.AM_TEST_FX_BIN) {
  assert.ok(fs.existsSync(process.env.AM_TEST_FX_BIN), 'AM_TEST_FX_BIN does not exist');
  command = quote(process.env.AM_TEST_FX_BIN);
} else {
  const stub = path.join(tmp, 'fx-stub.mjs');
  fs.writeFileSync(stub, `
    import fs from 'node:fs';
    import path from 'node:path';
    import crypto from 'node:crypto';
    const root = path.join(process.env.HOME, '.fx', 'sessions');
    const resume = process.argv.indexOf('--resume');
    const id = resume >= 0 ? process.argv[resume + 1]
      : [Date.now(), process.pid, crypto.randomBytes(8).toString('hex')].join('-');
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'session.json'))) {
      const now = Date.now();
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
        schema_version: 3, id, workspace_root: process.cwd(), origin_workspace_root: process.cwd(),
        created_at_ms: now, updated_at_ms: now,
      }));
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    }
    const lock = fs.openSync(path.join(dir, 'session.lock'), 'a');
    const stop = () => { try { fs.closeSync(lock); } catch {} process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    setInterval(() => fs.fsyncSync(lock), 1000);
  `);
  command = `${quote(process.execPath)} ${quote(stub)}`;
}
process.env.HOME = path.join(tmp, 'home');
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.AM_REPIN_DIR = path.join(tmp, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(tmp, 'input');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'no-claude');
process.env.CODEX_HOME = path.join(tmp, 'no-codex');
process.env.AI_GATEWAY_API_KEY = 'test-only-not-a-credential';
fs.mkdirSync(process.env.HOME);
const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const { traceLocation } = await import('../src/traces.js');
config.ensureDirs(); sessions.init();
const cli = config.cliById('fx');
cli.run = command;
cli.resume = id => `${command} --resume ${id}`;
const first = sessions.create({ name: 'fx-first', cli: 'fx', path: 'shared' });
const second = sessions.create({ name: 'fx-second', cli: 'fx', path: 'shared' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  runner.ensureRunning(first); runner.ensureRunning(second);
  await pause(5500);
  const a = sessions.get(first.id).fxSessionId;
  const b = sessions.get(second.id).fxSessionId;
  assert.ok(a, 'first live pane acquires its exact conversation');
  assert.ok(b, 'second live pane acquires its exact conversation');
  assert.notEqual(a, b, 'shared-folder panes never adopt each other');
  assert.ok(await traceLocation(first));
  assert.ok(await traceLocation(second));
  await runner.stopAll(2000);
  runner.ensureRunning(first); runner.ensureRunning(second);
  await pause(5500);
  assert.equal(sessions.get(first.id).fxSessionId, a);
  assert.equal(sessions.get(second.id).fxSessionId, b);
  console.log('fx-live: two shared-folder panes pin, expose traces and resume independently');
} finally {
  await runner.stopAll(2000);
  await pause(100); // let pending trace-history hydration settle before cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
}
