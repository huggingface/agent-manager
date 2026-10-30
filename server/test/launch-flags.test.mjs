// A session's model / effort reaches every launch line of its CLI.
//
// Each case builds the line with runner.commandFor() — fresh, seeded prompt,
// resume, continue, shared folder, fallbacks — and then RUNS it in bash with
// stub CLIs on PATH that record their argv. So the assertions are on what the
// CLI would receive, which also proves the quoting: a value that broke out of
// its quotes would show up as a different argv, or run something.
// Run with: node test/launch-flags.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-launch-flags-'));
const HOME = path.join(TMP, 'home');
const BIN = path.join(TMP, 'bin');
const XDG = path.join(TMP, 'xdg');
for (const d of [HOME, BIN, path.join(XDG, 'opencode')]) fs.mkdirSync(d, { recursive: true });
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.HOME = HOME;
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, '.claude');
process.env.XDG_DATA_HOME = XDG;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(TMP, 'input-required');
delete process.env.OPENCLAW_HOME;

// opencode resumes a pin only when its row exists in opencode's own db.
const db = new DatabaseSync(path.join(XDG, 'opencode', 'opencode.db'));
db.exec('create table session (id text primary key, directory text not null, parent_id text, time_created integer not null)');
db.prepare('insert into session values (?, ?, ?, ?)').run('ses_pinned1', '/w', null, 1);

const LOG = path.join(TMP, 'argv.log');
const PWNED = path.join(TMP, 'PWNED'); // see NASTY below
// Records `<name> <args…>` one line per call, fields separated by \x1f. Exits
// non-zero when STUB_FAIL names a flag in its argv (to drive `|| exec …`).
const stub = `#!/bin/sh
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "${LOG}"
for a in "$@"; do [ -n "$STUB_FAIL" ] && [ "$a" = "$STUB_FAIL" ] && exit 3; done
exit 0
`;
for (const name of ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'openclaw', 'fx', 'agy']) {
  fs.writeFileSync(path.join(BIN, name), stub, { mode: 0o755 });
}

const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const { tuiSpec } = await import('../../scripts/am-codex-context.mjs');
config.ensureDirs();
sessions.init();

/** Run a launch line; the argv of every stub call, in order. */
function launch(line, env = {}) {
  fs.rmSync(LOG, { force: true });
  const r = spawnSync('bash', ['-c', line], {
    cwd: TMP, encoding: 'utf8',
    env: { PATH: `${BIN}:/usr/bin:/bin`, HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, ...env },
  });
  assert.equal(fs.existsSync(PWNED), false, `a value escaped its quotes:\n${line}`);
  const calls = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trimEnd().split('\n').map((l) => l.split('\x1f')) : [];
  return { calls, status: r.status, line };
}
let n = 0;
const make = (cli, fields = {}) => {
  const s = sessions.create({ name: `${cli}-${++n}`, cli, path: fields.path ?? `w${n}` });
  return sessions.update(s.id, fields);
};
// No slash in it, so Hermes' provider/model split leaves it whole. The lines
// run with cwd TMP, so a bare `touch PWNED` that ran would be seen.
const NASTY = `x'; touch PWNED; echo '$(touch PWNED)\`touch PWNED\`"`;

test('every CLI with a launch block quotes what it is given', () => {
  for (const cli of config.CLIS.filter((c) => c.launch)) {
    const { calls } = launch(`exec ${cli.run(cli.launch.flags({ model: NASTY, effort: 'high' }))}`);
    assert.equal(calls.length, 1, cli.id);
    if (cli.launch.model) assert.ok(calls[0].includes(NASTY), `${cli.id}: the value arrives whole as one argument`);
  }
});

