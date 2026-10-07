// Updating the installed CLIs in place.
//
// The install itself is npm's problem. What is tested here is the bookkeeping
// around it, because that is where this feature can lie: calling an unchanged
// version "updated", calling a broken install a success, or restarting a pane
// nobody was warned about. Every side effect (npm, `--version`, panes, PTYs)
// goes through the injected adapter, so none of this needs a network, a
// registry or libghostty.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { REQUEST_HEADERS } from '../src/request-admission.js';
import { CLIS, cliUpdatePlan, PASSIVE_CLIS, isRemote } from '../src/config.js';
import {
  configureCliUpdate, startCliUpdate, cliUpdateStatus, cliUpdatePreview,
  persistSnippet, resetCliUpdate,
} from '../src/cli-update.js';

const item = (id) => cliUpdateStatus().items.find((i) => i.id === id);
const settle = async () => {
  for (let n = 0; n < 2000 && cliUpdateStatus().running; n++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(cliUpdateStatus().running, false, 'run finished');
};

// A world where every CLI installs cleanly and reports `versions[id]`, with
// `panes[id]` running. Overrides replace one piece at a time.
const byPkg = new Map(cliUpdatePlan().targets.map((t) => [t.npm, t.id]));
const world = ({ versions = {}, after = null, panes = {}, install, restart } = {}) => {
  const restarted = [];
  const done = new Set();
  configureCliUpdate({
    preflight: async () => ({ ok: true, error: null }),
    install: async (pkg) => {
      const result = install ? await install(pkg) : { ok: true, error: null };
      if (result.ok) done.add(byPkg.get(pkg));
      return result;
    },
    // `after` only applies to a package that has actually been installed, so a
    // CLI later in the run still reports its old version when asked first.
    version: async (id) => ((after && done.has(id)) ? after[id] ?? null : versions[id] ?? null),
    panes: (id) => panes[id] || [],
    restart: restart || (async (id) => { restarted.push(id); }),
  });
  return restarted;
};

// ---- the list comes from the registry, not from this file ----

const plan = cliUpdatePlan();
const agents = CLIS.filter((c) => c.bin && c.run && c.id !== 'shell' && c.id !== 'test-repaint'
  && !PASSIVE_CLIS.includes(c.id) && !isRemote(c.id));
assert.equal(
  plan.targets.length + plan.excluded.length, agents.length,
  'every agent CLI is either a target or explicitly excluded — a new one cannot land in neither and be skipped in silence',
);
assert.deepEqual(plan.targets.map((t) => t.id), ['claude', 'codex', 'gemini', 'opencode', 'openclaw']);
assert.deepEqual(plan.excluded.map((e) => e.id), ['hermes', 'fx'], 'the two non-npm CLIs are named, not dropped');
for (const e of plan.excluded) assert.ok(e.reason.length > 10, `${e.id} says why it is excluded`);
for (const t of plan.targets) assert.ok(persistSnippet().includes(`${t.npm}@latest`), `${t.id} is in the durable snippet`);

// ---- the preview is the warning: which panes, and what they are doing ----

resetCliUpdate();
world({ panes: { codex: [{ id: 's1', name: 'build', state: 'working' }, { id: 's2', name: 'notes', state: 'waiting' }] } });
const preview = cliUpdatePreview();
assert.equal(preview.restarts, 2);
assert.equal(preview.working, 1, 'a working pane is counted apart — it is the one that loses work');
assert.deepEqual(preview.items.find((i) => i.id === 'codex').sessions.map((s) => s.name), ['build', 'notes']);
assert.deepEqual(preview.items.find((i) => i.id === 'claude').sessions, [], 'updating codex does not restart claude');

// ---- an unchanged version is reported as unchanged, and restarts nothing ----

resetCliUpdate();
let restarted = world({
  versions: { codex: '1.2.3' }, after: { codex: '1.2.3' },
  panes: { codex: [{ id: 's1', name: 'build', state: 'waiting' }] },
});
assert.equal(startCliUpdate(), true);
await settle();
assert.equal(item('codex').state, 'current');
assert.deepEqual(restarted, [], 'nothing moved, so no pane is thrown away for it');
assert.deepEqual(item('codex').sessions, [], 'and the report does not claim a restart it did not do');

// ---- a real upgrade reports both versions and restarts exactly its own panes ----

resetCliUpdate();
restarted = world({
  versions: { codex: '1.2.3', claude: '2.0.0' },
  after: { codex: '1.3.0', claude: '2.0.0' },
  panes: { codex: [{ id: 's1', name: 'build', state: 'working' }], claude: [{ id: 's9', name: 'docs', state: 'waiting' }] },
});
assert.equal(startCliUpdate(), true);
assert.equal(startCliUpdate(), false, 'one run at a time — two npm installs share one prefix');
await settle();
assert.equal(item('codex').state, 'updated');
assert.equal(item('codex').from, '1.2.3');
assert.equal(item('codex').to, '1.3.0');
assert.equal(item('claude').state, 'current');
assert.deepEqual(restarted, ['s1'], 'only the panes of the CLI that actually changed');
assert.deepEqual(item('codex').restarted, [{ id: 's1', name: 'build', was: 'working', ok: true, error: null }]);
assert.ok(item('codex').installedAt > 0, 'when the new binary landed, so a pane started after it is not called stale');

// ---- a CLI that was not installed at all reads as installed, not updated ----

resetCliUpdate();
world({ versions: {}, after: { gemini: '9.9.9' } });
assert.equal(startCliUpdate(), true);
await settle();
assert.equal(item('gemini').state, 'installed');
assert.equal(item('gemini').from, null);
assert.equal(item('gemini').to, '9.9.9');

// ---- npm failing is a failure, with npm's own words ----

resetCliUpdate();
restarted = world({
  versions: { codex: '1.2.3' }, after: { codex: '1.3.0' },
  panes: { codex: [{ id: 's1', name: 'build', state: 'waiting' }] },
  install: async () => ({ ok: false, error: 'E404 Not Found - GET https://registry.npmjs.org/@openai%2fcodex' }),
});
assert.equal(startCliUpdate(), true);
await settle();
assert.equal(item('codex').state, 'failed');
assert.match(item('codex').error, /E404/);
assert.equal(item('codex').to, null);
assert.deepEqual(restarted, [], 'a failed install does not get to restart anything');

// ---- npm "succeeding" onto a binary that cannot say its version is a failure ----

resetCliUpdate();
restarted = world({
  versions: { codex: '1.2.3' }, after: { codex: null },
  panes: { codex: [{ id: 's1', name: 'build', state: 'waiting' }] },
});
assert.equal(startCliUpdate(), true);
await settle();
assert.equal(item('codex').state, 'failed', 'a silent success is the failure mode this panel exists to avoid');
assert.match(item('codex').error, /did not answer/);
assert.deepEqual(restarted, []);

// ---- npm missing entirely: said once, not five times, and nothing is claimed ----

resetCliUpdate();
configureCliUpdate({
  preflight: async () => ({ ok: false, error: 'spawn npm ENOENT' }),
  install: async () => { throw new Error('install must not run when npm is unusable'); },
  version: async () => null,
  panes: () => [],
  restart: async () => { throw new Error('nothing to restart'); },
});
assert.equal(startCliUpdate(), true);
await settle();
for (const i of cliUpdateStatus().items) {
  assert.equal(i.state, 'failed');
  assert.match(i.error, /npm is not usable here: spawn npm ENOENT/);
}

// ---- a pane that will not come back is reported as such ----

resetCliUpdate();
world({
  versions: { codex: '1.2.3' }, after: { codex: '1.3.0' },
  panes: { codex: [{ id: 's1', name: 'build', state: 'working' }, { id: 's2', name: 'notes', state: 'waiting' }] },
  restart: async (id) => { if (id === 's1') throw new Error('did not exit within 15s — still running the old binary'); },
});
assert.equal(startCliUpdate(), true);
await settle();
assert.equal(item('codex').state, 'updated');
assert.deepEqual(item('codex').restarted.map((r) => [r.id, r.ok]), [['s1', false], ['s2', true]]);
assert.match(item('codex').restarted[0].error, /still running the old binary/);

// ---- the restart list is the one the operator agreed to ----
//
// A pane opened while npm was working was never on the warning, and it already
// has the new binary. Restarting it would be a surprise.

resetCliUpdate();
const live = { codex: [{ id: 's1', name: 'build', state: 'waiting' }] };
restarted = world({
  versions: { codex: '1.2.3' },
  after: { codex: '1.3.0' },
  panes: live,
  install: async () => { live.codex.push({ id: 's2', name: 'opened mid-install', state: 'working' }); return { ok: true, error: null }; },
});
assert.equal(startCliUpdate(), true);
await settle();
assert.deepEqual(restarted, ['s1']);

// ---- the install sits behind the same admission as every other mutation ----
//
// It runs `npm install -g` from a web request, so a page that cannot set the
// request header — a file preview, an unrelated origin — must not be able to
// start one. Only the REFUSAL is exercised against a live server: a POST that
// got through would really install five packages. Reading the plan is a plain
// GET, admitted like /api/sessions is.

resetCliUpdate();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cli-update-'));
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const server = spawn(process.execPath, ['src/index.js'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: {
    PATH: process.env.PATH, HOME: home, DATA_DIR: path.join(root, 'data'), PORT: String(port),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), AM_REPIN_DIR: path.join(root, 'repin'),
    AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  },
});
try {
  for (let n = 0; ; n++) {
    if (await fetch(`${origin}/api/health`).then((r) => r.ok).catch(() => false)) break;
    assert.ok(n < 100 && server.exitCode === null, 'isolated backend started');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const blind = await fetch(`${origin}/api/clis/update`, { method: 'POST' });
  assert.equal(blind.status, 403, 'no request marker, no install');
  assert.equal((await blind.json()).code, 'request-not-allowed');

  const res = await fetch(`${origin}/api/clis/update`, { headers: REQUEST_HEADERS });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.running, false);
  assert.deepEqual(body.items.map((i) => i.id), plan.targets.map((t) => t.id));
  assert.deepEqual(body.excluded.map((e) => e.id), ['hermes', 'fx']);
  assert.deepEqual(body.stale, []);
  assert.ok(body.items.every((i) => i.state === 'idle'),
    'neither the refused POST nor reading the plan started a run');
  assert.ok(body.installScript.endsWith('/install.sh'), 'the durable file is named, not implied');
  assert.ok(body.persistSnippet.startsWith('npm install -g '));
} finally {
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('cli update tests passed');
