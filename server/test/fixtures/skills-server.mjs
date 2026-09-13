import { nativeFetch as fetch } from '../native-client.mjs';
// Disposable real-server fixture. No inherited credentials, Space ID, harness
// homes, or PATH entries containing the operator's CLIs reach the child.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skillTargetDirs } from '../../src/skills.js';
const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function skillsServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-skills-api-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
    GEMINI_CLI_HOME: path.join(root, 'gemini'), OPENCLAW_HOME: path.join(root, 'openclaw'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: path.join(root, 'opencode'), AM_REPIN_DIR: path.join(root, 'repin'),
    AM_BASHRC: path.join(root, 'no-bashrc'), PUBLIC_DIR: path.join(root, 'public'),
    AM_SKILLS_TEST_FAULT: path.join(root, 'fault.json'),
  };
  const targetRoots = skillTargetDirs({ ...env, AM_DISTRIBUTE_SKILLS: '1' }).sort();
  if (targetRoots.length !== 5 || targetRoots.some((p) => !p.startsWith(root + '/'))) throw new Error('Unsafe skills test roots');
  // Opt in only after validating every destination.
  env.AM_DISTRIBUTE_SKILLS = '1';
  let child, log = '', url;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM'); await exit; child = null;
  }
  async function start({ distribute = true } = {}) {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise((r) => probe.close(r));
    url = `http://127.0.0.1:${port}`; log = '';
    child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./skills-faults.mjs', import.meta.url)), 'src/index.js'], {
      cwd: serverDir, env: { ...env, AM_DISTRIBUTE_SKILLS: distribute ? '1' : '', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (s) => { log += s; }); child.stderr.on('data', (s) => { log += s; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Fixture server exited: ${log}`);
      if (log.includes(`Agent Manager :${port}`) && await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false)) return;
      await delay(50);
    }
    throw new Error(`Fixture server timeout: ${log}`);
  }
  return { root, env, targetRoots, get url() { return url; }, get log() { return log; }, start, stop,
    source: (name) => path.join(env.DATA_DIR, 'workspaces', 'skills', name),
    target: (i, id) => path.join(targetRoots[i], id, 'SKILL.md'),
    fault: (value) => fs.writeFileSync(env.AM_SKILLS_TEST_FAULT, JSON.stringify(value)),
    async api(name = '', method = 'GET', content, revision) {
      const r = await fetch(`${url}/api/skills${name ? '/' + encodeURIComponent(name) : ''}`, { method,
        headers: { 'content-type': 'text/plain', 'x-am-origin': 'operator', ...(revision ? { 'If-Match': revision } : {}) }, body: content });
      return { status: r.status, body: await r.json() };
    },
    async cleanup() { await stop(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
