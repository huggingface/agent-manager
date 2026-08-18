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

// A CLI's presence on PATH doesn't change while the process runs, but
// cliCatalog() (called on every /api/clis) probed every CLI each time — ~16
// synchronous `command -v` subprocess spawns per request, blocking the event
// loop that also pumps the terminals. Memoize per command.
const cmdExistsCache = new Map();
function commandExists(cmd) {
  if (cmdExistsCache.has(cmd)) return cmdExistsCache.get(cmd);
  let ok = false;
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: '/bin/sh' });
    ok = true;
  } catch { ok = false; }
  cmdExistsCache.set(cmd, ok);
  return ok;
}

// Installed CLI versions, resolved asynchronously (a few `--version` calls) and
// cached so /api/clis stays fast. Slow starters (hermes = python venv, gemini)
// can miss the boot-time pass — cliCatalog re-runs it for the gaps, throttled.
const versionCache = new Map();
let versionsAttemptedAt = 0;
export function refreshVersions() {
  versionsAttemptedAt = Date.now();
  for (const c of CLIS) {
    if (!c.bin || versionCache.has(c.id) || !commandExists(c.bin)) continue;
    execFile(c.bin, ['--version'], { timeout: 30000 }, (err, stdout = '') => {
      if (err) return;
      const s = String(stdout);
      const m = s.match(/\d+\.\d+\.\d+[\w.-]*/);
      versionCache.set(c.id, m ? m[0] : s.trim().split('\n')[0].slice(0, 40));
    });
  }
}

// tmux is no longer part of the terminal path: sessions are PTYs held by this
// process with a libghostty-vt grid as the authoritative screen (see runner.js).

/**
 * CLI catalog.
 *  - `bin`  : binary checked on PATH to report availability
 *  - `run`  : command run inside the session shell on first launch
 *  - `cont` : command used to resume a prior conversation (null = no resume)
 *  - `resizeMode: 'repaint'`: primary-screen TUI redraws its frame on SIGWINCH
 */
// One setup story for every agent; only the accepted secret names differ.
const setupHint = (...keys) =>
  `Launch it once — the first run walks you through sign-in. Or add ${keys.join(' / ')} as a Space secret.`;

// Panels rather than processes: no binary, nothing to launch, no trace of their
// own. Everywhere the app asks "is this an agent?" it means "not one of these".
export const PASSIVE_CLIS = ['files', 'trace'];

// A remote agent IS an agent (card, digest, status light) but has no process
// here: its compute lives on the operator's own machine and it polls us. So it
// is deliberately absent from PASSIVE_CLIS, and every "spawn / attach / type at
// it" path has to route around it — see isRemote() callers.
export const isRemote = (cli) => cli === 'remote';

// Codex's TUI emits OSC 9 only after it has installed one of these native
// interactive views. Pin the notification backend per invocation so Agent
// Manager can consume that control signal without changing the operator's
// durable Codex preferences or enabling ordinary turn-complete notifications.
const CODEX_INPUT_SIGNALS = '-c \'tui.notifications=["approval-requested","plan-mode-prompt"]\''
  + ' -c \'tui.notification_method="osc9"\''
  + ' -c \'tui.notification_condition="always"\'';
const codexCommand = (tail = '') => `codex ${CODEX_INPUT_SIGNALS}${tail ? ` ${tail}` : ''}`;

