// The model lists behind the create form's model select, and the allow-list a
// creation's model / effort is checked against (server/src/model-catalog.js).
// Also reads a fake Claude `/model` picker, asserting which keys were sent.
// Run with: node test/model-catalog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-model-catalog-'));
process.env.DATA_DIR = path.join(TMP, 'data');
const config = await import('../src/config.js');
const catalog = await import('../src/model-catalog.js');
const { scrapeClaudePicker, pickerRows, idForName, CLAUDE_PROBE_COMMAND } = await import('../src/claude-models.js');
config.ensureDirs();
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude-picker.mjs', import.meta.url));

test('codex debug models: listed models only, with their effort levels', () => {
  const out = JSON.stringify({ models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'Bad Value' }] },
    { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: [] },
  ] });
  assert.deepEqual(catalog.parseCodexModels(out), [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'xhigh'], defaultEffort: 'medium' }]);
});

test('opencode models and the Hermes cache', () => {
  assert.deepEqual(catalog.parseOpencodeModels('anthropic/claude-fable-5\nINFO something\nopenrouter/x/y\n\n'),
    [{ id: 'anthropic/claude-fable-5' }, { id: 'openrouter/x/y' }]);
  assert.deepEqual(catalog.parseHermesCache({ huggingface: { models: ['moonshotai/Kimi-K2.5', { id: 'b' }, 5] }, bad: null }),
    [{ id: 'huggingface/moonshotai/Kimi-K2.5' }, { id: 'huggingface/b' }]);
});

test('claude ids in a binary', () => {
  const ids = catalog.claudeIdsIn('"claude-opus-5-5" xx claude-haiku-4-5-20251001 "claude-mythos-5-1" claude-fable-5');
  assert.deepEqual([...ids].sort(), ['claude-fable-5', 'claude-mythos-5-1', 'claude-opus-5-5']);
});

test('picker rows map to ids the binary knows; Default is no model', () => {
  const rows = pickerRows(' ❯ 1. Default (recommended) ✔ Opus 5.5 · Most capable\n   2. Opus 5.5\n   3. Mythos 5.1  new\n   ↓ … +4 models');
  assert.deepEqual(rows.map((r) => r.name), ['Default (recommended)', 'Opus 5.5', 'Mythos 5.1']);
  const known = new Set(['claude-opus-5-5', 'claude-haiku-4-5']);
  assert.equal(idForName('Default (recommended)', known), null);
  assert.equal(idForName('Opus 5.5', known), 'claude-opus-5-5');
  assert.equal(idForName('Haiku 4.5', known), 'claude-haiku-4-5');
  assert.equal(idForName('Mythos 5.1', known), null, 'not in the binary: dropped');
});

test('the picker is read to its last row, and only Down / Esc reach it', async () => {
  const log = path.join(TMP, 'keys.log');
  const known = catalog.claudeIdsIn('claude-opus-5-5 claude-fable-5-1 claude-sonnet-5-5 claude-haiku-5-5 claude-opus-5 claude-sonnet-5 '
    + 'claude-opus-4-8 claude-opus-4-7 claude-sonnet-4-6 claude-haiku-4-5 claude-opus-4-1 claude-sonnet-4-5 claude-mythos-5-1');
  const models = await scrapeClaudePicker({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`, cwd: TMP, known,
    env: { ...process.env, FAKE_PICKER_TRUST: '1', FAKE_PICKER_LOG: log }, timeoutMs: 30_000,
  });
  assert.equal(models.length, 13);
  assert.deepEqual(models[0], { id: 'claude-opus-5-5', label: 'Opus 5.5' });
  assert.equal(models.at(-1).id, 'claude-mythos-5-1', 'the rows below the fold were scrolled to');
  const keys = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(!keys.includes('PICKED'), 'nothing was picked');
  const inPicker = keys.filter((k) => k.startsWith('picker:'));
  assert.ok(inPicker.length > 0);
  assert.deepEqual([...new Set(inPicker)].sort(), ['picker:"\\u001b"', 'picker:"\\u001b[B"'], 'only Down and Esc in the picker');
  assert.deepEqual(keys.filter((k) => k.startsWith('trust:')), ['trust:"\\u001b[B"', 'trust:"\\r"'], 'trust: Down to Yes, then Enter');
});

test('a sign-in screen is never answered: the probe gives up', async () => {
  const log = path.join(TMP, 'keys-login.log');
  await assert.rejects(scrapeClaudePicker({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`, cwd: TMP,
    env: { ...process.env, FAKE_PICKER_LOGIN: '1', FAKE_PICKER_LOG: log }, timeoutMs: 3000,
  }), /did not open/);
  const keys = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  assert.ok(keys.every((k) => k === 'login:"\\u001b"'), `only the closing Esc: ${keys}`);
});

