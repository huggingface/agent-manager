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

assert.equal(runner.installClaudeRepinHook(), true);
const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
assert.equal(settings.hooks.SessionStart[0].hooks[0].command, path.join(scripts, 'am-repin-hook.sh'));
assert.equal(settings.hooks.Notification[0].hooks[0].command, path.join(scripts, 'am-input-required-hook.sh'));

assert.equal(runner.installOpencodeRepinPlugin(), true);
const installedPlugin = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'am-agent-manager.js');
assert.equal(fs.readFileSync(installedPlugin, 'utf8'), fs.readFileSync(path.join(scripts, 'am-opencode-repin.js'), 'utf8'));

const installer = path.join(scripts, 'install-local-clis.sh');
assert.notEqual(fs.statSync(installer).mode & 0o111, 0, 'CLI installer is executable');
assert.equal(spawnSync('sh', ['-n', installer]).status, 0, 'CLI installer parses as POSIX shell');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('local-install: ok');
