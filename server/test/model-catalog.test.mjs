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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-model-catalog-'));
process.env.DATA_DIR = path.join(TMP, 'data');
const config = await import('../src/config.js');
const catalog = await import('../src/model-catalog.js');
const { scrapeClaudePicker, pickerRows, idForName } = await import('../src/claude-models.js');
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