test('the 2.1.312 layout: family rows take their version from the text', async () => {
  const rows = pickerRows('   ❯ 1. Default (recommended) ✔  Use the default model (currently Opus 5.5) · $4/$20 per Mtok\n'
    + '     2. Opus                     Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok\n'
    + '     3. Fable                    Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per\n'
    + '                                 Mtok');
  assert.deepEqual(rows.map((r) => r.name), ['Default (recommended)', 'Opus', 'Fable']);
  const known = new Set(['claude-opus-5-5']);
  assert.equal(idForName('Opus', known, rows[1].detail), 'claude-opus-5-5');
  assert.equal(idForName('Fable', known, rows[2].detail), 'fable', 'version not in the binary: the alias the row stands for');
  assert.equal(idForName('Opus', known, 'Sonnet 5.5 · odd'), 'opus', 'another family in the text is not taken');
  assert.equal(idForName('Default (recommended)', known, 'Use the default model (currently Opus 5.5)'), null);
  assert.equal(idForName('Mythos', known, 'Mythos 5.1'), null, 'an unknown family is no alias');

  const log = path.join(TMP, 'keys-families.log');
  const models = await scrapeClaudePicker({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`, cwd: TMP,
    known: new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
    env: { ...process.env, FAKE_PICKER_FAMILIES: '1', FAKE_PICKER_LOG: log }, timeoutMs: 20_000,
  });
  assert.deepEqual(models, [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ]);
  assert.ok(!fs.readFileSync(log, 'utf8').includes('PICKED'));
});

test('the probe starts Claude with hooks, plugins and MCP off, and keeps the sign-in (no --bare)', () => {
  assert.match(CLAUDE_PROBE_COMMAND, /^claude --safe-mode /);
  assert.match(CLAUDE_PROBE_COMMAND, / --strict-mcp-config( |$)/);
  assert.match(CLAUDE_PROBE_COMMAND, / --settings '\{"disableAllHooks":true\}'/);
  assert.doesNotMatch(CLAUDE_PROBE_COMMAND, /--bare/);
  // It is one valid shell line: bash parses it into these words.
  const words = spawnSync('bash', ['-c', `printf '%s\\n' ${CLAUDE_PROBE_COMMAND.replace(/^claude /, '')}`], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(words, ['--safe-mode', '--strict-mcp-config', '--no-chrome', '--settings', '{"disableAllHooks":true}']);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid) => { for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

test('a timed-out picker or list command leaves nothing running behind it', async () => {
  const pidFile = path.join(TMP, 'child-picker.pid');
  // The sign-in screen: the probe gives up at its timeout.
  await assert.rejects(scrapeClaudePicker({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`, cwd: TMP, timeoutMs: 1500,
    env: { ...process.env, FAKE_PICKER_LOGIN: '1', FAKE_PICKER_CHILD: pidFile },
  }), /did not open/);
  const pickerChild = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitGone(pickerChild), 'the picker\'s child was killed with it');

  fs.mkdirSync(config.WORKSPACES_DIR, { recursive: true });
  const listChild = path.join(TMP, 'child-list.pid');
  const script = `process.on('SIGHUP', () => {}); require('fs').writeFileSync(${JSON.stringify(listChild)}, String(require('child_process').spawn(process.execPath, ['-e', "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`;
  await assert.rejects(catalog.runList(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, { timeout: 1500 }), /timed out/);
  assert.ok(await waitGone(Number(fs.readFileSync(listChild, 'utf8'))), 'the list command\'s child was killed with it');

  // A command that exits at once but leaves a child holding its output.
  const leftover = path.join(TMP, 'child-left.pid');
  const out = await catalog.runList(`sh -c '${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" & echo $! > ${leftover}; echo listed'`, { timeout: 10_000 });
  assert.equal(out.trim(), 'listed');
  assert.ok(await waitGone(Number(fs.readFileSync(leftover, 'utf8'))), 'what a finished list command left behind is killed');
});

