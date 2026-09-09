// am-test: manual — requires the real fx v0.0.5 binary; no model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-live-'));
const binary = process.env.AM_TEST_FX_BIN || '/usr/local/bin/fx';
assert.ok(fs.existsSync(binary), 'install fx or set AM_TEST_FX_BIN');
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
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const cli = config.cliById('fx');
cli.run = quote(binary);
cli.resume = id => `${quote(binary)} --resume ${id}`;
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
  console.log('fx-live: two real shared-folder panes pin, expose traces and resume independently');
} finally {
  await runner.stopAll(2000);
  await pause(100); // let pending trace-history hydration settle before cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
}
