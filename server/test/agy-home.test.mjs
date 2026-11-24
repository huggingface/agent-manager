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

// ---------- agy started outside a pane: the wrapper on PATH ----------
// The /etc/profile.d snippet the image installs (Dockerfile), which every login
// shell runs after /etc/profile has reset PATH.
const dockerfile = fs.readFileSync(path.resolve(here, '../../Dockerfile'), 'utf8');
const profileD = dockerfile.slice(dockerfile.indexOf('RUN printf \'%s\\n\' \\'), dockerfile.indexOf('> /etc/profile.d/agent-manager.sh'))
  .split('\n').slice(1).map((l) => l.trim().replace(/^'|' \\$/g, '')).filter(Boolean).join('\n');

test('a non-interactive `bash -lc agy …` (another agent\'s tool shell) gets the local HOME', () => {
  assert.match(profileD, /PATH="\$AM_LOCAL\/agy-wrap:/, 'the image puts the wrapper first in login shells');
  assert.match(fs.readFileSync(path.resolve(here, '../../entrypoint.sh'), 'utf8'), /export PATH="\$AM_LOCAL\/agy-wrap:/);
  // The layout entrypoint.sh makes: the wrapper, and the real agy behind it.
  fs.mkdirSync(path.join(local, 'agy-wrap'), { recursive: true });
  fs.rmSync(path.join(local, 'agy-wrap/agy'), { force: true });
  fs.symlinkSync(path.resolve(here, '../../scripts/agy-wrapper.sh'), path.join(local, 'agy-wrap/agy'));
  put(path.join(local, 'bin/agy'), fs.readFileSync(path.join(bin, 'agy')));
  fs.chmodSync(path.join(local, 'bin/agy'), 0o755);
  // A login shell's profile: here ~/.profile stands in for /etc/profile.d.
  const shellHome = path.join(root, 'shell-home');
  put(path.join(shellHome, '.profile'), `${profileD}\n`);
  prepareAgyHome();
  fs.rmSync(liveNew, { force: true });
  fs.rmSync(bucketAgy, { recursive: true, force: true });
  const env = { PATH: '/usr/bin:/bin', HOME: shellHome, AM_LOCAL: local, AGY_HOME, LANG: 'C.UTF-8' };
  const out = execFileSync('bash', ['-lc', 'agy models'], { env, encoding: 'utf8', cwd: root });
  assert.match(out, new RegExp(`HOME=${AGY_HOME} ARGS=models`));
  assert.ok(fs.existsSync(liveNew), 'its conversation went to the live tree');
  assert.equal(fs.existsSync(bucketAgy), false, 'nothing under the bucket HOME');
  // `sh -c` straight from a process the manager started (PATH inherited).
  const inherited = { PATH: `${path.join(local, 'agy-wrap')}:${path.join(local, 'bin')}:/usr/bin:/bin`, HOME: bucketHome, AGY_HOME };
  assert.match(execFileSync('sh', ['-c', 'agy -p hi'], { env: inherited, encoding: 'utf8' }), new RegExp(`HOME=${AGY_HOME} ARGS=-p hi`));
});

test('the wrapper refuses, rather than fall back to the bucket, when the local HOME is not set up', () => {
  const env = { PATH: `${path.join(local, 'agy-wrap')}:${path.join(local, 'bin')}:/usr/bin:/bin`, HOME: bucketHome, AGY_HOME: path.join(root, 'no-such-home') };
  const r = spawnSync('sh', ['-c', 'agy models'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not set up/);
  assert.equal(fs.existsSync(bucketAgy), false);
});

// ---------- a linked dotfile replaced by a save by rename ----------
const { layoutAgyHome, readStateLinkHealth } = await import('../src/state-links.js');
const logFile = path.join(data, 'state/agent-state.log');
const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); return fn(); };

test('a sed -i\'d dotfile is copied back to the bucket and linked again; nothing is dropped', async () => {
  put(path.join(bucketHome, '.bashrc'), 'export A=1\n');
  prepareAgyHome();
  const link = path.join(AGY_HOME, '.bashrc');
  assert.ok(isLinkTo(link, path.join(bucketHome, '.bashrc')));
  execFileSync('sed', ['-i', 's/A=1/A=2/', link]); // rename-save: the link becomes a local file
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);

  const h = layoutAgyHome({ reason: 'test' });
  assert.ok(isLinkTo(link, path.join(bucketHome, '.bashrc')), 'linked again');
  assert.equal(fs.readFileSync(path.join(bucketHome, '.bashrc'), 'utf8'), 'export A=2\n', 'the edit reached the bucket');
  assert.equal(h.restored.length, 1);
  assert.match(h.restored[0].action, /copied back/);
  assert.equal(fs.readFileSync(h.restored[0].aside, 'utf8'), 'export A=2\n', 'the local copy is kept');
  const health = readStateLinkHealth();
  assert.equal(health.homeRestored[0].path, link, 'surfaced in /api/info.stateLinks');
  assert.ok(await waitFor(() => fs.existsSync(logFile) && /agy-home: .*\.bashrc had become a local file/.test(fs.readFileSync(logFile, 'utf8'))), 'logged durably');
});