test('a failed Claude probe is tried once per version; a refresh or a new version tries again', async () => {
  let version = '2.1.312', ready = false, scrapes = 0, works = false;
  const build = catalog.claudeSource({
    version: async () => version, ready: () => ready, probeEnabled: () => true, known: async () => new Set(['claude-opus-5-5']),
    scrape: async () => { scrapes++; if (!works) throw new Error('a first-run screen'); return [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }]; },
  });
  let prev = await build({ previous: undefined });
  assert.equal(scrapes, 0, 'not signed in: never started');
  assert.equal(prev.probed, undefined);
  ready = true;
  prev = await build({ previous: prev });
  assert.equal(scrapes, 1, 'signed in since: tried');
  assert.equal(prev.probed, true);
  assert.deepEqual(prev.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(await build({ previous: prev }), prev, 'same version: the failure is kept, not retried');
  assert.equal(scrapes, 1);
  await build({ previous: prev, force: true });
  assert.equal(scrapes, 2, 'refresh: tried again');
  version = '2.1.313'; works = true;
  prev = await build({ previous: prev });
  assert.equal(scrapes, 3, 'new version: tried again');
  assert.equal(prev.picker, true);
  assert.equal(await build({ previous: prev }), prev);
  assert.equal(scrapes, 3);
  const off = catalog.claudeSource({ version: async () => version, ready: () => true, probeEnabled: () => false, scrape: async () => { scrapes++; return []; } });
  assert.match((await off({})).source, /probe off/);
  assert.equal(scrapes, 3, 'probe off: never started');
});

test('gemini: the VALID_GEMINI_MODELS set of the installed bundle', () => {
  const bundle = `var PREVIEW_GEMINI_MODEL = "gemini-3-pro-preview";
var DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
var BASE_GEMINI_FLASH_MODEL = "gemini-3.5-flash";
var DEFAULT_GEMINI_FLASH_MODEL = BASE_GEMINI_FLASH_MODEL;
var PREVIEW_GEMINI_FLASH_LITE_MODEL = "none";
var GEMMA_4_31B_IT_MODEL = "gemma-4-31b-it";
var PREVIEW_GEMINI_MODEL_AUTO = "auto-gemini-3";
var VALID_GEMINI_MODELS = /* @__PURE__ */ new Set([
  PREVIEW_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_FLASH_LITE_MODEL,
  GEMMA_4_31B_IT_MODEL,
  UNDEFINED_NAME
]);`;
  assert.deepEqual(catalog.parseGeminiRegistry(bundle), ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemma-4-31b-it', 'auto-gemini-3']);
  assert.deepEqual(catalog.parseGeminiRegistry('no registry here'), []);
});

test('the probe is off unless the server was started with AM_CLAUDE_MODEL_PROBE=1', () => {
  assert.equal(catalog.claudeProbeEnabled({}), false);
  assert.equal(catalog.claudeProbeEnabled({ AM_CLAUDE_MODEL_PROBE: '0' }), false);
  assert.equal(catalog.claudeProbeEnabled({ AM_CLAUDE_MODEL_PROBE: 'yes' }), false);
  assert.equal(catalog.claudeProbeEnabled({ AM_CLAUDE_MODEL_PROBE: '1' }), true);
});

const LISTS = {
  claude: { models: [{ id: 'opus' }, { id: 'claude-opus-5-5' }] },
  codex: { models: [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'gpt-6-astra', efforts: ['low', 'ultra'] }] },
  gemini: { models: [{ id: 'gemini-2.5-pro' }] },
};

