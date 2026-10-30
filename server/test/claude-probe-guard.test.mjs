// The Claude model-picker probe (server/src/model-catalog.js) starts the
// signed-in Claude Code, so only the deployed server may run it: the variable
// that allows it must not reach a test server, from the test runner or from a
// session that starts one. Run with: node test/claude-probe-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-probe-guard-'));
process.env.AM_CLAUDE_MODEL_PROBE = '1'; // as the deployed server has it
const { TERM_ENV } = await import('../src/runner.js');
const { suiteEnv } = await import('../../scripts/run-suites.mjs');

test('a session does not inherit the server\'s AM_CLAUDE_MODEL_PROBE', () => {
  assert.equal('AM_CLAUDE_MODEL_PROBE' in TERM_ENV, false);
  assert.ok(TERM_ENV.PATH, 'the rest of the env is still there');
});

test('the test runner forces the probe off, whatever the shell or the task has', () => {
  assert.equal(suiteEnv({}, { AM_CLAUDE_MODEL_PROBE: '1', HOME: '/h' }).AM_CLAUDE_MODEL_PROBE, '0');
  assert.equal(suiteEnv({ AM_CLAUDE_MODEL_PROBE: '1' }, {}).AM_CLAUDE_MODEL_PROBE, '0');
  assert.equal(suiteEnv({ AM_TEST_DIST: '/d' }, { HOME: '/h' }).HOME, '/h');
  assert.equal(suiteEnv({ AM_TEST_DIST: '/d' }, {}).AM_TEST_DIST, '/d');
});
