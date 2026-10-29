// Model / effort at creation, over HTTP: what GET /api/clis and
// GET /api/launch-options advertise, and what POST /api/sessions, the agent
// spawn API and crons accept and store. The model lists are built from stub
// CLIs, so nothing real is asked. Run with: node test/launch-options-api.test.mjs
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-launch-api-'));
const HOME = path.join(TMP, 'home');
const BIN = path.join(TMP, 'bin');
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
// Sessions and list commands run in `bash -lc`, whose /etc/profile resets PATH.
fs.writeFileSync(path.join(HOME, '.profile'), `export PATH=${BIN}:$PATH\n`);
const CODEX_MODELS = JSON.stringify({ models: [
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }] },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'ultra' }] },
] });
const write = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
write('codex', `[ "$1 $2" = "debug models" ] && { cat <<'EOF'\n${CODEX_MODELS}\nEOF\n exit 0; }; [ "$1" = --version ] && echo 'codex-cli 0.165.0'; exit 0`);
write('claude', `[ "$1" = --version ] && echo '2.1.312 (Claude Code)'; exit 0`);
write('opencode', `[ "$1" = models ] && { echo anthropic/claude-fable-5; echo openrouter/qwen/qwen3; exit 0; }; exit 0`);
write('gemini', 'exit 0');
// gemini-cli has no list command: its registry is read from the bundle next to it.
fs.writeFileSync(path.join(BIN, 'chunk-test.js'), 'var DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";\nvar VALID_GEMINI_MODELS = new Set([DEFAULT_GEMINI_MODEL, "gemma-4-31b-it"]);\n');
write('fx', 'exit 0');

const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR, ...BASE } = process.env;
let srv; let log = '';
const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
  const sep = route.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${route}${sep}from=operator`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  srv = spawn(process.execPath, ['src/index.js'], {
    env: { ...BASE, HOME, PATH: `${BIN}:${BASE.PATH}`, PORT: String(PORT), DATA_DIR, AM_BIND_HOST: '127.0.0.1',
      AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1', AM_CLAUDE_MODEL_PROBE: '0',
      CODEX_HOME: path.join(HOME, '.codex'), XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_DATA_HOME: path.join(HOME, '.local/share') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${log}`);
});
after(() => { srv?.kill('SIGKILL'); });

test('refresh builds the lists from the CLIs and saves them', async () => {
  const r = await api('/api/launch-options/refresh', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.clis.map((c) => [c.id, c]));
  assert.deepEqual(by.codex.models.map((m) => m.id), ['gpt-5.5', 'gpt-6-astra']);
  assert.deepEqual(by.codex.models[0].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(by.opencode.models.map((m) => m.id), ['anthropic/claude-fable-5', 'openrouter/qwen/qwen3']);
  assert.deepEqual(by.claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku'], 'no credential: the aliases');
  assert.deepEqual(by.gemini.models.map((m) => m.id), ['gemini-2.5-pro', 'gemma-4-31b-it']);
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state', 'cli-models.json'), 'utf8'));
  assert.equal(saved.clis.codex.source, 'codex debug models');
});

test('GET /api/clis says what each CLI takes', async () => {
  const { body } = await api('/api/clis');
  const launch = Object.fromEntries(body.map((c) => [c.id, c.launch]));
  assert.deepEqual(launch.claude, { model: true, effort: true });
  assert.deepEqual(launch.codex, { model: true, effort: true });
  assert.deepEqual(launch.gemini, { model: true, effort: false });
  assert.deepEqual(launch.opencode, { model: true, effort: false });
  assert.deepEqual(launch.fx, { model: false, effort: false });
  assert.deepEqual(launch.shell, { model: false, effort: false });
});

test('POST /api/sessions stores an allowed choice; the session row shows it', async () => {
  const r = await api('/api/sessions', { cli: 'claude', name: 'picked', path: 'w', model: 'opus', effort: 'max' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.model, 'opus');
  assert.equal(r.body.effort, 'max');
  const row = (await api('/api/sessions')).body.find((s) => s.id === r.body.id);
  assert.equal(row.model, 'opus');
  assert.equal(row.effort, 'max');
  const plain = await api('/api/sessions', { cli: 'claude', name: 'plain', path: 'w' });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.model, undefined, 'nothing chosen = nothing stored');
  const codex = await api('/api/sessions', { cli: 'codex', name: 'c', path: 'w', model: 'gpt-6-astra', effort: 'ultra' });
  assert.equal(codex.status, 201, JSON.stringify(codex.body));
});

test('POST /api/sessions refuses anything not on the list, and creates nothing', async () => {
  const before = (await api('/api/sessions')).body.length;
  for (const body of [
    { cli: 'claude', model: "opus'; touch /tmp/x; '" },
    { cli: 'claude', model: 'claude-opus-99' },
    { cli: 'claude', effort: 'ultra' },
    { cli: 'codex', model: 'gpt-5.5', effort: 'ultra' },
    { cli: 'gemini', effort: 'high' },
    { cli: 'fx', model: 'anything' },
    { cli: 'claude', model: { $ne: 1 } },
  ]) {
    const r = await api('/api/sessions', { name: 'refused', path: 'w', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'invalid-launch-option', JSON.stringify(r.body));
  }
  assert.equal((await api('/api/sessions')).body.length, before);
});

test('crons check the choice when saved', async () => {
  const job = { name: 'm', prompt: 'p', schedule: { cron: '0 0 1 1 *', tz: 'UTC' }, state: 'stopped' };
  const bad = await api('/api/crons', { ...job, agent: { name: 'cron-agent', cli: 'claude', model: 'nope' } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const ok = await api('/api/crons', { ...job, agent: { name: 'cron-agent', cli: 'claude', model: 'sonnet', effort: 'low' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.agent, { name: 'cron-agent', cli: 'claude', model: 'sonnet', effort: 'low' });
});

test('the agent spawn API checks ?model= / ?effort= the same way', async () => {
  const caller = (await api('/api/sessions', { cli: 'shell', name: 'caller', path: 'w' })).body;
  const spawnAs = (q) => fetch(`${API}/api/agents?cli=claude&name=spawned&${q}&from=${caller.id}`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'do the thing',
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const r = await spawnAs('model=claude-opus-99');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /not a model/);
  assert.equal((await api('/api/sessions')).body.some((s) => s.name === 'spawned'), false);
});
