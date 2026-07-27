import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  PORT, PUBLIC_DIR, DATA_DIR, WORKSPACES_DIR, SKILLS_DIR, USE_TMUX, TMUX_AVAILABLE,
  ensureDirs, cliCatalog, cliById, slugify, workspacePath, refreshVersions,
} from './config.js';
import * as store from './sessions.js';
import * as groups from './groups.js';
import * as order from './order.js';
import * as demo from './demo.js';
import { attach, agentInfo, deriveState, stop, ensureRunning, sendInput, copySelection, paneModes, isRunning } from './runner.js';
import { buildUsage } from './usage.js';
import { buildTraces, traceDigests, digestFor } from './traces.js';
import { initPush, publicKey, deviceCount, addSubscription, removeSubscription, sendToAll } from './push.js';
import { startVisibilityWatch, isPublic, visibility } from './visibility.js';
import { startWatchdog } from './watchdog.js';

ensureDirs();
refreshVersions();
store.init();
groups.init();
order.init();
demo.init();

// One-time migration to the explicit-path model: sessions used to own a folder
// named after them (renamed along with them), or inherit their group's shared
// folder. Now each session simply records `path` — names and folders are
// independent, and groups are visual only.
for (const s of store.list()) {
  if (s.path === undefined) {
    const g = groups.groupOf(s.id);
    const path = s.cli === 'files' ? null : ((g && g.folder) || s.folder || s.id);
    store.update(s.id, { path, folder: undefined });
  }
}

// Empty dirs don't reliably persist on the bucket (object storage) across
// restarts, so re-create every recorded workspace path on the mount so the
// Files agent always sees them.
function ensureWorkspaceFolders() {
  for (const s of store.list()) {
    if (s.path) { try { fs.mkdirSync(workspacePath(s.path), { recursive: true }); } catch {} }
  }
}
ensureWorkspaceFolders();
distributeAllSkills(); // re-publish skills to each agent's dir on boot

// Configure a Claude Code statusline hook that captures the official rate_limits
// payload to disk (for the Usage page), preserving any existing settings.
function ensureClaudeStatusline() {
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (!cfg) return;
    fs.mkdirSync(cfg, { recursive: true });
    const p = path.join(cfg, 'settings.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-statusline.mjs');
    s.statusLine = { type: 'command', command: `node ${script}`, padding: 0 };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  } catch {}
}
ensureClaudeStatusline();

// Seed autonomous defaults so agents don't stop to ask for routine commands:
// the private Space container is itself the sandbox, so in-CLI permission
// prompts add friction without adding safety. Gated to Space deployments via
// the entrypoint-set env vars (same idiom as the statusline hook), and only
// fills in what the operator hasn't set — existing values are never touched.
function ensureAutonomyDefaults() {
  // Codex: approval_policy + sandbox_mode in $CODEX_HOME/config.toml. Codex's
  // Linux sandbox needs Landlock, which the Space container doesn't provide,
  // so full access with no approvals is the working configuration. Missing
  // keys are PREPENDED: top-level toml keys must precede any [section].
  try {
    const home = process.env.CODEX_HOME;
    if (home) {
      fs.mkdirSync(home, { recursive: true });
      const p = path.join(home, 'config.toml');
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch {}
      const missing = [];
      if (!/^\s*approval_policy\s*=/m.test(txt)) missing.push('approval_policy = "never"');
      if (!/^\s*sandbox_mode\s*=/m.test(txt)) missing.push('sandbox_mode = "danger-full-access" # the Space container is the sandbox');
      if (missing.length) fs.writeFileSync(p, `${missing.join('\n')}\n${txt}`);
    }
  } catch (e) { console.error('[autonomy codex]', e && e.message); }
  // Claude Code: permissions.defaultMode in settings.json — every session
  // starts in bypassPermissions (what shift+tab toggles per conversation).
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (cfg) {
      fs.mkdirSync(cfg, { recursive: true });
      const p = path.join(cfg, 'settings.json');
      let s = {};
      try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      s.permissions = s.permissions || {};
      if (!s.permissions.defaultMode) {
        s.permissions.defaultMode = 'bypassPermissions';
        fs.writeFileSync(p, JSON.stringify(s, null, 2));
      }
    }
  } catch (e) { console.error('[autonomy claude]', e && e.message); }
}
ensureAutonomyDefaults();
initPush();

// Wait for the visibility verdict before serving so isPublic() (which fails
// closed until the first successful check) doesn't flash the locked UI on a
// private Space's boot — but bound the wait: a hung HF API must NEVER stop the
// server from listening. If the check is slow, we serve anyway (briefly locked)
// and the 60s interval check unlocks once it lands.
await Promise.race([
  startVisibilityWatch(),
  new Promise((r) => setTimeout(r, 9000)),
]);

// Crash backstops: this is a single long-running process pumping every
// terminal. An unhandled rejection from an async route, or an error emitted by
// a dropped socket, would otherwise take the whole thing down. Log and keep
// running instead of exiting.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const app = express();
app.use(express.json());

// Safety lock: with no authentication, only serve the terminal backend when the
// Space is private. If it's public, block every working API (and /ws below) and
// let the UI render its setup widget instead. Health/info/visibility stay open
// so the page can explain itself; static assets load so the widget can render.
const OPEN_WHEN_PUBLIC = new Set(['/api/health', '/api/info', '/api/visibility']);
app.use((req, res, next) => {
  if (!isPublic()) return next();
  if (!req.path.startsWith('/api/') || OPEN_WHEN_PUBLIC.has(req.path)) return next();
  return res.status(403).json({ error: 'locked', reason: 'public-space' });
});

app.get('/api/visibility', (_req, res) => res.json(visibility()));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, tmux: USE_TMUX, tmuxAvailable: TMUX_AVAILABLE }));

app.get('/api/clis', (_req, res) => res.json(cliCatalog()));

app.get('/api/usage', async (req, res) => res.json(await buildUsage(req.query.debug === '1', req.query.provider || null)));

app.get('/api/traces', async (_req, res) => res.json(await buildTraces()));

// ---------- push notifications (agent-initiated, on explicit request) ----------
app.get('/api/push/key', (_req, res) => res.json({ publicKey: publicKey(), devices: deviceCount() }));