test('a stored value with a bad shape never reaches the line', () => {
  for (const [model, effort] of [[NASTY, 'high'], ['opus', 'high; rm -rf /'], ['$(id)', '$(id)'], ['a b', 'HIGH']]) {
    const s = { cli: 'claude', model, effort };
    const flags = config.launchFlags(s);
    assert.doesNotMatch(flags, /rm -rf|\$\(|touch/, flags);
  }
  assert.equal(config.launchFlags({ cli: 'claude', model: 'opus', effort: 'high' }), "--model 'opus' --effort 'high'");
  assert.equal(config.launchFlags({ cli: 'fx', model: 'opus', effort: 'high' }), '', 'fx takes neither');
  assert.equal(config.launchFlags({ cli: 'gemini', model: 'gemini-2.5-pro', effort: 'high' }), "-m 'gemini-2.5-pro'", 'gemini: model only');
  assert.equal(config.launchFlags({ cli: 'openclaw', model: 'x', effort: 'high' }), "--thinking 'high'", 'openclaw: effort only');
  assert.equal(config.launchFlags({ cli: 'antigravity', model: 'gemini-4-argon-high', effort: 'max' }), "--model 'gemini-4-argon-high' --effort 'max'");
  assert.equal(config.launchFlags({ cli: 'shell', model: 'x' }), '');
});

test('claude: fresh, seeded, resumed, transcript gone, and the fallback', () => {
  const choice = { model: 'claude-opus-5-5', effort: 'max' };
  const want = ['--model', 'claude-opus-5-5', '--effort', 'max'];
  const fresh = make('claude', choice);
  let r = launch(runner.commandFor(fresh));
  assert.deepEqual(r.calls, [['claude', ...want, '--session-id', fresh.sessionUuid]]);

  const seeded = make('claude', { ...choice, pendingPrompt: "fix it; don't $(break)" });
  r = launch(runner.commandFor(seeded));
  assert.deepEqual(r.calls, [['claude', ...want, '--session-id', seeded.sessionUuid, "fix it; don't $(break)"]]);

  // --session-id refused: the last-resort relaunch keeps the flags too.
  r = launch(runner.commandFor(fresh), { STUB_FAIL: '--session-id' });
  assert.deepEqual(r.calls, [['claude', ...want, '--session-id', fresh.sessionUuid], ['claude', ...want]]);

  const resumed = make('claude', { ...choice, everStarted: true });
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${resumed.sessionUuid}.jsonl`), '{}\n');
  r = launch(runner.commandFor(resumed));
  assert.deepEqual(r.calls, [['claude', '--resume', resumed.sessionUuid, ...want]]);

  const purged = make('claude', { ...choice, everStarted: true });
  r = launch(runner.commandFor(purged));
  assert.deepEqual(r.calls, [['claude', ...want, '--session-id', purged.sessionUuid]]);

  const plain = make('claude');
  assert.deepEqual(launch(runner.commandFor(plain)).calls, [['claude', '--session-id', plain.sessionUuid]], 'no choice = today\'s line');
});

test('codex: fresh, seeded with images, pinned resume, resume --last, shared folder', () => {
  const choice = { model: 'gpt-5.5', effort: 'xhigh' };
  const flags = ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"'];
  const signals = (call) => call.slice(1).filter((a, i, all) => a !== '-c' || !/^tui\./.test(all[i + 1])).filter((a) => !/^tui\./.test(a));

  const fresh = make('codex', choice);
  let call = launch(runner.commandFor(fresh)).calls[0];
  assert.equal(call[0], 'codex');
  assert.deepEqual(signals(call), flags);

  const seeded = make('codex', { ...choice, pendingPrompt: 'go', pendingImagePaths: ['/tmp/a b.png'] });
  call = launch(runner.commandFor(seeded)).calls[0];
  assert.deepEqual(signals(call), [...flags, '-i', '/tmp/a b.png', 'go']);

  const rollout = path.join(TMP, 'rollout.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const pinned = make('codex', { ...choice, everStarted: true, codexSessionId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', codexRollout: rollout });
  call = launch(runner.commandFor(pinned)).calls[0];
  assert.deepEqual(signals(call), ['resume', ...flags, '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);

  const gone = make('codex', { ...choice, everStarted: true, codexSessionId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', codexRollout: path.join(TMP, 'missing.jsonl') });
  assert.deepEqual(signals(launch(runner.commandFor(gone)).calls[0]), flags, 'rollout gone: fresh, with flags');

  const alone = make('codex', { ...choice, everStarted: true });
  let r = launch(runner.commandFor(alone));
  assert.deepEqual(signals(r.calls[0]), ['resume', '--last', ...flags]);
  r = launch(runner.commandFor(alone), { STUB_FAIL: '--last' });
  assert.deepEqual(r.calls.map(signals), [['resume', '--last', ...flags], flags], '`|| exec run` keeps the flags');

  const a = make('codex', { ...choice, everStarted: true, path: 'shared-codex' });
  make('codex', { everStarted: true, path: 'shared-codex' });
  assert.deepEqual(signals(launch(runner.commandFor(a)).calls[0]), flags, 'shared folder: fresh, with flags');
});

test('shared Codex helper: the TUI argv carries the flags, and checks their shape', () => {
  const target = { threadId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', socket: '/s.sock', codexHome: '/h', workdir: '/w' };
  assert.deepEqual(tuiSpec(target, {}).args, ['--remote', 'unix:///s.sock', 'resume', target.threadId]);
  assert.deepEqual(tuiSpec({ ...target, model: 'gpt-5.5', effort: 'high' }, {}).args,
    ['--remote', 'unix:///s.sock', 'resume', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', target.threadId]);
  assert.throws(() => tuiSpec({ ...target, model: NASTY }, {}), /Invalid shared client target/);
  assert.throws(() => tuiSpec({ ...target, effort: 'high"; x' }, {}), /Invalid shared client target/);
  assert.throws(() => tuiSpec({ ...target, model: 5 }, {}), /Invalid shared client target/);
});

test('gemini: fresh, seeded, restarted (no resume)', () => {
  const choice = { model: 'gemini-2.5-pro' };
  assert.deepEqual(launch(runner.commandFor(make('gemini', choice))).calls, [['gemini', '-m', 'gemini-2.5-pro']]);
  assert.deepEqual(launch(runner.commandFor(make('gemini', { ...choice, pendingPrompt: 'hi' }))).calls, [['gemini', '-m', 'gemini-2.5-pro', '-i', 'hi']]);
  assert.deepEqual(launch(runner.commandFor(make('gemini', { ...choice, everStarted: true }))).calls, [['gemini', '-m', 'gemini-2.5-pro']]);
});

test('opencode: fresh, seeded, pinned, continue, shared folder', () => {
  const choice = { model: 'anthropic/claude-fable-5' };
  const m = ['-m', 'anthropic/claude-fable-5'];
  assert.deepEqual(launch(runner.commandFor(make('opencode', choice))).calls, [['opencode', ...m]]);
  assert.deepEqual(launch(runner.commandFor(make('opencode', { ...choice, pendingPrompt: 'hi' }))).calls, [['opencode', ...m, '--prompt', 'hi']]);
  assert.deepEqual(launch(runner.commandFor(make('opencode', { ...choice, everStarted: true, opencodeSessionId: 'ses_pinned1' }))).calls,
    [['opencode', '--session', 'ses_pinned1', ...m]]);
  const alone = make('opencode', { ...choice, everStarted: true });
  assert.deepEqual(launch(runner.commandFor(alone)).calls, [['opencode', '--continue', ...m]]);
  assert.deepEqual(launch(runner.commandFor(alone), { STUB_FAIL: '--continue' }).calls, [['opencode', '--continue', ...m], ['opencode', ...m]]);
  const a = make('opencode', { ...choice, everStarted: true, path: 'shared-oc' });
  make('opencode', { everStarted: true, path: 'shared-oc' });
  assert.deepEqual(launch(runner.commandFor(a)).calls, [['opencode', ...m]]);
});

test('hermes: provider and model split, flags before -c', () => {
  const choice = { model: 'huggingface/moonshotai/Kimi-K2.5', effort: 'low' };
  const f = ['--provider', 'huggingface', '-m', 'moonshotai/Kimi-K2.5', '--reasoning', 'low'];
  assert.deepEqual(launch(runner.commandFor(make('hermes', choice))).calls, [['hermes', ...f]]);
  const again = make('hermes', { ...choice, everStarted: true });
  assert.deepEqual(launch(runner.commandFor(again)).calls, [['hermes', ...f, '-c']]);
  assert.deepEqual(launch(runner.commandFor(again), { STUB_FAIL: '-c' }).calls, [['hermes', ...f, '-c'], ['hermes', ...f]]);
});

test('antigravity: flags on fresh, seeded, continue, pinned resume and shared folder; key provider kept', () => {
  const choice = { model: 'gemini-4-argon-high', effort: 'xhigh' };
  const f = ['--model', 'gemini-4-argon-high', '--effort', 'xhigh'];
  const key = { GEMINI_API_KEY: 'k' };
  const provider = ['--settings', '{"modelProvider":"gemini"}'];
  assert.deepEqual(launch(runner.commandFor(make('antigravity', choice)), key).calls, [['agy', ...provider, ...f]]);
  assert.deepEqual(launch(runner.commandFor(make('antigravity', choice))).calls, [['agy', ...f]], 'no key: no provider, flags kept');
  const q = "fix it; don't $(break)";
  assert.deepEqual(launch(runner.commandFor(make('antigravity', { ...choice, pendingPrompt: q })), key).calls,
    [['agy', ...provider, ...f, '-i', q]]);
  const alone = make('antigravity', { ...choice, everStarted: true });
  assert.deepEqual(launch(runner.commandFor(alone), key).calls, [['agy', ...provider, ...f, '-c']]);
  assert.deepEqual(launch(runner.commandFor(alone), { ...key, STUB_FAIL: '-c' }).calls,
    [['agy', ...provider, ...f, '-c'], ['agy', ...provider, ...f]]);
  const ID = '79cd3d9b-b387-44da-91c0-2df98a2ae37e';
  const pinned = make('antigravity', { ...choice, everStarted: true, antigravityConversationId: ID });
  assert.deepEqual(launch(runner.commandFor(pinned), key).calls, [['agy', ...provider, ...f]], 'conversation gone: fresh, flags kept');
  const conv = path.join(HOME, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, `${ID}.db`), '');
  assert.deepEqual(launch(runner.commandFor(pinned), key).calls, [['agy', ...provider, ...f, '--conversation', ID]]);
  const a = make('antigravity', { ...choice, everStarted: true, path: 'shared-agy' });
  make('antigravity', { everStarted: true, path: 'shared-agy' });
  assert.deepEqual(launch(runner.commandFor(a), key).calls, [['agy', ...provider, ...f]], 'shared folder: fresh, flags kept');
  assert.deepEqual(launch(runner.commandFor(make('antigravity', { everStarted: true })), key).calls, [['agy', ...provider, '-c']], 'no choice: as before');
});

test('openclaw: --thinking on both the onboarding and the ready path; no model', () => {
  const s = make('openclaw', { model: 'ignored', effort: 'adaptive' });
  assert.deepEqual(launch(runner.commandFor(s)).calls, [['openclaw', 'onboard'], ['openclaw', 'chat', '--thinking', 'adaptive']]);
  fs.mkdirSync(path.join(HOME, '.openclaw'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), '{}');
  assert.deepEqual(launch(runner.commandFor(s)).calls, [['openclaw', 'chat', '--thinking', 'adaptive']]);
});

test('fx: never takes a flag', () => {
  const s = make('fx', { model: 'm', effort: 'high' });
  assert.deepEqual(launch(runner.commandFor(s)).calls, [['fx']]);
});
