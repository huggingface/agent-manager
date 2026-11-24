// AM runs agy with HOME on local disk (agy-home.js), so its SQLite never goes
// through /data/home/.gemini, where a link does not reliably stay a link
// (from 2026-11-20 both were real directories on hf-mount and four
// conversations came back malformed).
//
// Everything in temporary directories with an allowlisted environment: a
// shell inside a running Space exports the real live and durable paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../scripts/agent-state.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
const data = path.join(root, 'data');
const local = path.join(root, 'local');
const bucketHome = path.join(data, 'home');
const LIVE = path.join(local, 'antigravity-home');
const AGY_HOME = path.join(local, 'agy-home');

// The server's view, set before anything reads it.
Object.assign(process.env, {
  DATA_DIR: data, HOME: bucketHome, AM_LOCAL: local, ANTIGRAVITY_LIVE: LIVE, AGY_HOME,
  AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'),
});
delete process.env.HF_TOKEN; delete process.env.XDG_CONFIG_HOME;
fs.mkdirSync(bucketHome, { recursive: true });

const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
// The operator's dotfiles, on the bucket.
put(path.join(bucketHome, '.gitconfig'), '[user]\n\tname = Bucket User\n\temail = user@example.invalid\n');
put(path.join(bucketHome, '.config/gh/config.yml'), 'git_protocol: ssh\n');
put(path.join(bucketHome, '.config/gh/hosts.yml'), 'github.com:\n    user: someone\n');
put(path.join(bucketHome, '.cache/huggingface/token'), 'hf_test_token_from_bucket');
put(path.join(bucketHome, '.ssh/config'), 'Host *\n');
put(path.join(bucketHome, '.agents/skills/x/SKILL.md'), 'x');
put(path.join(bucketHome, '.gemini/GEMINI.md'), 'gemini extras');
put(path.join(bucketHome, '.gemini/antigravity-cli.bucket-20261124-1749/x'), 'old aside copy');

const { prepareAgyHome } = await import('../src/agy-home.js');
const { agyCommand, cliById } = await import('../src/config.js');
const { agyConversationPath, agyHome } = await import('../src/antigravity.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
sessions.init();

const isLinkTo = (p, t) => { try { return fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === t; } catch { return false; } };

test('the local HOME: state links to the live tree, every other entry to the bucket HOME', () => {
  const h = prepareAgyHome();
  assert.equal(h.stateOk, true, JSON.stringify(h));
  assert.ok(isLinkTo(path.join(AGY_HOME, '.gemini/antigravity-cli'), path.join(LIVE, 'antigravity-cli')));
  assert.ok(isLinkTo(path.join(AGY_HOME, '.gemini/config'), path.join(LIVE, 'config')));
  for (const n of ['.gitconfig', '.config', '.cache', '.ssh', '.agents']) {
    assert.ok(isLinkTo(path.join(AGY_HOME, n), path.join(bucketHome, n)), n);
  }
  assert.ok(isLinkTo(path.join(AGY_HOME, '.gemini/GEMINI.md'), path.join(bucketHome, '.gemini/GEMINI.md')));
  assert.equal(fs.existsSync(path.join(AGY_HOME, '.gemini/antigravity-cli.bucket-20261124-1749')), false, 'bucket copies are not linked');
  assert.equal(agyHome(), path.join(LIVE, 'antigravity-cli'), 'the server reads conversations from the live tree');
});

test('it is refreshed, and never replaces what agy or a tool made in it', () => {
  put(path.join(bucketHome, '.npmrc'), 'registry=https://example.invalid\n');
  put(path.join(AGY_HOME, 'notes.txt'), 'made inside agy');
  const h = prepareAgyHome();
  assert.ok(isLinkTo(path.join(AGY_HOME, '.npmrc'), path.join(bucketHome, '.npmrc')), 'a dotfile added later is linked');
  assert.equal(fs.readFileSync(path.join(AGY_HOME, 'notes.txt'), 'utf8'), 'made inside agy');
  assert.equal(h.stateOk, true);
});

test('tools inside agy still see git, gh and HF auth', () => {
  const env = { PATH: process.env.PATH, HOME: AGY_HOME, LANG: 'C.UTF-8' };
  assert.equal(execFileSync('git', ['config', '--global', 'user.name'], { env, encoding: 'utf8' }).trim(), 'Bucket User');
  assert.equal(execFileSync('gh', ['config', 'get', 'git_protocol'], { env, encoding: 'utf8' }).trim(), 'ssh');
  // Where huggingface_hub and `hf` read the token without HF_TOKEN set.
  assert.equal(execFileSync('sh', ['-c', 'cat "$HOME/.cache/huggingface/token"'], { env, encoding: 'utf8' }), 'hf_test_token_from_bucket');
  const tok = spawnSync('python3', ['-c', 'from huggingface_hub import get_token; print(get_token())'], { env, encoding: 'utf8' });
  if (!/No module named/.test(tok.stderr)) assert.equal(tok.stdout.trim(), 'hf_test_token_from_bucket', tok.stderr);
  // `cd ~` inside agy lands in the local HOME, which lists the bucket's dotfiles.
  assert.match(execFileSync('sh', ['-c', 'cd ~ && pwd && ls -a'], { env, encoding: 'utf8' }), new RegExp(`${AGY_HOME}[\\s\\S]*\\.gitconfig`));
});

// A stand-in agy: writes a conversation where its HOME says, and says where.
const bin = path.join(root, 'bin');
put(path.join(bin, 'agy'), '#!/bin/sh\nd="$HOME/.gemini/antigravity-cli/conversations"; mkdir -p "$d" && echo db > "$d/new.db"; echo "HOME=$HOME ARGS=$*"\n');
fs.chmodSync(path.join(bin, 'agy'), 0o755);
const launch = (line) => execFileSync('bash', ['-c', line], {
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: bucketHome }, encoding: 'utf8', cwd: root,
});
const bucketAgy = path.join(bucketHome, '.gemini/antigravity-cli');
const liveNew = path.join(LIVE, 'antigravity-cli/conversations/new.db');

