import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, execFile } from 'node:child_process';

export const PORT = parseInt(process.env.PORT || '7860', 10);
export function resolveBindHost(env = process.env) {
  // Keep the shared-host setting compatible with the local-install name.
  return env.BIND_HOST || env.AM_BIND_HOST || '127.0.0.1';
}
export const BIND_HOST = resolveBindHost();

// Where the server can be reached from inside this machine.
//
// `server.listen(PORT, BIND_HOST)` binds ONE address unless that address is a
// wildcard, so once an operator sets BIND_HOST to a specific interface —
// exactly the reverse-proxy setup this supports — 127.0.0.1 stops answering.
// Anything that calls the manager's own HTTP API from inside the process or
// from an agent has to use this instead of a hardcoded loopback.
export function resolveInternalHost(env = process.env) {
  const bind = resolveBindHost(env);
  return bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
}
/** The same host, safe to drop into a URL: a bare IPv6 literal needs brackets. */
export function internalHostForUrl(env = process.env) {
  const host = resolveInternalHost(env);
  return host.includes(':') ? `[${host}]` : host;
}
export const INTERNAL_HOST = internalHostForUrl();
export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
// Host-chosen root, never supplied by a request. Lets an isolated manager attach
// existing projects without moving them or sharing production AM state.
if (process.env.AM_WORKSPACES_DIR && !path.isAbsolute(process.env.AM_WORKSPACES_DIR)) throw new Error('AM_WORKSPACES_DIR must be absolute');
export const WORKSPACES_DIR = process.env.AM_WORKSPACES_DIR ? path.resolve(process.env.AM_WORKSPACES_DIR) : path.join(DATA_DIR, 'workspaces');
export const STATE_DIR = path.join(DATA_DIR, 'state');
// Shared skills live in the workspace so agents can reach them (../skills).
export const SKILLS_DIR = path.join(DATA_DIR, 'workspaces', 'skills');
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
      const v = parseVersion(stdout);
      if (v) versionCache.set(c.id, v);
    });
  }
}

/** The installed version of one CLI, once the boot-time pass has answered. */
export function cliVersion(id) {
  return versionCache.get(id) || null;
}

const parseVersion = (stdout) => {
  const s = String(stdout);
  const m = s.match(/\d+\.\d+\.\d+[\w.-]*/);
  return m ? m[0] : (s.trim().split('\n')[0].slice(0, 40) || null);
};

/**
 * Ask one CLI its version RIGHT NOW and write the answer into the cache.
 *
 * refreshVersions() is a boot-time best-effort that never re-asks a CLI it has
 * an answer for — correct while nothing changes under it, wrong the moment the
 * updater replaces a binary. The updater calls this before and after each
 * install, so the catalog (and the Agents list) reports the new version on the
 * next poll instead of the one from boot.
 */
export function probeVersion(id) {
  const c = cliById(id);
  if (!c || !c.bin) return Promise.resolve(null);
  forgetCommandExists(c.bin);
  if (!commandExists(c.bin)) { versionCache.delete(id); return Promise.resolve(null); }
  return new Promise((resolve) => {
    execFile(c.bin, ['--version'], { timeout: 30000 }, (err, stdout = '') => {
      const v = err ? null : parseVersion(stdout);
      if (v) versionCache.set(id, v); else versionCache.delete(id);
      resolve(v);
    });
  });
}

/** Drop the memoized `command -v` answer — an install can make it stale. */
export function forgetCommandExists(cmd) {
  cmdExistsCache.delete(cmd);
}

// CLIs the updater refuses to touch even though they have a binary: the shell
// is the image's, and the repaint fixture is a test prop.
const NEVER_UPDATED = new Set(['shell', 'test-repaint', 'test-submit']);

/**
 * What an "update the CLIs" run would do, derived from the registry so a CLI
 * added later lands in one of the two lists without touching this code:
 *  - `targets`  : has an `npm` package — the updater installs @latest
 *  - `excluded` : an agent CLI that arrived some other way. Named out loud with
 *                 the reason, because a button that quietly skips a row is worse
 *                 than one that says it cannot help.
 */