app.post('/api/push/subscribe', (req, res) => {
  const ok = addSubscription((req.body || {}).subscription, req.headers['user-agent']);
  if (!ok) return res.status(400).json({ error: 'bad subscription' });
  res.json({ ok: true, devices: deviceCount() });
});

app.post('/api/push/unsubscribe', (req, res) => {
  removeSubscription((req.body || {}).endpoint);
  res.json({ ok: true, devices: deviceCount() });
});

// Agents (and the Settings test button) call this from inside the container.
// Rate-limited as a backstop: a confused agent must not buzz a phone in a loop.
const notifyLog = [];
app.post('/api/notify', async (req, res) => {
  const { title, body, url } = req.body || {};
  const text = typeof body === 'string' ? body.trim().slice(0, 500) : '';
  if (!text) return res.status(400).json({ error: 'body required' });
  const now = Date.now();
  while (notifyLog.length && now - notifyLog[0] > 60_000) notifyLog.shift();
  if (notifyLog.length >= 6) return res.status(429).json({ error: 'rate limited — max 6 notifications per minute' });
  notifyLog.push(now);
  const r = await sendToAll({
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : 'Agent Manager',
    body: text,
    url: typeof url === 'string' ? url.slice(0, 200) : '/',
  });
  if (r.devices === 0) {
    return res.json({ ok: false, ...r, note: 'no subscribed devices — the operator must enable notifications in Settings first' });
  }
  res.json({ ok: r.sent > 0, ...r });
});

// Overview cards: every agent's state + what it did since your last prompt.
// Targeted digest for one session — lets the Overview fill tiles one by one
// while the bulk build (below) is still chewing through the bucket.
app.get('/api/meta/:id', async (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const digest = await digestFor(s);
  res.json({ id: s.id, digest });
});

app.get('/api/meta', async (_req, res) => {
  const digests = await traceDigests();
  const hs = demo.active() ? demo.hiddenSessions() : null;
  const sessions = sessionsWithState()
    .filter((s) => s.cli !== 'files' && s.cli !== 'shell')
    .filter((s) => !hs || !hs.has(s.id))
    .map((s) => {
      const d = digests.get(s.id);
      if (d) { const { _ts, ...digest } = d; return { ...s, digest }; }
      return { ...s, digest: null };
    });
  res.json({ sessions, generatedAt: new Date().toISOString() });
});

// Type a prompt into a session's terminal from the Overview — no pane needed.
// If the agent is stopped, wake it first (detached tmux + resume) and give the
// CLI a moment to boot before the keystrokes land.
app.post('/api/sessions/:id/input', async (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.cli === 'files') return res.status(400).json({ error: 'files pane takes no input' });
  const text = typeof (req.body || {}).text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty' });
  try {
    const started = ensureRunning(s);
    if (started) await new Promise((r) => setTimeout(r, 3500));
    await sendInput(s.id, text);
    res.json({ ok: true, started });
  } catch (e) {
    res.status(409).json({ error: String(e.message || e) });
  }
});

const hfToken = () => process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || null;