test('a choice must come from the current list', () => {
  catalog.setModelLists(structuredClone(LISTS));
  const ok = catalog.checkLaunchChoice;
  assert.deepEqual(ok('claude', {}), {});
  assert.deepEqual(ok('claude', { model: '', effort: '' }), {}, 'empty = the CLI default');
  assert.deepEqual(ok('claude', { model: 'claude-opus-5-5', effort: 'max' }), { model: 'claude-opus-5-5', effort: 'max' });
  assert.deepEqual(ok('codex', { model: 'gpt-6-astra', effort: 'ultra' }), { model: 'gpt-6-astra', effort: 'ultra' });
  assert.deepEqual(ok('codex', { effort: 'ultra' }), { effort: 'ultra' }, 'no model: any listed model\'s level');
  assert.deepEqual(ok('openclaw', { effort: 'adaptive' }), { effort: 'adaptive' });
  const refused = (cli, choice, re) => assert.throws(() => ok(cli, choice), (e) => e.statusCode === 400 && e.code === 'invalid-launch-option' && re.test(e.message), JSON.stringify(choice));
  refused('claude', { model: 'claude-opus-9' }, /not a model/);
  refused('claude', { model: "opus'; rm -rf /" }, /not a model/);
  refused('claude', { model: 'x'.repeat(121) }, /at most 120/);
  refused('claude', { model: ['opus'] }, /must be a string/);
  refused('claude', { effort: 'ultra' }, /not an effort/);
  refused('codex', { model: 'gpt-5.5', effort: 'ultra' }, /not an effort gpt-5.5 supports/);
  refused('gemini', { effort: 'high' }, /no reasoning effort/);
  refused('openclaw', { model: 'x' }, /no model at launch/);
  refused('fx', { model: 'x' }, /no model or effort/);
  refused('shell', { effort: 'high' }, /no model or effort/);
  refused('opencode', { model: 'anthropic/x' }, /not a model/, 'no list built: no model');
});

test('launch options: a CLI without a list offers no model', () => {
  catalog.setModelLists(structuredClone(LISTS));
  const by = Object.fromEntries(catalog.launchOptions().clis.map((c) => [c.id, c]));
  assert.equal(by.claude.model, true);
  assert.deepEqual(by.claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(by.codex.perModelEfforts, true);
  assert.equal(by.codex.efforts, null);
  assert.equal(by.opencode.model, false);
  assert.equal(by.openclaw.model, false);
  assert.ok(by.openclaw.efforts.includes('adaptive'));
  assert.equal(by.fx, undefined);
});

test('refresh: one CLI at a time, a failure keeps the last list, saved to disk', async () => {
  catalog.setModelLists({ gemini: { models: [{ id: 'old' }], source: 's' } });
  const order = [];
  await catalog.refreshModelLists({ sources: {
    claude: async () => { order.push('claude'); return { models: [{ id: 'opus' }, { id: "bad id'" }, { id: 'opus' }], source: 't' }; },
    gemini: async () => { order.push('gemini'); throw new Error('boom'); },
    codex: async () => { order.push('codex'); return { models: [], source: 't' }; },
  } });
  const saved = JSON.parse(fs.readFileSync(path.join(config.STATE_DIR, 'cli-models.json'), 'utf8')).clis;
  // Only installed CLIs are asked; on this box that may be any subset.
  const installed = new Set(config.cliCatalog().filter((c) => c.available).map((c) => c.id));
  assert.deepEqual(order, ['claude', 'gemini', 'codex'].filter((id) => installed.has(id)));
  if (installed.has('claude')) assert.deepEqual(saved.claude.models, [{ id: 'opus' }], 'bad shapes and repeats dropped');
  if (installed.has('gemini')) {
    assert.deepEqual(saved.gemini.models, [{ id: 'old' }]);
    assert.equal(saved.gemini.error, 'boom');
  }
  if (installed.has('codex')) assert.match(saved.codex.error, /listed no models/);
});
