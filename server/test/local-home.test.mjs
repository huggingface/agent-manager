// Live HOME on local POSIX storage ($AM_LOCAL/home) with durable backing at
// $AM_DURABLE_HOME ($DATA_DIR/home).
//
// Verifies:
//   1. Full entrypoint.sh boot places HOME at $AM_LOCAL/home (off $DATA_DIR),
//      creates all 5 harness symlinks on local POSIX disk, and removes/avoids
//      any symlinks on $DATA_DIR/home.
//   2. Legacy real directories left on $DATA_DIR/home (including an Antigravity
//      conversation database whose rows exist only in its WAL, plus a pre-existing
//      .pre-agent-state rollback directory) migrate into $DATA_DIR/state/*,
//      keep rollback copies on $DATA_DIR/home, and restore into local trees
//      reachable through local $HOME.
//   3. User dotfiles and skills in $DATA_DIR/home restore into local $HOME at
//      boot, edits in local $HOME checkpoint back to $DATA_DIR/home, hot
//      restarts preserve newer local dotfiles, bucket-API sync covers `home`,
//      and harness symlinks, rollback/bucket folders, locks, WAL/SHM sidecars
//      and ephemeral caches never cross to $DATA_DIR/home.
//   4. Managed-skills manifest records pointing at $DATA_DIR/home/.agents/skills
//      are repointed to local $HOME/.agents/skills after restore.
//   5. NON_SECRET in server/src/index.js covers every entrypoint.sh export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillsService, generatedSkill, skillTargetDirs } from '../src/skills.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const entrypoint = path.join(repoRoot, 'entrypoint.sh');
const stateScript = path.join(repoRoot, 'scripts/agent-state.sh');
const fakeHfPath = path.resolve(here, '../fixtures/fake-hf.py');

// Allowlist only: never inherit live Space env vars.
const baseEnv = () => Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ']
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);