// Env var names that existed at build time (baked in by the Dockerfile). Names
// present at runtime but NOT here were injected by HF → the Space's secrets and
// variables. We never read their values, only report the names.
const BUILD_ENV_KEYS = (() => {
  try {
    return new Set(fs.readFileSync('/app/build-env-keys.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return null; }
})();
// Platform/runtime vars that aren't user secrets (set by HF / k8s / our
// entrypoint). NOTE: anything entrypoint.sh `export`s lands here too — it runs
// after the build-time snapshot, so its vars would otherwise be misdetected as
// injected secrets. Keep this list in sync with entrypoint.sh.
const NON_SECRET = new Set([
  'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NPM_CONFIG_PREFIX', 'PWD', 'OLDPWD', 'SHLVL', '_', 'HOSTNAME',
  'ACCELERATOR', 'COMMIT_SHA', 'CPU_CORES', 'HF_DATASETS_TRUST_REMOTE_CODE', 'IMAGE_SHA', 'MEMORY', 'OMP_NUM_THREADS',
  'UV_CACHE_DIR', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'PYTHONUSERBASE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
]);
const NON_SECRET_PREFIX = ['SPACE_', 'KUBERNETES_', 'NVIDIA_', 'CUDA_', 'NV_', 'AM_'];
function injectedEnvKeys() {
  if (!BUILD_ENV_KEYS) return [];
  return Object.keys(process.env)
    .filter((k) => !BUILD_ENV_KEYS.has(k) && !NON_SECRET.has(k) && !NON_SECRET_PREFIX.some((p) => k.startsWith(p)))
    .sort();
}

app.get('/api/info', (_req, res) => res.json({
  dataDir: DATA_DIR,
  home: process.env.HOME || null,
  spaceId: process.env.SPACE_ID || null,
  spaceHost: process.env.SPACE_HOST || null,
  tmux: USE_TMUX,
  locked: isPublic(),
  lockReason: visibility().reason,
  lockBucket: visibility().bucket,
  canRelaunch: !!(process.env.SPACE_ID && hfToken()),
  // While public, /api/info stays reachable (the Locked page needs it) — don't
  // advertise which credentials exist to the whole internet.
  secrets: isPublic() ? [] : injectedEnvKeys(),
  // True when the Space is private but we couldn't verify its bucket is private
  // (no HF_TOKEN to discover the bucket). Non-blocking; the UI shows a warning.
  bucketUnverified: !isPublic() && !!visibility().bucketUnverified,
  // First-run welcome: shown once per Space (flag persists on the bucket).
  welcomeSeen: welcomeSeen(),
  // Demo mode: current sessions hidden from view; forces the welcome to show.
  demoMode: demo.active(),
}));

// Demo mode toggle. Activating snapshots the current sessions/groups as the
// hidden set; deactivating clears it. Nothing is deleted either way.
app.post('/api/demo', (req, res) => {
  const on = !!(req.body || {}).active;
  if (on) demo.activate(store.list().map((s) => s.id), groups.list().map((g) => g.id));
  else demo.deactivate();
  res.json({ ok: true, active: demo.active() });
});

// First-run welcome flag, persisted on the bucket so it's once-per-Space, not
// once-per-browser.
const WELCOME_FILE = path.join(DATA_DIR, 'welcome-seen.json');
function welcomeSeen() {
  try { return !!JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).seen; } catch { return false; }
}
app.post('/api/welcome/seen', (_req, res) => {
  try { fs.writeFileSync(WELCOME_FILE, JSON.stringify({ seen: true, at: new Date().toISOString() })); } catch {}
  res.json({ ok: true });
});

// Factory-reboot the Space: rebuilds the image (reinstalling the CLIs at their
// latest published versions, per the Dockerfile) and relaunches everything.
// Needs an HF token with write access set as a Space secret (HF_TOKEN).
let lastRelaunchAt = 0;
app.post('/api/relaunch', async (_req, res) => {
  const id = process.env.SPACE_ID;
  const token = hfToken();
  if (!id) return res.json({ ok: false, reason: 'no-space' });
  if (!token) return res.json({ ok: false, reason: 'no-token' });
  // Cooldown so a confused/looping agent (or double-click) can't reboot-storm.
  if (Date.now() - lastRelaunchAt < 60_000) return res.json({ ok: false, reason: 'cooldown' });
  lastRelaunchAt = Date.now();
  try {
    const r = await fetch(`https://huggingface.co/api/spaces/${id}/restart?factory=true`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.json({ ok: false, reason: `http-${r.status}` });
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: false, reason: String(e.message || e) }); }
});

// ---------- self-update: pull the latest app from the template ----------
// Duplicated Spaces never get app updates. This compares the Space repo's sha
// to the template's and, on request, force-pushes the template's main onto the
// Space repo (HF rebuilds automatically). Agents, logins, and files live on
// the bucket, so replacing the app code is safe; any manual edits to the
// Space's own repo are overwritten.
const TEMPLATE_SPACE = 'lvwerra/agent-manager-template';
async function updateSource() {
  const own = process.env.SPACE_ID;
  const token = hfToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const info = await (await fetch(`https://huggingface.co/api/spaces/${own}`, { headers })).json();
  // Prefer the recorded origin for real duplicates; fall back to the canonical
  // template (also correct for the original development Space).
  const template = (typeof info.duplicated_from === 'string' && info.duplicated_from) || TEMPLATE_SPACE;
  const tInfo = await (await fetch(`https://huggingface.co/api/spaces/${template}`)).json();
  return { own, ownSha: info.sha || null, template, templateSha: tInfo.sha || null };
}

app.get('/api/update/check', async (_req, res) => {
  if (!process.env.SPACE_ID) return res.json({ ok: false, reason: 'no-space' });
  try {
    const src = await updateSource();
    res.json({
      ok: true,
      template: src.template,
      current: src.ownSha,
      latest: src.templateSha,
      behind: !!(src.ownSha && src.templateSha && src.ownSha !== src.templateSha),
      canUpdate: !!hfToken(),
    });
  } catch (e) { res.json({ ok: false, reason: String(e.message || e) }); }
});

let updateBusy = false;
app.post('/api/update', async (_req, res) => {
  const token = hfToken();
  if (!process.env.SPACE_ID) return res.json({ ok: false, reason: 'no-space' });
  if (!token) return res.json({ ok: false, reason: 'no-token' });
  if (updateBusy) return res.json({ ok: false, reason: 'busy' });
  updateBusy = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-update-'));
  const git = (args, cwd) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).replace(token, '***'))) : resolve(stdout)));
  });
  try {
    const src = await updateSource();
    if (src.ownSha && src.templateSha && src.ownSha === src.templateSha) {
      return res.json({ ok: true, upToDate: true });
    }
    await git(['clone', '--quiet', `https://huggingface.co/spaces/${src.template}`, dir]);
    await git(['remote', 'add', 'own', `https://user:${token}@huggingface.co/spaces/${src.own}`], dir);
    await git(['push', '--force', 'own', 'main'], dir);
    res.json({ ok: true, from: src.ownSha, to: src.templateSha });
  } catch (e) {
    res.json({ ok: false, reason: String(e.message || e).slice(0, 300) });
  } finally {
    updateBusy = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ---------- secrets: describe each injected secret/variable, feed a skill ----------
const SECRET_NOTES_FILE = path.join(DATA_DIR, 'secret-notes.json');
function loadSecretNotes() {
  try { return JSON.parse(fs.readFileSync(SECRET_NOTES_FILE, 'utf8')); } catch { return {}; }
}
// ---------- operator config (artifacts hub, jobs policy) ----------
const AM_CONFIG_FILE = path.join(DATA_DIR, 'am-config.json');
const spaceNamespace = () => (process.env.SPACE_ID || '').split('/')[0] || '';
const defaultArtifactsSpace = () => (spaceNamespace() ? `${spaceNamespace()}/agent-artifacts` : '');
function loadAmConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(AM_CONFIG_FILE, 'utf8')); } catch {}
  return {
    artifacts: {
      enabled: saved.artifacts?.enabled !== false,
      space: (saved.artifacts?.space || '').trim() || defaultArtifactsSpace(),
      visibility: saved.artifacts?.visibility === 'public' ? 'public' : 'private',
    },
    jobs: {
      // Estimated USD above which agents must ask before launching an HF Job.
      // 0 = always ask first.
      askAboveUsd: Number.isFinite(saved.jobs?.askAboveUsd) ? Math.max(0, saved.jobs.askAboveUsd) : 0,
    },
    // Sessions with no activity beyond this window are hidden from the sidebar
    // and overview (derived client-side; nothing is deleted).
    archive: {
      after: ['week', 'month', 'never'].includes(saved.archive?.after) ? saved.archive.after : 'month',
    },
  };
}
app.get('/api/config', (_req, res) => res.json({ ...loadAmConfig(), defaultArtifactsSpace: defaultArtifactsSpace() }));
app.put('/api/config', (req, res) => {
  const b = req.body || {};
  const cfg = {
    artifacts: {
      enabled: !!(b.artifacts?.enabled ?? true),
      space: typeof b.artifacts?.space === 'string' ? b.artifacts.space.trim() : '',
      visibility: b.artifacts?.visibility === 'public' ? 'public' : 'private',
    },
    jobs: { askAboveUsd: Math.max(0, Number(b.jobs?.askAboveUsd) || 0) },
    archive: { after: ['week', 'month', 'never'].includes(b.archive?.after) ? b.archive.after : 'month' },
  };
  try { fs.writeFileSync(AM_CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
  generateEnvSkill(loadSecretNotes());
  res.json({ ok: true });
});

// The artifacts section teaches agents to publish rich HTML results to a
// central static Space instead of dumping walls of text in the terminal.
function artifactsSection(cfg) {
  if (!cfg.artifacts.enabled || !cfg.artifacts.space) return '';
  const space = cfg.artifacts.space;
  const priv = cfg.artifacts.visibility === 'private';
  const host = `${space.replace('/', '-').toLowerCase()}.static.hf.space`;
  return `
## Publishing results as web pages (artifacts)
When a result is easier to READ than raw terminal text — reports, comparisons,
benchmarks, dashboards, visualizations — render it as a **beautiful,
self-contained HTML page** (inline CSS/JS, no external requests) and publish it
to the operator's artifacts Space: \`${space}\` (${priv ? 'private' : 'public'}, static).

- First use only — create the Space if it doesn't exist:
  \`hf repo create ${space} --repo-type space --space-sdk static${priv ? ' --private' : ''}\`
- Publish or update a page:
  \`hf upload ${space} ./report.html report.html --repo-type space\`
- Keep an \`index.html\` at the Space root that links every page: download it
  (\`hf download ${space} index.html --repo-type space --local-dir .\`), add your
  entry, re-upload. Create it on first use.
- Every page gets a direct link: \`https://${host}/<name>.html\` — put that link
  in your final answer so the operator can open or share it.
- For interactive demos beyond a static page, create a separate Space (e.g.
  \`--space-sdk gradio\`) under the same namespace and link it from the index.
`;
}

function jobsSection(cfg) {
  const limit = cfg.jobs.askAboveUsd;
  const policy = limit > 0
    ? `If the estimated cost exceeds **$${limit}**, STOP and ask the operator first`
    : 'ALWAYS ask the operator before launching a job';
  return `
## Heavy compute: Hugging Face Jobs
This Space runs on a small CPU. For expensive work — training, large batch
inference, anything wanting a GPU or hours of compute — run a **HF Job** on
dedicated hardware instead of grinding here:
\`hf jobs run --flavor a10g-small <image-or-script> …\` (see \`hf jobs run --help\`; results go to the Hub or the bucket).
Cost policy: ${policy} — show the command, the flavor, and your time/cost
estimate, then wait for approval.
`;
}

// (Re)build the "environment" skill so every agent knows which env vars exist
// and what they're for. Values are never written — only names + descriptions.
function generateEnvSkill(notes) {
  const amCfg = loadAmConfig();
  return generateEnvSkillInner(notes, amCfg);
}
function generateEnvSkillInner(notes, amCfg) {
  const keys = injectedEnvKeys();
  const envLines = keys.length
    ? keys.map((k) => `- \`${k}\`${notes[k] ? ` — ${notes[k]}` : ''}`).join('\n')
    : '_None configured yet._';
  const content = `---
name: environment
description: "READ THIS BEFORE STARTING ANY WORK. How this workspace actually behaves: what persists where, other agents sharing it, publishing results as web pages, running heavy compute as HF Jobs, notifying the operator, and which API keys are available."
---

# Your environment: Agent Manager

You are running as a terminal session inside **Agent Manager**, a private cloud
workspace (a Hugging Face Space) operated by a single user. Several AI coding
CLIs run here side by side — Claude Code, Codex, Gemini CLI, opencode, and
Hermes — alongside plain shells and a file browser.

## Where you are
- Your working directory is a **workspace folder** under \`/data/workspaces/\`. Everything you create here is saved.
- Your home is \`/data/home\` (\`$HOME\`): config, credentials, and shell history persist across restarts.
- \`$AM_SESSION\` is your workspace folder (path relative to \`/data/workspaces\`); \`$AM_NAME\` is your display name in the manager; \`$AM_USER\` is the operator.

## What persists (and what doesn't)
- \`/data\` is **durable storage** (a mounted bucket). Files under \`/data/workspaces/…\` and \`/data/home/…\` survive restarts and sleep.
- **Empty directories are not persisted** — only files. If a folder must exist, keep a file in it.
- Sessions are **tmux-backed**: they keep running when the browser disconnects and can be resumed after the Space sleeps.
- Exception: OpenClaw runs with its own \`$HOME\` on local disk for filesystem compatibility; that state is backed up to the bucket every minute.

## You may not be alone
- Other agents run in **sibling folders** under \`/data/workspaces/\`, and you may be **grouped** to share a single folder with other agents.
- Be a good neighbor: stay within your task, and never delete or \`rm -rf\` a folder that isn't yours.

## Shared skills
- Reusable skills (like this one) live in \`/data/workspaces/skills/\` and are published into every agent's skills directory automatically. Read them for project conventions and recurring tasks.

## Tooling
- A full Linux shell with \`git\`, \`ripgrep\` (\`rg\`), \`node\`, and \`python3\`, plus build tools. Reach for \`rg\` for fast search.
- Preinstalled utilities: \`jq\`, \`htop\`, \`lsof\`, \`tree\`, \`ncdu\`, \`sqlite3\`, \`vim\`/\`nano\`, \`zip\`/\`unzip\`, \`ffmpeg\`, \`imagemagick\`, \`gh\` (GitHub CLI; auths from \`$GH_TOKEN\`), \`git-lfs\`, \`hf\` (Hugging Face CLI).
- **Headless Chromium for Playwright is baked in** (\`PLAYWRIGHT_BROWSERS_PATH\`): node and python playwright work immediately, no browser download. Use it to screenshot or test web work.
- The default \`python3\` ships \`numpy\`, \`pandas\`, \`matplotlib\` (\`MPLBACKEND=Agg\`), \`seaborn\`, \`requests\`, \`pillow\`, \`huggingface_hub\`, \`ipython\` — fine for one-off scripts; build real project envs with uv on \`$AM_LOCAL\` (below).
- Network access is available; API keys are provided via the environment (below) or your home config.

## Working well here
- Keep work inside your workspace folder; use absolute paths under \`/data/workspaces/\` when in doubt.
- Prefer small, verifiable steps and leave the workspace tidy — the operator browses these files directly in the file viewer.

## Notifying the operator
The operator's devices receive push notifications. Use this ONLY when the
operator explicitly asked for it in their prompt (e.g. "notify me when the
tests pass") — send exactly ONE message when that condition is met:

\`\`\`sh
curl -s -X POST http://localhost:${PORT}/api/notify \\
  -H 'content-type: application/json' \\
  -d "{\\"title\\":\\"$AM_NAME\\",\\"body\\":\\"<one-line outcome>\\"}"
\`\`\`

Never notify unprompted, never in loops, never for progress updates — one
message per requested event, with a short concrete outcome as the body.

For DELAYED notifications ("notify me in 10 minutes"), do not block on a long
\`sleep\` — run the delay in the background so your tool call returns
immediately (long-running foreground execs can destabilize some sessions):

\`\`\`sh
(sleep 600 && curl -s -X POST http://localhost:${PORT}/api/notify \\
  -H 'content-type: application/json' \\
  -d "{\\"title\\":\\"$AM_NAME\\",\\"body\\":\\"reminder\\"}") >/dev/null 2>&1 &
\`\`\`

## Custom tools & Python environments
- Custom tools are installed at startup by \`/data/install.sh\` (edit it to add packages; it re-runs on every restart). Progress/errors: \`/data/install.log\`.
- \`$AM_LOCAL\` is a **fast local disk** for tools, envs, and caches. Build Python envs there, **never** as a \`.venv\` on the \`/data\` bucket (object storage is slow and can't lock/mmap well). From a workspace:
  \`UV_PROJECT_ENVIRONMENT="$AM_LOCAL/envs/<name>" uv sync\`
- Keep \`pyproject.toml\` / \`uv.lock\` / \`requirements.txt\` in the workspace — they're the durable source of truth; the env rebuilds from them in seconds after a restart.
${artifactsSection(amCfg)}${jobsSection(amCfg)}
## Environment variables
These are configured in the Space and available to every agent. Read a value
from the environment when you need it (e.g. \`$NAME\`); never print secret values.

${envLines}
`;
  const p = skillPath('environment.md');
  if (p) { try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); fs.writeFileSync(p, content); } catch {} }
  distributeSkill('environment.md', content);
}

