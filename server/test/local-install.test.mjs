// Local Node/systemd deployments resolve app-owned lifecycle helpers from the
// checkout instead of relying on the Docker image's /app layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-local-install-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const runner = await import('../src/runner.js');
const config = await import('../src/config.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = path.join(root, 'scripts');

assert.equal(config.resolveBindHost({}), '127.0.0.1', 'local installs bind only to loopback by default');
assert.equal(config.resolveBindHost({ BIND_HOST: '0.0.0.0' }), '0.0.0.0', 'the bind address is configurable');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
assert.match(dockerfile, /\bBIND_HOST=0\.0\.0\.0\b/, 'the container remains reachable through its proxy');

// Where the app must call ITSELF. listen(PORT, BIND_HOST) binds one address
// unless it is a wildcard, so a configured bind host takes 127.0.0.1 away.
assert.equal(config.internalHostForUrl({}), '127.0.0.1');
assert.equal(config.internalHostForUrl({ BIND_HOST: '0.0.0.0' }), '127.0.0.1', 'a wildcard bind still answers on loopback');
assert.equal(config.internalHostForUrl({ BIND_HOST: '::' }), '127.0.0.1');
assert.equal(config.internalHostForUrl({ BIND_HOST: '127.0.0.2' }), '127.0.0.2', 'a specific interface is the only one bound');
assert.equal(config.internalHostForUrl({ BIND_HOST: '::1' }), '[::1]', 'an IPv6 literal is bracketed for a URL');

assert.equal(runner.installClaudeRepinHook(), true);
const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
assert.equal(settings.hooks.SessionStart[0].hooks[0].command, quote(path.join(scripts, 'am-repin-hook.sh')));
assert.equal(settings.hooks.Notification[0].hooks[0].command, quote(path.join(scripts, 'am-input-required-hook.sh')));

// Exercise the defaults from a real checkout path containing shell syntax.
const spacedRoot = path.join(tmp, "checkout with spaces and 'quotes'");
fs.cpSync(path.join(root, 'server', 'src'), path.join(spacedRoot, 'server', 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'server', 'package.json'), path.join(spacedRoot, 'server', 'package.json'));
fs.symlinkSync(path.join(root, 'server', 'node_modules'), path.join(spacedRoot, 'server', 'node_modules'));
fs.mkdirSync(path.join(spacedRoot, 'scripts'), { recursive: true });
for (const name of ['am-repin-hook.sh', 'am-input-required-hook.sh']) {
  fs.writeFileSync(path.join(spacedRoot, 'scripts', name), '#!/bin/sh\nprintf hook-ok\n', { mode: 0o755 });
}
const { pathToFileURL } = await import('node:url');
const spacedRunner = await import(pathToFileURL(path.join(spacedRoot, 'server', 'src', 'runner.js')));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'spaced-claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
assert.equal(spacedRunner.installClaudeRepinHook(), true);
const spacedSettings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')));
for (const event of Object.values(spacedSettings.hooks)) {
  const result = spawnSync('sh', ['-c', event[0].hooks[0].command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'hook-ok');
}

assert.equal(runner.installOpencodeRepinPlugin(), true);
const installedPlugin = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'am-agent-manager.js');
assert.equal(fs.readFileSync(installedPlugin, 'utf8'), fs.readFileSync(path.join(scripts, 'am-opencode-repin.js'), 'utf8'));

const installer = path.join(scripts, 'install-local-clis.sh');
assert.notEqual(fs.statSync(installer).mode & 0o111, 0, 'CLI installer is executable');
assert.equal(spawnSync('sh', ['-n', installer]).status, 0, 'CLI installer parses as POSIX shell');

// Required versus optional, the Dockerfile's own split. A fake npm stands in
// for the registry: the real openclaw package refuses to install on the Node
// version the others need, and making that fatal meant the recommended
// no-argument run could not finish on a supported runtime.
const fakeBin = path.join(tmp, 'fakebin');
fs.mkdirSync(fakeBin, { recursive: true });
const writeFakeNpm = (failing) => {
  fs.writeFileSync(path.join(fakeBin, 'npm'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    `  case "$a" in ${failing}*) echo "preinstall: unsupported Node" >&2; exit 1 ;; esac`,
    'done',
    // Stand up the binary the installer then looks for on PATH.
    'for a in "$@"; do',
    '  case "$a" in',
    '    @anthropic-ai/claude-code*) name=claude ;;',
    '    @openai/codex*) name=codex ;;',
    '    @google/gemini-cli*) name=gemini ;;',
    '    opencode-ai*) name=opencode ;;',
    '    openclaw*) name=openclaw ;;',
    '    *) continue ;;',
    '  esac',
    `  printf '#!/bin/sh\\nprintf %s\\n' "$name 1.0.0" > "${fakeBin}/$name"`,
    `  chmod 755 "${fakeBin}/$name"`,
    'done',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
};
const runInstaller = (args = []) => spawnSync('sh', [installer, ...args], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, NPM_CONFIG_PREFIX: path.join(tmp, 'prefix') },
});

writeFakeNpm('openclaw');
const optionalFails = runInstaller();
assert.equal(optionalFails.status, 0,
  `an optional CLI failing must not fail the recommended run:\n${optionalFails.stderr}`);
assert.match(optionalFails.stdout, /Not installed: openclaw/, 'and the run says which one it skipped');

writeFakeNpm('@anthropic-ai/claude-code');
const requiredFails = runInstaller();
assert.equal(requiredFails.status, 1, 'a CLI the manager needs still stops the run');
assert.match(requiredFails.stderr, /claude did not install/);

// ---- the other app-owned paths, from the same spaced checkout ----
const spacedShare = await import(pathToFileURL(path.join(spacedRoot, 'server', 'src', 'share.js')));
const exporter = spacedShare.__exporterPathForTest;
assert.ok(!exporter.includes('%'), `exporter path is percent-encoded: ${exporter}`);
assert.equal(exporter, path.join(spacedRoot, 'scripts', 'share-session.mjs'));
fs.writeFileSync(path.join(spacedRoot, 'scripts', 'share-session.mjs'), '');
assert.ok(fs.existsSync(exporter), 'the resolved exporter path is the one on disk');

const rcfile = path.join(spacedRoot, 'session.bashrc');
fs.writeFileSync(rcfile, '');
process.env.AM_BASHRC = rcfile;
const rcRunner = await import(`${pathToFileURL(path.join(spacedRoot, 'server', 'src', 'runner.js'))}?bashrc`);
const launched = spawnSync('sh', ['-c', `set -- ${rcRunner.__bashLaunchForTest.replace(/^exec bash /, '')}; printf '%s\\n' "$#"`], { encoding: 'utf8' });
assert.equal(launched.status, 0, launched.stderr);
assert.equal(launched.stdout.trim(), '3', 'the rcfile path stays one argument');

// ---- a real server on a NON-WILDCARD bind ----
//
// The string checks above say what BIND_HOST resolves to. They cannot say
// whether the app can still reach ITSELF: listen(PORT, BIND_HOST) binds one
// address, so with a specific interface configured the scheduler's own HTTP
// call and the generated agent instructions must not point at 127.0.0.1.
{
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => resolve(p)); });
  });
  const bind = '127.0.0.2';
  const dataDir = path.join(tmp, 'bind-data');
  // From the spaced checkout, so the statusline hook this boot writes is a real
  // one resolved through a path that needs quoting.
  const statuslineCfg = path.join(tmp, 'bind-claude');
  fs.writeFileSync(path.join(spacedRoot, 'server', 'claude-statusline.mjs'), 'process.stdout.write("statusline-ok");\n');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(spacedRoot, 'server'),
    env: {
      ...process.env, SPACE_ID: '', AM_DISTRIBUTE_SKILLS: '', PORT: String(port), BIND_HOST: bind,
      DATA_DIR: dataDir, PUBLIC_DIR: path.join(tmp, 'bind-public'),
      AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1', CLAUDE_CONFIG_DIR: statuslineCfg,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await fetch(`http://${bind}:${port}/api/health`).then((r) => r.ok).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, 'the configured interface answers');
    // Without this the assertions below would pass on a wildcard bind too.
    const loopback = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true).catch(() => false);
    assert.equal(loopback, false, '127.0.0.1 is genuinely not bound');

    // The instructions the app writes for its own agents must use an address
    // that answers. They used to say `localhost`, which this bind refuses.
    const skill = path.join(dataDir, 'workspaces', 'skills', 'environment.md');
    for (let i = 0; i < 40 && !fs.existsSync(skill); i++) await new Promise((r) => setTimeout(r, 250));
    const generated = fs.readFileSync(skill, 'utf8');
    assert.ok(!/localhost:/.test(generated), 'generated agent instructions no longer point at localhost');
    assert.ok(generated.includes(bind), 'they point at the address the server actually bound');

    // And the statusline this boot configured has to survive the shell: an
    // unquoted script path splits and the command silently never runs.
    const statusline = JSON.parse(fs.readFileSync(path.join(statuslineCfg, 'settings.json'), 'utf8')).statusLine;
    const ran = spawnSync('sh', ['-c', `${statusline.command} </dev/null`], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, 'statusline-ok');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('local-install: ok');