const put = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const sql = (db, q) => execFileSync('sqlite3', [db, q], { encoding: 'utf8' }).trim();
const sqlMain = (db, q) => sql(`file:${db}?immutable=1`, q);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a WAL-mode SQLite database whose committed rows live only in its -wal.
async function crashedWalDb(db, rows) {
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const w = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  w.stdout.on('data', (c) => { out += c; });
  w.stdin.write(
    'PRAGMA journal_mode=WAL;\n'
    + 'CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY, body TEXT);\n'
    + 'PRAGMA wal_checkpoint(TRUNCATE);\n'
    + 'PRAGMA wal_autocheckpoint=0;\n',
  );
  for (const r of rows) w.stdin.write(`INSERT INTO steps(body) VALUES ('${r}');\n`);
  w.stdin.write('.print wal-ready\n');
  for (const end = Date.now() + 5000; !out.includes('wal-ready') && Date.now() < end;) {
    await pause(20);
  }
  w.kill('SIGKILL');
  await new Promise((r) => w.once('exit', r));
}

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-local-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'durable');
  const local = path.join(root, 'local');
  const bootHome = path.join(root, 'image-home');
  const tmpDir = path.join(root, 'tmp');
  const stubBin = path.join(root, 'stub-bin');
  fs.mkdirSync(bootHome, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(stubBin, { recursive: true });

  // Intercept `node /app/server/src/index.js` so full entrypoint.sh runs top-to-bottom
  // (migrations -> restore -> skills manifest migration -> install.sh -> app -> checkpoint-final)
  // without starting the real HTTP server or touching /app.
  const serverHook = path.join(root, 'server-hook.sh');
  put(serverHook, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(serverHook, 0o755);
  const nodeShim = path.join(stubBin, 'node');
  put(nodeShim, [
    '#!/bin/sh',
    'if [ "${1:-}" = "/app/server/src/index.js" ]; then',
    `  exec sh "${serverHook}"`,
    'fi',
    `exec "${process.execPath}" "$@"`,
  ].join('\n') + '\n');
  fs.chmodSync(nodeShim, 0o755);

  const inherited = baseEnv();
  const env = {
    ...inherited,
    PATH: `${stubBin}:${inherited.PATH}`,
    HOME: bootHome,
    TMPDIR: tmpDir,
    DATA_DIR: data,
    AM_LOCAL: local,
    AGENT_STATE_SCRIPT: stateScript,
    AGENT_STATE_BUDGET: '120',
    AGENT_STATE_CHECKPOINT_SECONDS: '1',
  };
  return { root, data, local, bootHome, tmpDir, stubBin, serverHook, env };
}

test('entrypoint.sh syntax and NON_SECRET export coverage', () => {
  execFileSync('sh', ['-n', entrypoint]);
  execFileSync('sh', ['-n', stateScript]);

  const ep = fs.readFileSync(entrypoint, 'utf8');
  const idx = fs.readFileSync(path.join(repoRoot, 'server/src/index.js'), 'utf8');
  const blockStart = idx.indexOf('const NON_SECRET = new Set([');
  const blockEnd = idx.indexOf(']);', blockStart);
  const catalog = new Set([...idx.slice(blockStart, blockEnd).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
  const prefixes = [...idx.slice(idx.indexOf('const NON_SECRET_PREFIX = ['), idx.indexOf('];', idx.indexOf('const NON_SECRET_PREFIX = [')))
    .matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

  assert.ok(catalog.has('AM_DURABLE_HOME'), 'AM_DURABLE_HOME listed in NON_SECRET');
  assert.ok(catalog.has('AM_LIVE_HOME'), 'AM_LIVE_HOME listed in NON_SECRET');

  const exported = [...ep.matchAll(/^\s*export ([A-Z_]+)/gm)]
    .map((m) => m[1])
    .filter((k) => k !== 'PATH');
  const uncovered = exported.filter((k) => !catalog.has(k) && !prefixes.some((p) => k.startsWith(p)));
  assert.deepEqual(uncovered, [], `uncovered entrypoint exports: ${uncovered.join(', ')}`);
});

test('full entrypoint boot moves HOME to local disk, migrates legacy bucket dirs + WAL DBs, and round-trips dotfiles', async (t) => {
  const sb = makeSandbox(t);
  const durableHome = path.join(sb.data, 'home');
  const liveHome = path.join(sb.local, 'home');

  // 1. Seed ordinary user dotfiles & skills in $DATA_DIR/home.
  put(path.join(durableHome, '.gitconfig'), '[user]\n\tname = Ada\n');
  put(path.join(durableHome, '.bashrc'), 'alias ll="ls -la"\n');
  put(path.join(durableHome, '.profile'), 'export EDITOR=vim\n');
  put(path.join(durableHome, '.agents/skills/my-skill/SKILL.md'), '---\nname: my-skill\ndescription: "demo"\n---\n\n# Demo\n');
  put(path.join(durableHome, '.config/gh/hosts.yml'), 'github.com:\n    oauth_token: gho_test\n');
  put(path.join(durableHome, '.ssh/known_hosts'), 'github.com ssh-ed25519 AAAA\n');
  put(path.join(durableHome, '.local/share/custom-tool/prefs.json'), '{"ok":true}\n');

  // 2. Seed excluded junk/caches/rollback/bucket-backup paths on $DATA_DIR/home:
  //    none of these may be copied into live $HOME.
  put(path.join(durableHome, '.cache/pip/wheel.whl'), 'cached');
  put(path.join(durableHome, '.npm/_cacache/index'), 'cached');
  put(path.join(durableHome, '.local/share/uv/python/bin'), 'cached');
  put(path.join(durableHome, '.gemini/config.bucket-20261124-1749/old.json'), '{"old":true}\n');
  put(path.join(durableHome, 'stale.lock'), '1234\n');
  put(path.join(durableHome, 'orphan.db-wal'), 'walbytes');
  put(path.join(durableHome, 'orphan.db-shm'), 'shmbytes');
  // A pre-existing .pre-agent-state rollback directory (as on a Space where hf-mount
  // later dropped the symlink and agy created a new real folder on the bucket).
  put(path.join(durableHome, '.gemini/antigravity-cli.pre-agent-state/marker.txt'), 'first-migration\n');
  // A stale symlink left on $DATA_DIR/home by an older version.
  fs.mkdirSync(durableHome, { recursive: true });
  fs.symlinkSync('/nonexistent/old-fx', path.join(durableHome, '.fx'));

  // 3. Seed legacy real harness directories on $DATA_DIR/home, including an
  //    Antigravity conversation DB whose rows exist ONLY in its WAL.
  const convId = '11111111-2222-4333-8444-555555555555';
  const legacyAgyDb = path.join(durableHome, `.gemini/antigravity-cli/conversations/${convId}.db`);
  await crashedWalDb(legacyAgyDb, ['turn-one-in-wal', 'turn-two-in-wal']);
  assert.equal(sqlMain(legacyAgyDb, 'SELECT count(*) FROM steps;'), '0', 'fixture rows live only in WAL');
  put(path.join(durableHome, '.gemini/antigravity-cli/settings.json'), '{"trustedWorkspaces":["/data/workspaces/a"]}\n');
  for (const rel of ['presence/lock.lock', 'log/cli.log', 'crashes/1.dmp', 'updater/u.lock', 'bin/webm_encoder']) {
    put(path.join(durableHome, '.gemini/antigravity-cli', rel), 'ephemeral');
  }
  put(path.join(durableHome, '.gemini/config/projects/proj.json'), '{"id":"proj"}\n');
  put(path.join(durableHome, '.gemini/settings.json'), '{"geminiCli":true}\n');
  put(path.join(durableHome, '.openclaw/openclaw.json'), '{"claw":1}\n');
  put(path.join(durableHome, '.hermes/config.yaml'), 'provider: anthropic\n');
  put(path.join(durableHome, '.local/share/opencode/setup.json'), '{"opencode":1}\n');

  // 4. Seed a managed-skills ownership manifest recorded when HOME was /data/home.
  const skillBody = '# Shared Rule\nKeep commits small.\n';
  const renderedSkill = generatedSkill('shared-rule.md', skillBody);
  const sourceSkills = path.join(sb.data, 'workspaces/skills');
  const stateSkills = path.join(sb.data, 'state/skills');
  put(path.join(sourceSkills, 'shared-rule.md'), skillBody);
  // Seed initial managed skill against legacy durableHome as HOME.
  const legacyEnv = {
    HOME: durableHome,
    CLAUDE_CONFIG_DIR: path.join(sb.local, 'agent-state/claude'),
    GEMINI_CLI_HOME: path.join(sb.local, 'agent-state/gemini-home'),
    OPENCLAW_HOME: path.join(sb.local, 'oc-home'),
    AM_DISTRIBUTE_SKILLS: '1',
  };
  fs.mkdirSync(path.join(sb.local, 'hermes'), { recursive: true });
  fs.symlinkSync(path.join(sb.local, 'hermes'), path.join(durableHome, '.hermes-tmp'));
  // Use createSkillsService with legacy durableHome/.agents/skills target to write skills-v1.json.
  fs.rmSync(path.join(durableHome, '.hermes-tmp'));
  {
    const legacyTargets = [
      path.join(durableHome, '.agents/skills'),
      path.join(sb.local, 'agent-state/claude/skills'),
      path.join(sb.local, 'hermes/skills'),
      path.join(sb.local, 'agent-state/gemini-home/.agents/skills'),
      path.join(sb.local, 'oc-home/.agents/skills'),
    ];
    fs.unlinkSync(path.join(sourceSkills, 'shared-rule.md'));
    const preUpgradeSkills = createSkillsService({
      sourceRoot: sourceSkills,
      stateRoot: stateSkills,
      targetRoots: legacyTargets,
      generated: ['environment.md'],
    });
    assert.equal((await preUpgradeSkills.create('shared-rule.md', skillBody)).ok, true);
    assert.equal((await preUpgradeSkills.generate('environment.md', '# Old Env\n')).ok, true);
    // Wipe local targets to simulate a fresh container replacement (only $DATA_DIR survives).
    fs.rmSync(sb.local, { recursive: true, force: true });
    // Restore durable copies that checkpointing had saved before container replacement.
    put(path.join(sb.data, 'state/claude/skills/shared-rule/SKILL.md'), renderedSkill);
    put(path.join(sb.data, 'state/claude/skills/environment/SKILL.md'), generatedSkill('environment.md', '# Old Env\n'));
    put(path.join(sb.data, 'state/hermes/skills/shared-rule/SKILL.md'), renderedSkill);
    put(path.join(sb.data, 'state/hermes/skills/environment/SKILL.md'), generatedSkill('environment.md', '# Old Env\n'));
    // Gemini CLI & OpenClaw skills sit above .gemini/.openclaw or get recreated if dir missing?
    // Keep only durableHome/.agents/skills in manifest to specifically test HOME target migration.
    const mPath = path.join(stateSkills, 'skills-v1.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    for (const r of Object.values(m.skills)) {
      r.targets = r.targets.filter((tgt) => [
        fs.realpathSync(path.join(durableHome, '.agents/skills')),
        path.join(sb.local, 'agent-state/claude/skills'),
        path.join(sb.local, 'hermes/skills'),
      ].includes(tgt.root));
    }
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
  }

  // 5. While "server" runs inside entrypoint.sh, record its env, verify restored
  //    dotfiles + migrated WAL DB via $HOME, mutate dotfiles, and create local
  //    caches/locks/symlinks that must NEVER reach $DATA_DIR/home on shutdown.
  const observedEnvFile = path.join(sb.root, 'observed-env.json');
  put(sb.serverHook, [
    '#!/bin/sh',
    'set -eu',
    `"${process.execPath}" -e '`,
    '  const fs = require("fs");',
    '  const keys = ["HOME", "AM_DURABLE_HOME", "AM_LIVE_HOME", "DATA_DIR", "AM_LOCAL", "ANTIGRAVITY_LIVE", "HERMES_LIVE", "FX_LIVE", "OPENCODE_LIVE"];',
    `  fs.writeFileSync(${JSON.stringify(observedEnvFile)}, JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k] || null]))));`,
    "'",
    // Edit an existing dotfile and add a new user dotfile + skill in live $HOME.
    'printf "\\n[core]\\n\\teditor = nvim\\n" >> "$HOME/.gitconfig"',
    'mkdir -p "$HOME/.config/fish" "$HOME/.cache/huggingface" "$HOME/.npm/_logs" "$HOME/.local/share/uv/wheels"',
    'printf "set -g fish_greeting\\n" > "$HOME/.config/fish/config.fish"',
    'printf "cached-hf" > "$HOME/.cache/huggingface/blob"',
    'printf "cached-npm" > "$HOME/.npm/_logs/debug.log"',
    'printf "cached-uv" > "$HOME/.local/share/uv/wheels/pkg.whl"',
    'printf "pid" > "$HOME/runtime.lock"',
    'printf "wal" > "$HOME/scratch.db-wal"',
    'ln -s /tmp "$HOME/user-local-symlink"',
  ].join('\n') + '\n');
  fs.chmodSync(sb.serverHook, 0o755);

  const bootRun = spawnSync('sh', [entrypoint], { env: sb.env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(bootRun.status, 0, `entrypoint failed:\nSTDOUT:\n${bootRun.stdout}\nSTDERR:\n${bootRun.stderr}`);

  const observed = JSON.parse(fs.readFileSync(observedEnvFile, 'utf8'));
  assert.equal(observed.HOME, liveHome, 'live HOME is $AM_LOCAL/home');
  assert.equal(observed.AM_LIVE_HOME, liveHome);
  assert.equal(observed.AM_DURABLE_HOME, durableHome, 'durable HOME is $DATA_DIR/home');
  assert.ok(!observed.HOME.startsWith(sb.data), 'live HOME is off $DATA_DIR');

  // All 5 harness links inside live $HOME are symlinks pointing to local POSIX dirs.
  const expectedLinks = [
    ['.local/share/opencode', path.join(sb.local, 'opencode-share')],
    ['.hermes', path.join(sb.local, 'hermes')],
    ['.fx', path.join(sb.local, 'fx-home')],
    ['.gemini/antigravity-cli', path.join(sb.local, 'antigravity-home/antigravity-cli')],
    ['.gemini/config', path.join(sb.local, 'antigravity-home/config')],
  ];
  for (const [rel, target] of expectedLinks) {
    const lnk = path.join(liveHome, rel);
    assert.ok(fs.lstatSync(lnk).isSymbolicLink(), `${rel} in live HOME is a symlink`);
    assert.equal(fs.readlinkSync(lnk), target, `${rel} points to ${target}`);
    assert.ok(fs.realpathSync(lnk).startsWith(sb.local + path.sep), `${rel} resolves under $AM_LOCAL`);
  }

  // Zero symlinks exist anywhere under $DATA_DIR/home (stale .fx symlink was cleaned,
  // and neither harness symlinks nor user-local-symlink were checkpointed back).
  const durableLinks = execFileSync('find', [durableHome, '-type', 'l'], { encoding: 'utf8' }).trim();
  assert.equal(durableLinks, '', `expected zero symlinks in $DATA_DIR/home, found: ${durableLinks}`);

  // Legacy Antigravity WAL database migrated through SQLite .backup (WAL rows intact!)
  // and restored into $ANTIGRAVITY_LIVE, accessible through local $HOME/.gemini/antigravity-cli.
  const durableMigratedDb = path.join(sb.data, `state/antigravity/antigravity-cli/conversations/${convId}.db`);
  assert.ok(fs.existsSync(durableMigratedDb), 'migrated DB exists in $ANTIGRAVITY_DURABLE');
  assert.ok(!fs.existsSync(`${durableMigratedDb}-wal`) && !fs.existsSync(`${durableMigratedDb}-shm`), 'no WAL/SHM in durable store');
  assert.equal(sqlMain(durableMigratedDb, 'PRAGMA quick_check;'), 'ok');
  assert.equal(sqlMain(durableMigratedDb, 'SELECT count(*) FROM steps;'), '2');

  const liveRestoredDb = path.join(liveHome, `.gemini/antigravity-cli/conversations/${convId}.db`);
  assert.equal(sql(liveRestoredDb, 'SELECT group_concat(body, ",") FROM steps ORDER BY idx;'), 'turn-one-in-wal,turn-two-in-wal');
  assert.ok(read(path.join(liveHome, '.gemini/antigravity-cli/settings.json')).includes('trustedWorkspaces'));
  assert.equal(read(path.join(liveHome, '.gemini/config/projects/proj.json')), '{"id":"proj"}\n');

  // Ephemeral Antigravity files stayed out of $ANTIGRAVITY_DURABLE.
  for (const rel of ['presence/lock.lock', 'log/cli.log', 'crashes/1.dmp', 'updater/u.lock', 'bin/webm_encoder']) {
    assert.ok(!fs.existsSync(path.join(sb.data, 'state/antigravity/antigravity-cli', rel)), `${rel} excluded`);
  }

  // Rollback copies were retained on $DATA_DIR/home (timestamped when .pre-agent-state already existed).
  assert.equal(read(path.join(durableHome, '.gemini/antigravity-cli.pre-agent-state/marker.txt')), 'first-migration\n');
  const geminiEntries = fs.readdirSync(path.join(durableHome, '.gemini'));
  const secondRollback = geminiEntries.find((n) => n.startsWith('antigravity-cli.pre-agent-state.'));
  assert.ok(secondRollback, `timestamped rollback copy retained in ${geminiEntries.join(', ')}`);
  assert.ok(fs.existsSync(path.join(durableHome, '.gemini', secondRollback, `conversations/${convId}.db-wal`)));
  assert.ok(fs.existsSync(path.join(durableHome, '.gemini/config.pre-agent-state/projects/proj.json')));
  assert.ok(fs.existsSync(path.join(durableHome, '.hermes.pre-agent-state/config.yaml')));
  assert.ok(fs.existsSync(path.join(durableHome, '.local/share/opencode.pre-agent-state/setup.json')));

  // Other legacy harnesses migrated and restored cleanly.
  assert.equal(read(path.join(sb.data, 'state/gemini/settings.json')), '{"geminiCli":true}\n');
  assert.equal(read(path.join(sb.data, 'state/openclaw-backup/openclaw.json')), '{"claw":1}\n');
  assert.equal(read(path.join(liveHome, '.hermes/config.yaml')), 'provider: anthropic\n');
  assert.equal(read(path.join(liveHome, '.local/share/opencode/setup.json')), '{"opencode":1}\n');

  // Ordinary dotfiles & skills restored into live $HOME (and OpenClaw got .gitconfig).
  assert.equal(read(path.join(liveHome, '.bashrc')), 'alias ll="ls -la"\n');
  assert.equal(read(path.join(liveHome, '.profile')), 'export EDITOR=vim\n');
  assert.equal(read(path.join(liveHome, '.config/gh/hosts.yml')), 'github.com:\n    oauth_token: gho_test\n');
  assert.equal(read(path.join(liveHome, '.ssh/known_hosts')), 'github.com ssh-ed25519 AAAA\n');
  assert.equal(read(path.join(liveHome, '.local/share/custom-tool/prefs.json')), '{"ok":true}\n');
  assert.ok(read(path.join(liveHome, '.agents/skills/my-skill/SKILL.md')).includes('# Demo'));
  assert.ok(read(path.join(sb.local, 'oc-home/.gitconfig')).includes('name = Ada'));

  // Excluded junk from $DATA_DIR/home was NOT restored into live $HOME.
  assert.ok(!fs.existsSync(path.join(liveHome, '.cache/pip/wheel.whl')));
  assert.ok(!fs.existsSync(path.join(liveHome, '.npm/_cacache/index')));
  assert.ok(!fs.existsSync(path.join(liveHome, '.local/share/uv/python/bin')));
  assert.ok(!fs.existsSync(path.join(liveHome, '.gemini/config.bucket-20261124-1749')));
  assert.ok(!fs.existsSync(path.join(liveHome, '.gemini/settings.json')), 'legacy Gemini CLI root file excluded from home adapter');
  assert.ok(!fs.existsSync(path.join(liveHome, '.openclaw')), 'OpenClaw dir excluded from home adapter');
  assert.ok(!fs.existsSync(path.join(liveHome, 'stale.lock')));
  assert.ok(!fs.existsSync(path.join(liveHome, 'orphan.db-wal')));
  assert.ok(!fs.existsSync(path.join(liveHome, 'orphan.db-shm')));
  assert.ok(!fs.readdirSync(liveHome).some((n) => n.includes('.pre-agent-state')));

  // Edits & new dotfiles in live $HOME checkpointed back to $DATA_DIR/home on shutdown!
  assert.match(read(path.join(durableHome, '.gitconfig')), /editor = nvim/);
  assert.equal(read(path.join(durableHome, '.config/fish/config.fish')), 'set -g fish_greeting\n');

  // Local caches, locks, WALs and symlinks created in live $HOME were NEVER copied to $DATA_DIR/home.
  assert.ok(!fs.existsSync(path.join(durableHome, '.cache/huggingface/blob')));
  assert.ok(!fs.existsSync(path.join(durableHome, '.npm/_logs/debug.log')));
  assert.ok(!fs.existsSync(path.join(durableHome, '.local/share/uv/wheels/pkg.whl')));
  assert.ok(!fs.existsSync(path.join(durableHome, 'runtime.lock')));
  assert.ok(!fs.existsSync(path.join(durableHome, 'scratch.db-wal')));
  assert.ok(!fs.existsSync(path.join(durableHome, 'user-local-symlink')));
  // And none of the 5 harness paths exist as live copies on $DATA_DIR/home.
  for (const rel of ['.local/share/opencode', '.hermes', '.fx', '.gemini/antigravity-cli', '.gemini/config']) {
    assert.ok(!fs.existsSync(path.join(durableHome, rel)), `${rel} not recreated on $DATA_DIR/home`);
  }

  // Managed-skills ownership manifest was repointed to live $HOME/.agents/skills,
  // so createSkillsService redistributes and regenerates environment.md cleanly!
  const postUpgradeTargets = skillTargetDirs({
    HOME: liveHome,
    CLAUDE_CONFIG_DIR: path.join(sb.local, 'agent-state/claude'),
    GEMINI_CLI_HOME: path.join(sb.local, 'agent-state/gemini-home'),
    OPENCLAW_HOME: path.join(sb.local, 'oc-home'),
    AM_DISTRIBUTE_SKILLS: '1',
  });
  const postUpgradeSkills = createSkillsService({
    sourceRoot: sourceSkills,
    stateRoot: stateSkills,
    targetRoots: postUpgradeTargets,
    generated: ['environment.md'],
  });
  const redist = await postUpgradeSkills.redistribute();
  assert.equal(redist.ok, true, `skills redistribute after HOME migration failed: ${JSON.stringify(redist)}`);
  const regen = await postUpgradeSkills.generate('environment.md', '# Updated Local Home Env\n');
  assert.equal(regen.ok, true, `environment.md regenerate failed: ${JSON.stringify(regen)}`);
  assert.match(read(path.join(liveHome, '.agents/skills/environment/SKILL.md')), /Updated Local Home Env/);
});

test('home adapter preserves newer local dotfiles on hot restart, re-ensures broken links, and syncs via bucket API', (t) => {
  const sb = makeSandbox(t);
  const durableHome = path.join(sb.data, 'home');
  const liveHome = path.join(sb.local, 'home');
  const binDir = path.join(sb.root, 'hf-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(fakeHfPath, path.join(binDir, 'hf'));
  fs.chmodSync(path.join(binDir, 'hf'), 0o755);
  const hfLog = path.join(sb.root, 'hf.log');

  put(path.join(durableHome, '.gitconfig'), '[user]\n\tname = OldBucket\n');
  put(path.join(durableHome, '.vimrc'), 'set number\n');
  put(path.join(durableHome, '.cache/ignored/file'), 'ignore-me');
  put(path.join(durableHome, '.gemini/antigravity-cli.bucket-20261124/x.db'), 'ignore-bucket-backup');

  put(path.join(liveHome, '.gitconfig'), '[user]\n\tname = NewerLocal\n');
  const nowSec = Date.now() / 1000;
  fs.utimesSync(path.join(durableHome, '.gitconfig'), nowSec - 120, nowSec - 120);
  fs.utimesSync(path.join(liveHome, '.gitconfig'), nowSec, nowSec);

  // Simulate a missing link and an unexpected real directory at a harness link path in live $HOME.
  put(path.join(liveHome, '.fx/unexpected.txt'), 'unexpected');

  const stateEnv = {
    ...sb.env,
    PATH: `${binDir}:${sb.env.PATH}`,
    HOME: liveHome,
    AM_LIVE_HOME: liveHome,
    AM_DURABLE_HOME: durableHome,
    AGENT_STATE_BUCKET: 'test/bucket',
    FAKE_BUCKET_ROOT: sb.data,
    FAKE_HF_LOG: hfLog,
  };

  const r = spawnSync('sh', [stateScript, 'restore'], { env: stateEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  // Bucket API synced all 9 adapters (8 harnesses + home), excluding caches & .bucket-* at download time.
  const log = fs.readFileSync(hfLog, 'utf8');
  assert.equal((log.match(/ --plan /g) || []).length, 9, log);
  assert.match(log, /hf buckets sync hf:\/\/buckets\/test\/bucket\/home /);
  assert.doesNotMatch(log, /download \.cache\//);
  assert.doesNotMatch(log, /download .*\.bucket-/);

  // Hot restart kept newer local .gitconfig while bringing in .vimrc from durable home.
  assert.equal(read(path.join(liveHome, '.gitconfig')), '[user]\n\tname = NewerLocal\n');
  assert.equal(read(path.join(liveHome, '.vimrc')), 'set number\n');

  // restore_home re-ensured all 5 local harness symlinks and moved the unexpected real .fx dir aside.
  assert.ok(fs.lstatSync(path.join(liveHome, '.fx')).isSymbolicLink());
  assert.ok(fs.readdirSync(liveHome).some((n) => n.startsWith('.fx.pre-home-link.')));

  // First checkpoint after hot restart publishes the newer local .gitconfig to durable home.
  const c = spawnSync('sh', [stateScript, 'checkpoint'], { env: stateEnv, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.equal(read(path.join(durableHome, '.gitconfig')), '[user]\n\tname = NewerLocal\n');
});