app.get('/api/secrets', (_req, res) => res.json({ detected: injectedEnvKeys(), notes: loadSecretNotes() }));
app.put('/api/secrets', (req, res) => {
  const notes = (req.body && req.body.notes && typeof req.body.notes === 'object') ? req.body.notes : {};
  try { fs.writeFileSync(SECRET_NOTES_FILE, JSON.stringify(notes, null, 2)); } catch {}
  generateEnvSkill(notes);
  res.json({ ok: true });
});

// ---------- skills (markdown/text files in the workspace) ----------
const SKILL_RE = /^[\w.\- ]{1,80}$/;
function skillPath(name) {
  if (!SKILL_RE.test(name) || name.includes('/') || name.includes('..')) return null;
  return path.join(SKILLS_DIR, name);
}

// Fan skills out as SKILL.md into the dirs every agent auto-reads, so a saved
// skill is available to all of them in every new session. Gated to real Space
// deployments (or explicit opt-in): on a dev laptop these paths are the
// developer's OWN ~/.claude etc. — local test runs must not write there.
function skillTargetDirs() {
  if (!process.env.SPACE_ID && process.env.AM_DISTRIBUTE_SKILLS !== '1') return [];
  const home = process.env.HOME || os.homedir();
  const claudeCfg = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const dirs = [
    path.join(home, '.agents', 'skills'),   // Codex, Gemini, opencode
    path.join(claudeCfg, 'skills'),          // Claude Code
    path.join(home, '.hermes', 'skills'),    // Hermes
  ];
  // OpenClaw runs with its own HOME (see entrypoint.sh) and reads managed
  // skills from ~/.agents/skills resolved against THAT home. Recreated on
  // every boot, so it needs no backup coverage.
  if (process.env.OPENCLAW_HOME) dirs.push(path.join(process.env.OPENCLAW_HOME, '.agents', 'skills'));
  return dirs;
}
function parseSkillFile(filename, content) {
  const name = slugify(path.basename(filename).replace(/\.[^.]+$/, '')) || 'skill';
  let body = content;
  let desc = '';
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) desc = d[1].trim().replace(/^["']|["']$/g, '');
    body = fm[2];
  }
  if (!desc) {
    const h = body.match(/^#+\s*(.+)$/m);
    desc = (h ? h[1] : (body.split('\n').find((l) => l.trim()) || name)).trim();
  }
  desc = desc.replace(/\s+/g, ' ').slice(0, 300).replace(/"/g, '\\"');
  return { name, description: desc, body: body.trim() };
}
function distributeSkill(filename, content) {
  const { name, description, body } = parseSkillFile(filename, content);
  const md = `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;
  for (const base of skillTargetDirs()) {
    try { fs.mkdirSync(path.join(base, name), { recursive: true }); fs.writeFileSync(path.join(base, name, 'SKILL.md'), md); } catch {}
  }
}
function undistributeSkill(filename) {
  const name = slugify(path.basename(filename).replace(/\.[^.]+$/, ''));
  for (const base of skillTargetDirs()) {
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch {}
  }
}
function distributeAllSkills() {
  let files = [];
  try { files = fs.readdirSync(SKILLS_DIR).filter((f) => { try { return fs.statSync(path.join(SKILLS_DIR, f)).isFile(); } catch { return false; } }); } catch {}
  for (const f of files) {
    try { distributeSkill(f, fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')); } catch {}
  }
}

app.get('/api/skills', (_req, res) => {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const files = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, size: fs.statSync(path.join(SKILLS_DIR, e.name)).size }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  res.json(files);
});

app.get('/api/skills/:name', (req, res) => {
  const p = skillPath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.json({ name: req.params.name, content: fs.readFileSync(p, 'utf8') });
});

app.put('/api/skills/:name', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  const p = skillPath(req.params.name);
  if (!p) return res.status(400).json({ error: 'bad name' });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const content = typeof req.body === 'string' ? req.body : '';
  fs.writeFileSync(p, content);
  distributeSkill(req.params.name, content); // push to every agent
  res.json({ ok: true });
});

app.delete('/api/skills/:name', (req, res) => {
  const p = skillPath(req.params.name);
  if (!p) return res.status(400).json({ error: 'bad name' });
  try { fs.unlinkSync(p); } catch {}
  undistributeSkill(req.params.name);
  res.json({ ok: true });
});

// ---------- file browser (for the Files agent) ----------
function folderPathOf(session) {
  // A Files agent without a chosen location browses the whole workspace root.
  if (session.cli === 'files' && !session.path) return WORKSPACES_DIR;
  // '' = the workspaces root itself (?? so it isn't mistaken for "unset").
  return workspacePath(session.path ?? session.id);
}
function resolveSafe(root, rel) {
  const p = path.resolve(root, rel || '.');
  if (p !== root && !p.startsWith(root + path.sep)) return null; // lexical check
  // Symlink-safe: the REAL path of the deepest existing ancestor must still be
  // inside the real root, so a symlink planted in a workspace can't read out
  // (e.g. a link to /data/state credentials or /etc).
  try {
    const realRoot = fs.realpathSync(root);
    let anc = p;
    while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
    const real = fs.realpathSync(anc);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return p;
  } catch { return null; }
}

app.get('/api/files/:id', (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.cli === 'files' && !req.query.path) ensureWorkspaceFolders(); // refresh the root view
  const root = folderPathOf(s);
  fs.mkdirSync(root, { recursive: true });
  const dir = resolveSafe(root, req.query.path);
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: 'bad path' });
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    let size = 0;
    try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch {}
    return { name: e.name, dir: e.isDirectory(), size };
  });
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  res.json({ path: path.relative(root, dir), root: path.basename(root), entries });
});

app.get('/api/files/:id/download', (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).end();
  const f = resolveSafe(folderPathOf(s), req.query.path);
  if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return res.status(404).end();
  res.download(f);
});

// Stream uploads straight to disk — a big drag-drop must not be buffered in the
// RAM of the process that's also pumping every terminal's PTY data.
app.post('/api/files/:id/upload', (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const dir = resolveSafe(folderPathOf(s), req.query.path);
  const name = String(req.query.name || '');
  if (!dir || !name || name.includes('/') || name.includes('..')) return res.status(400).json({ error: 'bad path' });
  const dest = path.join(dir, name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return res.status(500).json({ error: e.message }); }
  const out = fs.createWriteStream(dest);
  const fail = (e) => {
    out.destroy();
    fs.unlink(dest, () => {}); // don't leave a truncated file behind
    if (!res.headersSent) res.status(500).json({ error: String(e && e.message || e) });
  };
  out.on('error', fail);
  req.on('error', fail);
  req.on('aborted', () => fail(new Error('upload aborted')));
  out.on('finish', () => res.json({ ok: true }));
  req.pipe(out);
});

// Sanitize a client-supplied workspace-relative path: no '..', no absolute
// paths, must resolve under WORKSPACES_DIR. Returns the normalized relative
// path ('' = the workspaces root), or null if invalid.
function cleanRelPath(p) {
  if (typeof p !== 'string') return null;
  const parts = p.split('/').map((s) => s.trim()).filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  const rel = parts.join('/');
  const abs = path.resolve(WORKSPACES_DIR, rel);
  if (abs !== WORKSPACES_DIR && !abs.startsWith(WORKSPACES_DIR + path.sep)) return null;
  return rel;
}

// Folder listing for the location picker (subfolders of one level).
app.get('/api/folders', (req, res) => {
  const rel = cleanRelPath(req.query.path || '');
  if (rel === null) return res.status(400).json({ error: 'bad path' });
  const dir = workspacePath(rel);
  let folders = [];
  try {
    folders = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {}
  res.json({ path: rel, folders });
});

function sessionsWithState() {
  const info = agentInfo();
  return store.list().map((s) => {
    const state = deriveState(s, info.get(s.id));
    return { ...s, state, running: state !== 'stopped' };
  });
}

// The whole sidebar tree in one call: ordered refs + groups + sessions(+state).
app.get('/api/tree', (_req, res) => {
  let sessions = sessionsWithState();
  let groupList = groups.list();
  const groupedIds = new Set(groupList.flatMap((g) => g.sessionIds));
  const loose = store.list().filter((s) => !groupedIds.has(s.id));
  const refsMeta = [
    ...groupList.map((g) => ({ ref: `g:${g.id}`, t: g.createdAt || '' })),
    ...loose.map((s) => ({ ref: `s:${s.id}`, t: s.createdAt })),
  ].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0)); // newest first
  order.normalize(refsMeta.map((x) => x.ref));
  let orderList = order.list();
  // Demo mode hides the snapshotted sessions/groups from the view (sessions
  // created after activation aren't in the snapshot, so they show through).
  if (demo.active()) {
    const hs = demo.hiddenSessions(), hg = demo.hiddenGroups();
    sessions = sessions.filter((s) => !hs.has(s.id));
    groupList = groupList
      .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((id) => !hs.has(id)) }))
      .filter((g) => !hg.has(g.id));
    orderList = orderList.filter((ref) =>
      ref.startsWith('g:') ? !hg.has(ref.slice(2)) : !hs.has(ref.slice(2)));
  }
  res.json({ order: orderList, groups: groupList, sessions });
});

// Backwards-compatible flat list (used by probes/tests).
app.get('/api/sessions', (_req, res) => res.json(sessionsWithState()));

// Default name for a new agent: "<cli-label-slug>-<n>", e.g. claude-code-1.
function nextName(cli) {
  const base = slugify(cliById(cli).label) || cli;
  const re = new RegExp(`^${base}-(\\d+)$`);
  let max = 0;
  for (const s of store.list()) {
    const m = s.name.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${base}-${max + 1}`;
}

app.post('/api/sessions', (req, res) => {
  const { name, cli, groupId, path: reqPath, prompt } = req.body || {};
  if (!cli || !cliById(cli)) return res.status(400).json({ error: 'unknown cli' });
  const finalName = name && name.trim() ? name.trim() : nextName(cli);
  // Location: an explicit workspace-relative path. cleanRelPath('.') → '' =
  // the workspaces root. Omitted/blank paths also land at the root; folder
  // creation is explicit through the picker, not automatic.
  const chosen = cleanRelPath(typeof reqPath === 'string' && reqPath.trim() ? reqPath : '.');
  if (chosen === null) return res.status(400).json({ error: 'bad path' });
  const s = store.create({ name: finalName, cli, path: chosen });
  if (s.path) { try { fs.mkdirSync(workspacePath(s.path), { recursive: true }); } catch {} }
  if (groupId && groups.get(groupId)) groups.attach(groupId, s.id);
  else order.prepend(`s:${s.id}`);
  // Quickstart: the prompt rides the CLI's launch command itself (claude 'p',
  // codex 'p', …) so the agent starts already working on it — typing into a
  // booting TUI was a race that quietly lost. CLIs without an initial-prompt
  // flag keep the boot-then-type fallback.
  if (typeof prompt === 'string' && prompt.trim()) {
    const text = prompt.trim();
    if (cliById(cli).withPrompt || cli === 'claude') {
      store.update(s.id, { pendingPrompt: text });
      try { ensureRunning(store.get(s.id) || s); } catch (e) { console.error('[quickstart]', e && e.message); }
    } else {
      (async () => {
        try {
          ensureRunning(s);
          await new Promise((r) => setTimeout(r, 4000));
          await sendInput(s.id, text);
        } catch (e) { console.error('[quickstart]', e && e.message); }
      })();
    }
  }
  res.status(201).json({ ...s, running: false, state: 'stopped' });
});

// Rename = display label only. Folders are never renamed or moved.
app.put('/api/sessions/:id', (req, res) => {
  const name = (req.body || {}).name;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'bad name' });
  const existing = store.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  res.json(store.update(existing.id, { name: name.trim() }));
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  stop(s.id);
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  stop(s.id);
  groups.detachSession(s.id);
  order.drop(`s:${s.id}`);
  store.remove(s.id);
  res.json({ ok: true });
});

