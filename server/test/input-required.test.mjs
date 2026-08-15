import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-input-required-'));
process.env.AM_INPUT_REQUIRED_DIR = root;
const { createInputRequiredTracker } = await import('../src/input-required.js');

const RUN = '11111111-2222-4333-8444-555555555555';
const marker = (id, cli, value = {}) => fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({
  amId: id,
  runId: RUN,
  cli,
  kind: 'permission',
  source: `${cli}-notification`,
  at: Date.now(),
  ...value,
}));

try {
  const quiet = createInputRequiredTracker({ id: 'quiet', runId: RUN, cli: 'claude' });
  assert.equal(quiet.get(), null, 'a quiet/static terminal is not evidence');

  marker('wrong-run', 'claude', { runId: 'old-launch' });
  const wrong = createInputRequiredTracker({ id: 'wrong-run', runId: RUN, cli: 'claude' });
  assert.equal(wrong.get(), null, 'a stale launch marker is ignored');

  marker('wrong-source', 'claude', { source: 'opencode-event' });
  const wrongSource = createInputRequiredTracker({ id: 'wrong-source', runId: RUN, cli: 'claude' });
  assert.equal(wrongSource.get(), null, 'a marker source must belong to the matching CLI adapter');

  marker('claude-pane', 'claude');
  const claude = createInputRequiredTracker({ id: 'claude-pane', runId: RUN, cli: 'claude' });
  assert.equal(claude.get()?.kind, 'permission');
  claude.observeInput();
  assert.equal(claude.get(), null, 'one-shot signals clear conservatively on operator input');
  assert.equal(fs.existsSync(path.join(root, 'claude-pane.json')), false);

  marker('oc-pane', 'opencode', {
    kind: 'question', source: 'opencode-event', requestId: 'que_1',
  });
  const opencode = createInputRequiredTracker({ id: 'oc-pane', runId: RUN, cli: 'opencode' });
  assert.equal(opencode.get()?.kind, 'question');
  opencode.observeInput();
  assert.equal(opencode.get()?.kind, 'question', 'menu navigation cannot clear a paired OpenCode request');
  fs.unlinkSync(path.join(root, 'oc-pane.json'));
  assert.equal(opencode.get(), null, 'the paired reply/removal clears OpenCode');

  let now = 1_800_000_000_000;
  const codex = createInputRequiredTracker({ id: 'codex-pane', runId: RUN, cli: 'codex', now: () => now });
  codex.observeOutput('\x1b]9;ordinary turn complete\x07');
  assert.equal(codex.get(), null, 'ordinary notifications are ignored');
  codex.observeOutput('\x1b]9;Plan mode');
  codex.observeOutput(' prompt: choose a path\x07');
  assert.equal(codex.get()?.kind, 'question', 'a split native question signal is recognized');
  codex.observeInput();
  assert.equal(codex.get(), null);
  codex.observeOutput('\x1b]9;Approval requested: run tests\x07');
  assert.equal(codex.get()?.kind, 'permission');
  now += 30 * 60_000 + 1;
  assert.equal(codex.get(), null, 'an unpaired signal expires rather than sticking forever');

  const geminiOsc = createInputRequiredTracker({ id: 'gemini-pane', runId: RUN, cli: 'gemini' });
  geminiOsc.observeOutput('\x1b]9;Gemini CLI needs your attention | Answer requested by agent | choose one\x07');
  assert.equal(geminiOsc.get()?.kind, 'question');
  geminiOsc.observeInput();
  geminiOsc.observeOutput('\x1b]777;notify;Gemini CLI needs your attention;Filesystem permission required\x07');
  assert.equal(geminiOsc.get()?.kind, 'confirmation');
  geminiOsc.observeOutput('\x1b]9;Gemini CLI session complete | Run finished\x07');
  assert.equal(geminiOsc.get(), null);

  const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
  const hook = path.join(scripts, 'am-input-required-hook.sh');
  const baseEnv = {
    ...process.env,
    AM_ID: 'hook-pane',
    AM_RUN_ID: RUN,
    AM_INPUT_REQUIRED_DIR: root,
    AM_PANE_PID: String(process.pid),
  };
  let child = spawnSync('sh', [hook], {
    input: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
    env: {
      ...baseEnv,
      AM_CLI: 'claude',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: String(process.pid),
    },
  });
  assert.equal(child.status, 0, child.stderr?.toString());
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'hook-pane.json'))).kind, 'permission');

  fs.unlinkSync(path.join(root, 'hook-pane.json'));
  child = spawnSync('bash', ['-c', 'sh "$1"; :', 'am-gemini-hook-test', hook], {
    input: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'ToolPermission', details: { type: 'ask_user' } }),
    env: { ...baseEnv, AM_CLI: 'gemini' },
  });
  assert.equal(child.status, 0, child.stderr?.toString());
  const gemini = JSON.parse(fs.readFileSync(path.join(root, 'hook-pane.json')));
  assert.equal(gemini.kind, 'question');
  assert.equal(gemini.source, 'gemini-notification');

  child = spawnSync('sh', [hook], {
    input: JSON.stringify({ hook_event_name: 'AfterAgent' }),
    env: { ...baseEnv, AM_CLI: 'gemini' },
  });
  assert.equal(child.status, 0, child.stderr?.toString());
  assert.equal(fs.existsSync(path.join(root, 'hook-pane.json')), false, 'native close event removes the marker');

  child = spawnSync('bash', ['-c', 'sh "$1"; :', 'am-nested-gemini-hook-test', hook], {
    input: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'ToolPermission' }),
    env: { ...baseEnv, AM_CLI: 'gemini', AM_PANE_PID: '1' },
  });
  assert.equal(child.status, 0, child.stderr?.toString());
  assert.equal(fs.existsSync(path.join(root, 'hook-pane.json')), false, 'a Gemini hook outside the pane process tree is ignored');

  const geminiDefaults = JSON.parse(fs.readFileSync(path.resolve(scripts, '..', 'gemini-system-defaults.json')));
  assert.equal(geminiDefaults.hooks.Notification[0].matcher, 'ToolPermission');
  assert.equal(geminiDefaults.general.notificationMethod, 'osc9');

  console.log('input-required: all assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
