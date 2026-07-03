import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, execFile } from 'node:child_process';

export const PORT = parseInt(process.env.PORT || '7860', 10);
export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const STATE_DIR = path.join(DATA_DIR, 'state');
// Shared skills live in the workspace so agents can reach them (../skills).
export const SKILLS_DIR = path.join(WORKSPACES_DIR, 'skills');
export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
export const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve(process.cwd(), '..', 'web', 'dist');

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

// Installed CLI versions, resolved asynchronously (a few `--version` calls) and
// cached so /api/clis stays fast. Refreshed at startup; versions only change on
// a rebuild (new process → fresh cache).
const versionCache = new Map();
export function refreshVersions() {
  for (const c of CLIS) {
    if (!c.bin || !commandExists(c.bin)) continue;
    execFile(c.bin, ['--version'], { timeout: 8000 }, (err, stdout = '') => {
      if (err) return;
      const s = String(stdout);
      const m = s.match(/\d+\.\d+\.\d+[\w.-]*/);
      versionCache.set(c.id, m ? m[0] : s.trim().split('\n')[0].slice(0, 40));
    });
  }
}

export const TMUX_AVAILABLE = commandExists('tmux');
export const USE_TMUX = process.env.USE_TMUX
  ? process.env.USE_TMUX === '1'
  : TMUX_AVAILABLE;

/**
 * CLI catalog.
 *  - `bin`  : binary checked on PATH to report availability
 *  - `run`  : command run inside the session shell on first launch
 *  - `cont` : command used to resume a prior conversation (null = no resume)
 */
export const CLIS = [
  { id: 'shell',    label: 'Shell',       bin: 'bash',     color: '#8aa0ad', run: 'exec bash -il',  cont: null },
  { id: 'files',    label: 'Files',       bin: null,       color: '#d99a2b', run: null,             cont: null },
  { id: 'claude',   label: 'Claude Code', bin: 'claude',   color: '#d97757', run: 'claude',         cont: 'claude --continue' },
  { id: 'codex',    label: 'Codex',       bin: 'codex',    color: '#5eb6a6', run: 'codex',          cont: 'codex resume --last' },
  { id: 'gemini',   label: 'Gemini CLI',  bin: 'gemini',   color: '#4796e3', run: 'gemini',         cont: null },
  { id: 'opencode', label: 'opencode',    bin: 'opencode', color: '#8a93a0', run: 'opencode',       cont: null },
  { id: 'hermes',   label: 'Hermes',      bin: 'hermes',   color: '#a78bfa', run: 'hermes',         cont: 'hermes -c' },
  // `chat` = TUI in --local mode: embedded agent, no gateway/daemon needed.
  { id: 'openclaw', label: 'OpenClaw',    bin: 'openclaw', color: '#c83636', run: 'openclaw chat',  cont: null },
];

export function cliById(id) {
  return CLIS.find((c) => c.id === id) || null;
}

// Is an agent configured (has a credential)? Checks env keys OR an on-disk
// credential file. Detects "configured", not "token still valid".
function isConfigured(id) {
  const env = process.env;
  const home = env.HOME || os.homedir();
  const hasEnv = (...keys) => keys.some((k) => env[k] && env[k].trim());
  const fileOk = (p) => { try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; } };
  switch (id) {
    case 'claude':
      return hasEnv('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN')
        || fileOk(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json'));
    case 'codex':
      return hasEnv('OPENAI_API_KEY', 'CODEX_API_KEY')
        || fileOk(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'));
    case 'gemini':
      return hasEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY')
        || fileOk(path.join(home, '.gemini', 'oauth_creds.json'));
    case 'opencode':
      return hasEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY')
        || fileOk(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
    case 'hermes':
      return hasEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY')
        || fileOk(path.join(home, '.hermes', '.env'));
    case 'openclaw':
      return hasEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY')
        || fileOk(path.join(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw'), 'openclaw.json'));
    default:
      return true; // shell / files need no auth
  }
}

/** CLI catalog enriched with runtime availability + configured (credential present). */
export function cliCatalog() {
  return CLIS.map((c) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    available: c.bin ? commandExists(c.bin) : true, // no binary (shell/files) = always available
    ready: (c.bin ? commandExists(c.bin) : true) && isConfigured(c.id),
    version: versionCache.get(c.id) || null,
  }));
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, WORKSPACES_DIR, STATE_DIR, SKILLS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// A fresh workspace folder named after `base` (suffixed if taken). Used as the
// default location when an agent is created without an explicit path.
export function allocFolder(base) {
  const b = slugify(base) || 'workspace';
  let name = b;
  let n = 1;
  while (fs.existsSync(path.join(WORKSPACES_DIR, name))) { n++; name = `${b}-${n}`; }
  fs.mkdirSync(path.join(WORKSPACES_DIR, name), { recursive: true });
  return name;
}

export function workspacePath(folder) {
  return path.join(WORKSPACES_DIR, folder);
}