app.post('/api/groups', (req, res) => {
  const g = groups.create((req.body || {}).name);
  order.prepend(`g:${g.id}`);
  res.status(201).json(g);
});

app.put('/api/groups/:id', (req, res) => {
  const existing = groups.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  res.json(groups.update(existing.id, { ...(req.body || {}) }));
});

app.delete('/api/groups/:id', (req, res) => {
  const g = groups.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const idx = order.indexOf(`g:${g.id}`);
  const sids = g.sessionIds.slice();
  groups.remove(g.id);
  order.drop(`g:${g.id}`);
  // its sessions become loose, placed where the group was
  sids.forEach((sid, k) => order.insertAt(`s:${sid}`, (idx < 0 ? 0 : idx) + k));
  res.json({ ok: true });
});

// Single endpoint for every drag operation. `to` is an anchor:
//   { kind: 'into',  groupId }            attach a session to a group
//   { kind: 'pair',  sessionId }          drop a session on a session → group them
//   { kind: 'before'|'after', ref }       place adjacent to ref (top-level OR inside a group)
const splitRef = (r) => [r.slice(0, 1), r.slice(2)];
const removeSessionEverywhere = (sid) => { groups.detachSession(sid); order.drop(`s:${sid}`); };

app.post('/api/move', (req, res) => {
  const { ref, to } = req.body || {};
  if (typeof ref !== 'string' || !to) return res.status(400).json({ error: 'bad request' });
  const [t, id] = splitRef(ref);

  if (to.kind === 'into') {
    if (t !== 's' || !groups.get(to.groupId)) return res.status(400).json({ error: 'bad target' });
    order.drop(`s:${id}`);
    groups.attach(to.groupId, id);
  } else if (to.kind === 'pair') {
    if (t !== 's' || to.sessionId === id) return res.status(400).json({ error: 'bad pair' });
    if (!store.get(id) || !store.get(to.sessionId)) return res.status(400).json({ error: 'unknown session' });
    const tg = groups.groupOf(to.sessionId);
    if (tg) {
      order.drop(`s:${id}`);
      groups.attach(tg.id, id);
    } else {
      const g = groups.create('');
      groups.attach(g.id, to.sessionId);
      groups.attach(g.id, id);
      order.drop(`s:${id}`);
      order.replace(`s:${to.sessionId}`, `g:${g.id}`);
    }
  } else if (to.kind === 'before' || to.kind === 'after') {
    if (typeof to.ref !== 'string' || to.ref === ref) return res.status(400).json({ error: 'bad anchor' });
    const [tt, tid] = splitRef(to.ref);
    if (order.indexOf(to.ref) >= 0) {
      // top level, adjacent to anchor
      if (t === 's') removeSessionEverywhere(id); else order.drop(ref);
      let idx = order.indexOf(to.ref);
      if (idx < 0) idx = order.list().length;
      order.insertAt(ref, to.kind === 'after' ? idx + 1 : idx);
    } else if (tt === 's') {
      // anchor is a nested session → place inside its group
      if (t !== 's') return res.status(400).json({ error: 'cannot nest group' });
      const g = groups.groupOf(tid);
      if (!g) return res.status(400).json({ error: 'unknown anchor' });
      removeSessionEverywhere(id);
      let gi = g.sessionIds.indexOf(tid);
      if (gi < 0) gi = g.sessionIds.length;
      groups.attach(g.id, id, to.kind === 'after' ? gi + 1 : gi);
    } else {
      return res.status(400).json({ error: 'unknown anchor' });
    }
  } else {
    return res.status(400).json({ error: 'bad target' });
  }
  res.json({ ok: true });
});