for (const [name, setup] of [
  ['missing', () => fs.rmSync(bucketAgy, { recursive: true, force: true })],
  ['a real directory', () => { fs.rmSync(bucketAgy, { recursive: true, force: true }); fs.mkdirSync(bucketAgy, { recursive: true }); }],
]) {
  test(`agy launched by AM writes its conversations to the local tree when the bucket's ~/.gemini/antigravity-cli is ${name}`, () => {
    setup();
    fs.rmSync(liveNew, { force: true });
    prepareAgyHome();
    const s = sessions.create({ name: `agy-${name}`, cli: 'antigravity', path: `p-${name.replace(/ /g, '-')}` });
    const out = launch(runner.commandFor(sessions.get(s.id)));
    assert.match(out, new RegExp(`HOME=${AGY_HOME} `));
    assert.ok(fs.existsSync(liveNew), 'written under $ANTIGRAVITY_LIVE');
    assert.equal(fs.existsSync(path.join(bucketAgy, 'conversations/new.db')), false, 'nothing on the bucket');
  });
}

test('a pinned pane resumes from the local tree, not the bucket path', () => {
  const ID = '79cd3d9b-b387-44da-91c0-2df98a2ae37e';
  const s = sessions.create({ name: 'agy-pin', cli: 'antigravity', path: 'p-pin' });
  sessions.update(s.id, { everStarted: true, antigravityConversationId: ID });
  put(agyConversationPath(ID), 'db');
  assert.equal(agyConversationPath(ID), path.join(LIVE, 'antigravity-cli/conversations', `${ID}.db`));
  assert.match(launch(runner.commandFor(sessions.get(s.id))), new RegExp(`--conversation ${ID}`));
  // Only on the bucket path: not found, so a fresh launch (as before).
  fs.rmSync(agyConversationPath(ID));
  put(path.join(bucketHome, '.gemini/antigravity-cli/conversations', `${ID}.db`), 'db');
  assert.doesNotMatch(launch(runner.commandFor(sessions.get(s.id))), /--conversation/);
});

test('the model probe uses the local HOME too', () => {
  assert.match(agyCommand('models'), /^env HOME='[^']*agy-home' agy /);
  assert.match(cliById('antigravity').run(), /^env HOME=/);
});

test('backup and restore round-trip through the local HOME', () => {
  // The checkpoint script's own world: every live and durable path in root.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: bucketHome, DATA_DIR: data, AM_LOCAL: local, AGENT_STATE_BUDGET: '120' };
  for (const [k, live, durable] of [['CODEX', 'codex', 'codex'], ['CLAUDE', 'claude', 'claude'], ['GEMINI', 'gemini-home/.gemini', 'gemini'],
    ['OPENCLAW', 'openclaw', 'openclaw'], ['OPENCODE', 'opencode', 'opencode'], ['HERMES', 'hermes', 'hermes'], ['FX', 'fx-home', 'fx'],
    ['ANTIGRAVITY', 'antigravity-home', 'antigravity']]) {
    env[{ CODEX: 'CODEX_HOME', CLAUDE: 'CLAUDE_CONFIG_DIR', OPENCLAW: 'OPENCLAW_STATE_DIR' }[k] || `${k}_LIVE`] = path.join(local, live);
    env[`${k}_DURABLE`] = path.join(data, 'state', durable);
  }
  env.GEMINI_CLI_HOME = path.join(local, 'gemini-home');
  // agy writes through its HOME (the stand-ins above wrote no real databases).
  fs.rmSync(path.join(LIVE, 'antigravity-cli/conversations'), { recursive: true, force: true });
  fs.mkdirSync(path.join(LIVE, 'antigravity-cli/conversations'), { recursive: true });
  const db = path.join(AGY_HOME, '.gemini/antigravity-cli/conversations/round.db');
  execFileSync('sqlite3', [db, "create table t(x); insert into t values ('kept');"]);
  const ck = spawnSync('sh', [script, 'checkpoint'], { env, encoding: 'utf8' });
  assert.equal(ck.status, 0, ck.stderr);
  assert.equal(execFileSync('sqlite3', [path.join(data, 'state/antigravity/antigravity-cli/conversations/round.db'), 'select x from t'], { encoding: 'utf8' }).trim(), 'kept');
  // A container restart: local disk is gone.
  fs.rmSync(local, { recursive: true, force: true });
  const rs = spawnSync('sh', [script, 'restore'], { env: { ...env, AGENT_STATE_FROM_ENTRYPOINT: '1' }, encoding: 'utf8' });
  assert.equal(rs.status, 0, rs.stderr);
  assert.equal(prepareAgyHome().stateOk, true);
  assert.equal(execFileSync('sqlite3', [db, 'select x from t'], { encoding: 'utf8' }).trim(), 'kept', 'readable through the local HOME again');
});