export const CLIS = [
  { id: 'shell',    label: 'Shell',       bin: 'bash',     color: '#8aa0ad', run: 'exec bash -il',  cont: null },
  { id: 'files',    label: 'Files',       bin: null,       color: '#d99a2b', run: null,             cont: null },
  // A received trace, rendered read-only. Like 'files' it is a passive panel
  // rather than a process, so it has no binary and never launches anything.
  { id: 'trace',    label: 'Trace',       bin: null,       color: '#7c8cf8', run: null,             cont: null },
  // An agent somewhere else — the operator's laptop, a GPU box. No binary and
  // nothing to launch HERE (that is the point), but unlike files/trace it holds
  // a conversation, so it gets a light and a digest like any other agent.
  { id: 'remote',   label: 'Remote agent', bin: null,      color: '#5ec2e0', run: null,             cont: null },
  { id: 'claude',   label: 'Claude Code', bin: 'claude',   color: '#d97757', run: 'claude',         cont: 'claude --continue', resizeMode: 'repaint',
    withPrompt: (q) => `claude ${q}`,
    setup: setupHint('ANTHROPIC_API_KEY') },
  { id: 'codex',    label: 'Codex',       bin: 'codex',    color: '#5eb6a6', run: codexCommand(),   cont: codexCommand('resume --last'), resizeMode: 'repaint',
    resume: (id) => codexCommand(`resume ${id}`),
    // `q` and image paths arrive shell-quoted from runner.commandFor(). Repeat
    // -i because Codex's variadic flag would otherwise consume the prompt.
    withPrompt: (q, images = []) => `${codexCommand()}${images.length ? ` ${images.map((image) => `-i ${image}`).join(' ')}` : ''} ${q}`,
    setup: setupHint('OPENAI_API_KEY') },
  { id: 'gemini',   label: 'Gemini CLI',  bin: 'gemini',   color: '#4796e3', run: 'gemini',         cont: null, resizeMode: 'repaint',
    withPrompt: (q) => `gemini -i ${q}`, // -i = interactive session seeded with the prompt
    setup: setupHint('GEMINI_API_KEY') },
  { id: 'opencode', label: 'opencode',    bin: 'opencode', color: '#8a93a0', run: 'opencode',       cont: 'opencode --continue', resizeMode: 'repaint',
    withPrompt: (q) => `opencode --prompt ${q}`,
    setup: setupHint('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY') },
  { id: 'hermes',   label: 'Hermes',      bin: 'hermes',   color: '#a78bfa', run: 'hermes',         cont: 'hermes -c', resizeMode: 'repaint',
    setup: setupHint('HF_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY') },
  // `chat` = TUI in --local mode: embedded agent, no gateway/daemon needed.
  { id: 'openclaw', label: 'OpenClaw',    bin: 'openclaw', color: '#c83636', run: 'openclaw chat',  cont: null, resizeMode: 'repaint',
    setup: setupHint('ANTHROPIC_API_KEY') },
  // Test-only primary-screen repaint fixture. Absent from every normal runtime.
  ...(process.env.AM_TEST_REPAINT_CMD
    ? [{ id: 'test-repaint', label: 'Repaint fixture', bin: 'bash', color: '#8aa0ad', run: process.env.AM_TEST_REPAINT_CMD, cont: null, resizeMode: 'repaint' }]
    : []),
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
        || fileOk(path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'oauth_creds.json'));
    case 'opencode': {
      const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
      return hasEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY')
        || fileOk(path.join(home, '.local', 'share', 'opencode', 'auth.json')) // pre-1.x
        || fileOk(path.join(xdgConfig, 'opencode', 'opencode.jsonc'))          // 1.x user config
        || fileOk(path.join(xdgConfig, 'opencode', 'opencode.json'));
    }
    case 'hermes':
      // HF_TOKEN: hermes has a huggingface provider (HF router models).
      return hasEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY', 'HF_TOKEN')
        || fileOk(path.join(home, '.hermes', '.env'))
        || fileOk(path.join(home, '.hermes', 'auth.json'));
    case 'openclaw':
      return hasEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY')
        || fileOk(path.join(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw'), 'openclaw.json'));
    default:
      // shell / files / trace need no auth, and a remote agent signs in on its
      // own machine — there is nothing to configure on this side.
      return true;
  }
}

/** CLI catalog enriched with runtime availability + configured (credential present). */
export function cliCatalog() {
  // Fill version gaps left by the boot-time pass (results land for the next poll).
  if (Date.now() - versionsAttemptedAt > 60_000
      && CLIS.some((c) => c.bin && !versionCache.has(c.id) && commandExists(c.bin))) {
    refreshVersions();
  }
  return CLIS.map((c) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    available: c.bin ? commandExists(c.bin) : true, // no binary (shell/files) = always available
    ready: (c.bin ? commandExists(c.bin) : true) && isConfigured(c.id),
    version: versionCache.get(c.id) || null,
    setup: c.setup || null,
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

export function workspacePath(folder) {
  return path.join(WORKSPACES_DIR, folder);
}