// Serve the built frontend with SPA fallback.
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// Without these listeners a transport error (client reset, listen failure)
// throws out of the EventEmitter and crashes the process.
// A bind failure surfaces on both emitters; the server handler below owns it, so
// skip it here to keep one report and one exit.
wss.on('error', (e) => { if (e && e.syscall !== 'listen') console.error('[wss error]', e.message); });
server.on('error', (e) => {
  console.error('[server error]', e.message);
  // A failed listen leaves no handle, so the loop drains and node returns 0 —
  // the supervisor reads that as a clean stop and stays quiet, and the operator
  // reads "exit code: 0" as the Space crashing on its own. Fail loudly instead.
  // (Seen on Spaces dev mode: it restarts the app in the same container while
  // the previous, healthy node still holds the port.)
  if (e && e.syscall === 'listen') {
    console.error(`[fatal] cannot listen on :${PORT} — something else is probably already bound to it. Exiting 1.`);
    process.exit(1);
  }
});

// Only accept WebSockets from our own page. WS handshakes skip CORS entirely
// and the browser attaches cookies, so without this check any website could try
// a cross-site `new WebSocket('wss://<space>/ws')` and reach a shell with the
// visitor's HF credentials. No Origin header (curl, native clients) is allowed —
// those carry no ambient browser credentials.
function originAllowed(origin) {
  if (!origin) return true;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (process.env.SPACE_HOST) return host === process.env.SPACE_HOST;
  return host === 'localhost' || host === '127.0.0.1'; // local dev
}