export function cliUpdatePlan() {
  const agents = CLIS.filter((c) => c.bin && c.run && !NEVER_UPDATED.has(c.id)
    && !PASSIVE_CLIS.includes(c.id) && !isRemote(c.id));
  return {
    targets: agents.filter((c) => c.npm)
      .map((c) => ({ id: c.id, label: c.label, bin: c.bin, npm: c.npm })),
    excluded: agents.filter((c) => !c.npm)
      .map((c) => ({ id: c.id, label: c.label, reason: c.noUpdate || 'not installed through npm' })),
  };
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

// What OPENING A SESSION actually shows an operator with no credentials.
//
// This is not what the docs say and not what the CLI's own login command does
// — it is what appeared on screen when each agent was launched the way
// runner.js launches it (bash -lc <run>, in a PTY) with a HOME holding no
// credentials. A Space runs in a container the operator's browser cannot
// reach, so any flow that redirects to localhost is useless here however well
// it works on a laptop.
//
//  - claude: theme picker, then a login-method menu, then "Browser didn't
//    open? Use the url below to sign in" with a platform.claude.com URL and
//    "Paste code here if prompted". Completes in the pane. Nothing to type.
//  - codex:  the first screen is a menu — "Sign in with ChatGPT" (serves a
//    localhost:1455 redirect, dead from a Space), "Sign in with Device Code"
//    (auth.openai.com/codex/device plus a one-time code, completes in the
//    pane), "Provide your own API key". So opening a session is enough, but
//    the operator has to pick the second entry rather than the first.
//  - gemini / opencode / hermes / openclaw / fx: no sign-in was observed that
//    is confirmed to complete from a Space. fx offers a menu (Vercel / Codex /
//    Grok) whose routes are unverified here; openclaw opens straight into a
//    working TUI; gemini opens a folder-trust dialog first. Rather than guess,
//    these are `null` and the UI recommends the API key.
//
// `note` is the one thing the operator must know that the pane does not make
// obvious. Keep it to a sentence, or leave it out.
const IN_SESSION_SIGN_IN = {
  claude: { note: null },
  codex: { note: 'Choose "Sign in with Device Code" — the ChatGPT option redirects to localhost on the machine the agent runs on.' },
};

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
// A `-c 'projects."<dir>".trust_level="trusted"'` override was tried first and
// does NOT reach Codex's trust check — it reads the config file itself, so the
// answer has to be in the file (see trustCodexWorkspace in first-run.js).
const codexCommand = (tail = '') => `codex ${CODEX_INPUT_SIGNALS}${tail ? ` ${tail}` : ''}`;


/**
 * What confirms a delivered prompt was submitted (runner.js submitConfirmed),
 * matched against whitespace-free text so a wrapped placeholder still matches:
 * the CLI's placeholder for a collapsed paste, and its busy indicator.
 * `starting` is a notice during which Enter does nothing.
 */
// `notice` is that startup notice as Codex draws it after the composer's
// text, on the same row: removed before the composer is compared with the
// prompt, and only in this exact trailing form, never from the prompt itself.
const CODEX_CONFIRM = { pasted: /\[PastedContent\d+chars\]/, busy: /esc to interrupt/, starting: /Waiting for startup/,
  notice: / {2,}Waiting for startup {2}\u00b7 esc cancel\s*$/,
  // The elapsed time in Codex's busy row, the one part of it that changes on
  // its own (runner.js stillScreen): `Working (1m 05s • esc to interrupt)`.
  elapsed: /(Working \()(?:\d+h )?(?:\d+m )?\d+s( \u2022 esc to interrupt\))/g };
const CLAUDE_CONFIRM = { pasted: /\[Pastedtext#\d+/, busy: /esc to interrupt/ };

const GEMINI_DEPRECATED = 'Gemini CLI is deprecated: Google replaced it with Antigravity CLI. '
  + 'This session still works; start new ones with Antigravity.';

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
  // confirmSubmit: delivered prompts have been left unsubmitted in the
  // composer; sends read it back to confirm the submit (runner.js).
  { id: 'claude',   label: 'Claude Code', bin: 'claude',   color: '#d97757', run: 'claude',         cont: 'claude --continue', resizeMode: 'repaint',
    confirmSubmit: CLAUDE_CONFIRM,
    npm: '@anthropic-ai/claude-code',
    withPrompt: (q) => `claude ${q}`,
    secrets: ['ANTHROPIC_API_KEY'], setup: setupHint('ANTHROPIC_API_KEY') },
  { id: 'codex',    label: 'Codex',       bin: 'codex',    color: '#5eb6a6', run: codexCommand(),   cont: codexCommand('resume --last'), resizeMode: 'repaint',
    confirmSubmit: CODEX_CONFIRM,
    npm: '@openai/codex',
    resume: (id) => codexCommand(`resume ${id}`),
    // `q` and image paths arrive shell-quoted from runner.commandFor(). Repeat
    // -i because Codex's variadic flag would otherwise consume the prompt.
    withPrompt: (q, images = []) => `${codexCommand()}${images.length ? ` ${images.map((image) => `-i ${image}`).join(' ')}` : ''} ${q}`,
    secrets: ['OPENAI_API_KEY'], setup: setupHint('OPENAI_API_KEY') },
  // Deprecated: Google replaced Gemini CLI with Antigravity CLI. New sessions
  // are refused (index.js assertCreatable); existing ones launch as before.
  // The install, hooks and state handling go one release later.
  { id: 'gemini',   label: 'Gemini CLI',  bin: 'gemini',   color: '#4796e3', run: 'gemini',         cont: null, resizeMode: 'repaint',
    deprecated: {
      replacement: 'antigravity',
      note: GEMINI_DEPRECATED,
      refusal: 'Gemini CLI is deprecated: Google replaced it with Antigravity CLI, so new Gemini sessions '
        + 'can no longer be created. Existing ones keep working; start new ones with Antigravity CLI.',
    },
    npm: '@google/gemini-cli',
    withPrompt: (q) => `gemini -i ${q}`, // -i = interactive session seeded with the prompt
    secrets: ['GEMINI_API_KEY'], setup: setupHint('GEMINI_API_KEY') },
  { id: 'opencode', label: 'opencode',    bin: 'opencode', color: '#8a93a0', run: 'opencode',       cont: 'opencode --continue', resizeMode: 'repaint',
    npm: 'opencode-ai',
    withPrompt: (q) => `opencode --prompt ${q}`,
    secrets: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], setup: setupHint('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY') },
  { id: 'hermes',   label: 'Hermes',      bin: 'hermes',   color: '#a78bfa', run: 'hermes',         cont: 'hermes -c', resizeMode: 'repaint',
    noUpdate: 'installed by the vendor script from hermes-agent.nousresearch.com, onto its own Python venv',
    secrets: ['HF_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY'], setup: setupHint('HF_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY') },
  // `chat` = TUI in --local mode: embedded agent, no gateway/daemon needed.
  { id: 'openclaw', label: 'OpenClaw',    bin: 'openclaw', color: '#c83636', run: 'openclaw chat',  cont: null, resizeMode: 'repaint',
    npm: 'openclaw',
    secrets: ['ANTHROPIC_API_KEY'], setup: setupHint('ANTHROPIC_API_KEY') },
  // fx has no config-dir override: its state (auth, settings, sessions) is
  // hardcoded to ~/.fx, which entrypoint.sh points at local disk and
  // checkpoints — the same treatment opencode and Hermes get.
  { id: 'fx',       label: 'fx',          bin: 'fx',       color: '#626262', run: 'fx',             cont: 'fx --continue', resizeMode: 'repaint',
    noUpdate: 'a prebuilt binary from releases.fx.sh, not an npm package',
    resume: (id) => `fx --resume ${id}`,
    // fx has no "start interactive, seeded with this prompt" form: `fx ask` runs
    // one request and exits, which would end the pane instead of opening it. So
    // no withPrompt — a queued first prompt is typed into the TUI instead.
    secrets: ['AI_GATEWAY_API_KEY'], setup: setupHint('AI_GATEWAY_API_KEY') },
  // Test-only primary-screen repaint fixture. Absent from every normal runtime.
  ...(process.env.AM_TEST_REPAINT_CMD
    ? [{ id: 'test-repaint', label: 'Repaint fixture', bin: 'bash', color: '#8aa0ad', run: process.env.AM_TEST_REPAINT_CMD, cont: null, resizeMode: 'repaint' }]
    : []),
  // A fake TUI for the submit-confirmation tests, read like Codex.
  ...(process.env.AM_TEST_SUBMIT_CMD
    ? [{ id: 'test-submit', label: 'Submit fixture', bin: 'node', color: '#8aa0ad', run: process.env.AM_TEST_SUBMIT_CMD, cont: null,
      confirmSubmit: CODEX_CONFIRM }]
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
    case 'fx': {
      // One file per provider fx can sign into: the AI Gateway (`fx login` /
      // `fx setup`), a ChatGPT subscription, or a Grok one. Any of them means
      // configured. `fx status --json` would be authoritative, but this runs on
      // every /api/clis poll and must not spawn a process.
      const fxHome = path.join(home, '.fx');
      return hasEnv('AI_GATEWAY_API_KEY')
        || ['auth.json', 'chatgpt-auth.json', 'grok-auth.json'].some((f) => fileOk(path.join(fxHome, f)));
    }
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
    // The two ways in, as data rather than prose, so the first-run window can
    // show the real ones per agent instead of a sentence that has to be kept in
    // sync by hand. `signIn` is null where no pane-usable flow is confirmed.
    secrets: c.secrets || [],
    // Whether opening a session presents a sign-in that completes from a
    // Space, and anything the operator must know to use it. null = we did not
    // confirm one, so the UI must not invent instructions.
    signIn: IN_SESSION_SIGN_IN[c.id] || null,
    // A deprecated CLI stays in the catalog so its existing sessions keep a
    // label and colour, but the UI offers it for nothing new. `replacement` is
    // the id to point people at; `note` is the one sentence every notice shows.
    deprecated: !!c.deprecated,
    ...(c.deprecated ? { replacement: c.deprecated.replacement, deprecationNote: c.deprecated.note } : {}),
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