test('when the bucket copy is the newer one it is kept, and the local copy is set aside', () => {
  put(path.join(bucketHome, '.inputrc'), 'bucket v1\n');
  prepareAgyHome();
  const link = path.join(AGY_HOME, '.inputrc');
  fs.unlinkSync(link);
  put(link, 'local old\n');
  const past = Date.now() / 1000 - 3600;
  fs.utimesSync(link, past, past);
  const h = layoutAgyHome({ reason: 'test' });
  assert.ok(isLinkTo(link, path.join(bucketHome, '.inputrc')));
  assert.equal(fs.readFileSync(path.join(bucketHome, '.inputrc'), 'utf8'), 'bucket v1\n');
  const r = h.restored.find((x) => x.path === link);
  assert.match(r.action, /bucket copy is newer/);
  assert.equal(fs.readFileSync(r.aside, 'utf8'), 'local old\n');
});

test('a linked directory replaced by a local one: newer files go back in the background, then it is linked again', async () => {
  put(path.join(bucketHome, '.vim/a.vim'), 'old a\n');
  put(path.join(bucketHome, '.vim/b.vim'), 'bucket b\n');
  prepareAgyHome();
  const link = path.join(AGY_HOME, '.vim');
  fs.unlinkSync(link);
  put(path.join(link, 'a.vim'), 'new a\n');
  put(path.join(link, 'c.vim'), 'new c\n');
  const h = layoutAgyHome({ reason: 'test' });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false, 'not on the launch path: done in the background');
  assert.equal(h.pendingDirs.length, 1);
  await h.reported;
  assert.ok(isLinkTo(link, path.join(bucketHome, '.vim')));
  assert.equal(fs.readFileSync(path.join(bucketHome, '.vim/a.vim'), 'utf8'), 'new a\n');
  assert.equal(fs.readFileSync(path.join(bucketHome, '.vim/b.vim'), 'utf8'), 'bucket b\n');
  assert.equal(fs.readFileSync(path.join(bucketHome, '.vim/c.vim'), 'utf8'), 'new c\n');
  // The bucket's a.vim it overwrote is kept, on local disk and on the bucket.
  const rec = readStateLinkHealth().homeRestored.find((x) => x.path === link);
  assert.equal(rec.bucketKept.length, 2);
  for (const k of rec.bucketKept) assert.equal(fs.readFileSync(k, 'utf8'), 'old a\n');
  assert.ok(rec.bucketKept.some((k) => k.startsWith(path.join(bucketHome, '.agy-home-replaced'))));
});