wss.on('connection', (ws, req) => {
  ws.on('error', (e) => console.error('[ws error]', e && e.message)); // a client reset must not crash us
  if (!originAllowed(req.headers.origin)) {
    ws.close(1008, 'bad origin');
    return;
  }
  if (isPublic()) {
    try { ws.send('\r\n[locked: this Space is public — make it private to use the terminals]\r\n'); } catch {}
    ws.close();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('session');
  const cols = parseInt(url.searchParams.get('cols') || '80', 10);
  const rows = parseInt(url.searchParams.get('rows') || '24', 10);

  const session = id && store.get(id);
  if (!session) {
    ws.send('\r\n[session not found]\r\n');
    ws.close();
    return;
  }

  let handle;
  try {
    handle = attach(session, cols, rows);
  } catch (e) {
    ws.send(`\r\n[failed to start: ${e.message}]\r\n`);
    ws.close();
    return;
  }

  // tmux prints a bare "[exited]" line as its parting output — strip it (the
  // client shows a styled stopped-state instead) but pass everything else.
  const stripExit = (d) => (typeof d === 'string' ? d.replace(/(\r?\n)?\[exited\](\r?\n)?$/, '') : d);
  handle.onData((d) => {
    if (ws.readyState !== ws.OPEN) return;
    const out = stripExit(d);
    if (out.length) ws.send(out);
  });
  handle.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      // Our tmux client can die for two very different reasons, and the browser
      // must react differently to each:
      //   4001 = another device attached and tmux's -D detached us. The session
      //          is alive and now belongs to that device, so this client goes
      //          quiet instead of reconnecting (that would be a tug-of-war).
      //   4000 = the agent process itself exited. Do NOT auto-reconnect (it
      //          would respawn the agent in a loop); offer a Restart instead.
      const handedOff = USE_TMUX && isRunning(session.id);
      try {
        ws.close(handedOff ? 4001 : 4000, handedOff ? 'handedoff' : 'exited');
      } catch { ws.close(); }
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') handle.write(msg.d);
    else if (msg.t === 'r') handle.resize(msg.cols, msg.rows);
    else if (msg.t === 'copy') {
      const osc52 = copySelection(session.id);
      if (osc52 && ws.readyState === ws.OPEN) ws.send(osc52);
    }
  });

  // Register for copy-mode notifications (the frontend shows an overlay hint).
  registerModeClient(session.id, ws);
  ws.on('close', () => { handle.kill(); unregisterModeClient(session.id, ws); });
});

