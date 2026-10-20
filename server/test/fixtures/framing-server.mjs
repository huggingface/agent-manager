// Real Agent Manager servers (src/index.js) on isolated state, for the framing
// suites. A preload answers the Space privacy check ("private") so a Space-mode
// server unlocks without the network, and can force a settings save to fail.
// The child gets an explicit environment: never the caller's live CLI state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));

export async function framingServers() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-framing-'));
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir);
  const preload = path.join(root, 'preload.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    globalThis.fetch = async () => new Response(JSON.stringify({ id: process.env.SPACE_ID, private: true, runtime: { volumes: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (/am-config\\.json/.test(String(file)) && fs.existsSync(process.env.DATA_DIR + '/reject-write')) throw new Error('fixture failure');
      return write(file, ...args);
    };
  `);
  const children = new Set();
  async function start(name, extraEnv = {}) {
    const dir = path.join(root, name);
    const home = path.join(dir, 'home'); fs.mkdirSync(home, { recursive: true });
    const free = net.createServer(); free.listen(0, '127.0.0.1'); await once(free, 'listening');
    const { port } = free.address(); await new Promise((r) => free.close(r));
    const base = `http://127.0.0.1:${port}`;
    const dataDir = path.join(dir, 'data');
    const child = spawn(process.execPath, ['--import', preload, 'src/index.js'], {
      cwd: SERVER,
      env: { PATH: process.env.PATH, HOME: home, DATA_DIR: dataDir, PORT: String(port), PUBLIC_DIR: publicDir,
        CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
        AM_REPIN_DIR: path.join(dir, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(dir, 'input-required'), AM_BASHRC: '/nonexistent',
        ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let logs = '';
    child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
    for (let i = 0; ; i++) {
      try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
      if (child.exitCode !== null) throw new Error(`server exited: ${logs}`);
      if (i > 200) { child.kill('SIGKILL'); throw new Error(`server did not start: ${logs}`); }
      await new Promise((r) => setTimeout(r, 100));
    }
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
      children.delete(child);
    };
    return { base, port, dataDir, workspaces: path.join(dataDir, 'workspaces'), logs: () => logs, stop };
  }
  const cleanup = async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, publicDir, start, cleanup };
}