test('a bucket file with an older preserved mtime is overwritten only after a copy of it is kept, twice', async () => {
  // A tool makes ~/.notes in the local HOME first; then ~/.notes appears on the
  // bucket with an OLDER mtime (cp -p, rsync -a, tar, a restore).
  const link = path.join(AGY_HOME, '.notes');
  put(link, 'local notes\n');
  prepareAgyHome();
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false, 'no bucket counterpart yet: left alone');
  put(path.join(bucketHome, '.notes'), 'restored bucket notes\n');
  const past = Date.now() / 1000 - 86400;
  fs.utimesSync(path.join(bucketHome, '.notes'), past, past);
  const h = layoutAgyHome({ reason: 'test' });
  const r = h.restored.find((x) => x.path === link);
  assert.match(r.action, /copied back/);
  assert.equal(fs.readFileSync(path.join(bucketHome, '.notes'), 'utf8'), 'local notes\n');
  assert.equal(r.bucketKept.length, 2, 'kept on local disk and on the bucket');
  for (const k of r.bucketKept) assert.equal(fs.readFileSync(k, 'utf8'), 'restored bucket notes\n');
  const durable = r.bucketKept.find((k) => k.startsWith(path.join(bucketHome, '.agy-home-replaced') + path.sep));
  assert.ok(durable, 'one copy survives a restart (on the bucket)');
  assert.equal(fs.readFileSync(r.aside, 'utf8'), 'local notes\n');
  await h.reported;
  const logged = fs.readFileSync(logFile, 'utf8');
  assert.ok(logged.includes(durable) && logged.includes(r.aside), 'both paths in the log');
  // The aside folder on the bucket is not itself linked into agy's HOME.
  prepareAgyHome();
  assert.equal(fs.existsSync(path.join(AGY_HOME, '.agy-home-replaced')), false);
});

test('identical content is just linked again: no copies, nothing overwritten', () => {
  put(path.join(bucketHome, '.same'), 'same\n');
  prepareAgyHome();
  const link = path.join(AGY_HOME, '.same');
  fs.unlinkSync(link); put(link, 'same\n');
  const h = layoutAgyHome({ reason: 'test' });
  const r = h.restored.find((x) => x.path === link);
  assert.match(r.action, /identical/);
  assert.deepEqual(r.bucketKept, []);
  assert.ok(isLinkTo(link, path.join(bucketHome, '.same')));
});

// ---------- the wrapper: loops and an unset AGY_HOME ----------
const wrapper = path.resolve(here, '../../scripts/agy-wrapper.sh');
test('a real agy that became a link to the wrapper does not loop', () => {
  const d = path.join(root, 'loop');
  fs.mkdirSync(path.join(d, 'wrap'), { recursive: true }); fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
  fs.symlinkSync(wrapper, path.join(d, 'wrap/agy'));
  fs.symlinkSync(path.join(d, 'wrap/agy'), path.join(d, 'bin/agy')); // the "real" one: the wrapper again
  const env = { PATH: `${d}/wrap:${d}/bin:${d}/wrap:/usr/bin:/bin`, HOME: bucketHome, AGY_HOME };
  const r = spawnSync('sh', ['-c', 'agy --version'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.error, undefined, 'finished, did not hang');
  assert.equal(r.status, 127);
  assert.match(r.stderr, /no Antigravity CLI on PATH besides the manager's wrapper/);
});

test('with AGY_HOME unset the wrapper uses $AM_LOCAL/agy-home, and never the bucket HOME silently', () => {
  const PATHV = `${path.join(local, 'agy-wrap')}:${path.join(local, 'bin')}:/usr/bin:/bin`;
  prepareAgyHome();
  // AM_LOCAL known: its agy-home (the one the server laid out).
  assert.match(execFileSync('sh', ['-c', 'agy x'], { env: { PATH: PATHV, HOME: bucketHome, AM_LOCAL: local }, encoding: 'utf8' }), new RegExp(`HOME=${local}/agy-home ARGS=x`));
  // Neither, with HOME on the bucket: refused.
  const r = spawnSync('sh', ['-c', 'agy x'], { env: { PATH: PATHV, HOME: bucketHome, DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is on the bucket.*Not starting|Not starting/s);
  // Neither, outside a Space (HOME not on the data dir): agy as installed.
  const other = path.join(root, 'plain-home');
  fs.mkdirSync(other, { recursive: true });
  assert.match(execFileSync('sh', ['-c', 'agy x'], { env: { PATH: PATHV, HOME: other, DATA_DIR: data }, encoding: 'utf8' }), new RegExp(`HOME=${other} ARGS=x`));
});
