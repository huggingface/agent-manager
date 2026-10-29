// The Claude model-picker probe must not run the operator's startup hooks
// (SessionStart and friends run before any prompt). Starts the REAL installed
// Claude Code, on a throwaway HOME with a dummy API key and an unreachable API
// address, so no account is touched and nothing can be sent. Skipped when
// Claude Code is not installed. Run with: node test/claude-probe-hooks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scrapeClaudePicker } from '../src/claude-models.js';

const installed = spawnSync('bash', ['-c', 'command -v claude'], { encoding: 'utf8' }).status === 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-probe-hooks-'));
const HOME = path.join(TMP, 'home');
const CONFIG = path.join(HOME, '.claude');
const MARKER = path.join(TMP, 'SESSION_START_RAN');
const KEY = 'am-test-dummy-not-a-credential';
fs.mkdirSync(CONFIG, { recursive: true });
fs.writeFileSync(path.join(CONFIG, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', numStartups: 1,
  customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
  projects: { [TMP]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}));
fs.writeFileSync(path.join(CONFIG, 'settings.json'), JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${MARKER}'` }] }] },
}));
// Nothing of the real account: no OAuth token, no other key or config dir.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(k)));
Object.assign(env, {
  HOME, CLAUDE_CONFIG_DIR: CONFIG, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
});
const known = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

test('the probe reads the picker without running a SessionStart hook', { skip: !installed && 'claude is not installed' }, async () => {
  const models = await scrapeClaudePicker({ cwd: TMP, env, known, timeoutMs: 40_000 });
  assert.ok(models.length > 0, 'the picker was read');
  assert.equal(fs.existsSync(MARKER), false, 'the SessionStart hook did not run');
});

test('control: a plain `claude` on the same HOME does run it', { skip: !installed && 'claude is not installed' }, async () => {
  await scrapeClaudePicker({ command: 'claude', cwd: TMP, env, known, timeoutMs: 40_000 }).catch(() => {});
  assert.equal(fs.existsSync(MARKER), true, 'so the test above can see a hook run');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