// Copy-mode indicator: tmux owns the mode (users scroll into it and find the
// keyboard "dead"), so poll it — one call for all panes — and push changes to
// attached clients as a control frame the terminal distinguishes from raw
// output by its leading NUL sentinel. Only polls while clients are attached.
const MODE_CTRL = '\x00\x00AM:'; // pty output never leads with this
const modeClients = new Map(); // sessionId -> Set(ws)
const lastMode = new Map();     // sessionId -> boolean
let modeTimer = null;
function registerModeClient(id, ws) {
  if (!USE_TMUX) return;
  if (!modeClients.has(id)) modeClients.set(id, new Set());
  modeClients.get(id).add(ws);
  // Send current state immediately so a client attaching mid-copy-mode is right.
  try { ws.send(MODE_CTRL + JSON.stringify({ t: 'mode', copy: !!lastMode.get(id) })); } catch {}
  if (!modeTimer) modeTimer = setInterval(pollModes, 350);
}
function unregisterModeClient(id, ws) {
  const set = modeClients.get(id);
  if (set) { set.delete(ws); if (!set.size) { modeClients.delete(id); lastMode.delete(id); } }
  if (!modeClients.size && modeTimer) { clearInterval(modeTimer); modeTimer = null; }
}
function pollModes() {
  const modes = paneModes();
  for (const [id, set] of modeClients) {
    const now = !!modes[id];
    if (lastMode.get(id) === now) continue;
    lastMode.set(id, now);
    const frame = MODE_CTRL + JSON.stringify({ t: 'mode', copy: now });
    for (const ws of set) if (ws.readyState === ws.OPEN) { try { ws.send(frame); } catch {} }
  }
}

generateEnvSkill(loadSecretNotes()); // keep the environment skill current on boot

// Warm ONLY the trace cache in the background (bounded: mtime-cached, tail-
// capped, yields between files). The usage warmup is deliberately NOT run at
// boot: buildUsage() spawns concurrent ccusage scans over the whole transcript
// history, and with large migrated transcripts that memory/CPU spike could
// destabilize a fresh container. The Usage page fetches per-provider on open
// (skeletons + stale-while-revalidate), so nothing is lost but the boot risk.
setTimeout(() => { traceDigests().catch(() => {}); }, 4000);

// Off-thread stall detector — must start early so it's watching before the
// first heavy build. Logs any event-loop wedge to the run logs (see watchdog.js).
startWatchdog();

server.listen(PORT, () => {
  console.log(`Agent Manager :${PORT}  tmux=${USE_TMUX}  data=${DATA_DIR}`);
  console.log('⚠  No authentication: this app trusts whoever can reach it.');
  console.log('   Keep this Space PRIVATE — a public instance gives anyone a shell + your logged-in agents.');
});
