import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  PORT, PUBLIC_DIR, DATA_DIR, WORKSPACES_DIR, SKILLS_DIR, USE_TMUX, TMUX_AVAILABLE,
  ensureDirs, cliCatalog, cliById, slugify, renameFolderTo, workspacePath, refreshVersions,
} from './config.js';
import * as store from './sessions.js';
import * as groups from './groups.js';
import * as order from './order.js';
import { attach, agentInfo, deriveState, stop } from './runner.js';
import { buildUsage } from './usage.js';
import { startVisibilityWatch, isPublic, visibility } from './visibility.js';

ensureDirs();
refreshVersions();
store.init();
groups.init();
order.init();

// Empty dirs don't reliably persist on the bucket (object storage) across
// restarts, so re-create every agent/group workspace folder on the mount so the
// Files agent always sees them.
function ensureWorkspaceFolders() {
  for (const g of groups.list()) {
    if (g.folder) fs.mkdirSync(workspacePath(g.folder), { recursive: true });
  }
  const grouped = new Set(groups.list().flatMap((g) => g.sessionIds));
  for (const s of store.list()) {
    if (s.folder && s.cli !== 'files' && !grouped.has(s.id)) {
      fs.mkdirSync(workspacePath(s.folder), { recursive: true });
    }
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

startVisibilityWatch();

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

app.get('/api/usage', (req, res) => res.json(buildUsage(req.query.debug === '1')));

const hfToken = () => process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || null;

// Env var names that existed at build time (baked in by the Dockerfile). Names
// present at runtime but NOT here were injected by HF → the Space's secrets and
// variables. We never read their values, only report the names.
const BUILD_ENV_KEYS = (() => {
  try {
    return new Set(fs.readFileSync('/app/build-env-keys.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return null; }
})();
// Platform/runtime vars that aren't user secrets (set by HF / k8s / our entrypoint).
const NON_SECRET = new Set([
  'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NPM_CONFIG_PREFIX', 'PWD', 'OLDPWD', 'SHLVL', '_', 'HOSTNAME',
  'ACCELERATOR', 'COMMIT_SHA', 'CPU_CORES', 'HF_DATASETS_TRUST_REMOTE_CODE', 'IMAGE_SHA', 'MEMORY', 'OMP_NUM_THREADS',
]);
const NON_SECRET_PREFIX = ['SPACE_', 'KUBERNETES_', 'NVIDIA_', 'CUDA_', 'NV_'];
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
  canRelaunch: !!(process.env.SPACE_ID && hfToken()),
  secrets: injectedEnvKeys(),
}));

// Factory-reboot the Space: rebuilds the image (reinstalling the CLIs at their
// latest published versions, per the Dockerfile) and relaunches everything.
// Needs an HF token with write access set as a Space secret (HF_TOKEN).
app.post('/api/relaunch', async (_req, res) => {
  const id = process.env.SPACE_ID;
  const token = hfToken();
  if (!id) return res.json({ ok: false, reason: 'no-space' });
  if (!token) return res.json({ ok: false, reason: 'no-token' });
  try {
    const r = await fetch(`https://huggingface.co/api/spaces/${id}/restart?factory=true`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.json({ ok: false, reason: `http-${r.status}` });
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: false, reason: String(e.message || e) }); }
});

// ---------- secrets: describe each injected secret/variable, feed a skill ----------
const SECRET_NOTES_FILE = path.join(DATA_DIR, 'secret-notes.json');
function loadSecretNotes() {
  try { return JSON.parse(fs.readFileSync(SECRET_NOTES_FILE, 'utf8')); } catch { return {}; }
}
// (Re)build the "environment" skill so every agent knows which env vars exist
// and what they're for. Values are never written — only names + descriptions.
function generateEnvSkill(notes) {
  const keys = injectedEnvKeys();
  if (!keys.length) { undistributeSkill('environment.md'); try { fs.rmSync(skillPath('environment.md')); } catch {} return; }
  const lines = keys.map((k) => `- \`${k}\`${notes[k] ? ` — ${notes[k]}` : ''}`);
  const content = `---
name: environment
description: "Environment variables configured in this Space and what they're for."
---

# Available environment variables

These are set in the Space and available to every agent here. Read a value from
the environment when you need it (e.g. \`$NAME\`); never print secret values.

${lines.join('\n')}
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
// skill is available to all of them in every new session.
function skillTargetDirs() {
  const home = process.env.HOME || os.homedir();
  const claudeCfg = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return [
    path.join(home, '.agents', 'skills'),   // Codex, Gemini, opencode
    path.join(claudeCfg, 'skills'),          // Claude Code
    path.join(home, '.hermes', 'skills'),    // Hermes
  ];
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
  // The Files agent browses the whole workspace root (every agent's folder).
  if (session.cli === 'files') return WORKSPACES_DIR;
  const g = groups.groupOf(session.id);
  return workspacePath((g ? g.folder : session.folder) || session.id);
}
function resolveSafe(root, rel) {
  const p = path.resolve(root, rel || '.');
  return (p === root || p.startsWith(root + path.sep)) ? p : null;
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

app.post('/api/files/:id/upload', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  const s = store.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const dir = resolveSafe(folderPathOf(s), req.query.path);
  const name = String(req.query.name || '');
  if (!dir || !name || name.includes('/') || name.includes('..')) return res.status(400).json({ error: 'bad path' });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const sessions = sessionsWithState();
  const groupList = groups.list();
  const groupedIds = new Set(groupList.flatMap((g) => g.sessionIds));
  const loose = store.list().filter((s) => !groupedIds.has(s.id));
  const refsMeta = [
    ...groupList.map((g) => ({ ref: `g:${g.id}`, t: g.createdAt || '' })),
    ...loose.map((s) => ({ ref: `s:${s.id}`, t: s.createdAt })),
  ].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0)); // newest first
  order.normalize(refsMeta.map((x) => x.ref));
  res.json({ order: order.list(), groups: groupList, sessions });
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
  const { name, cli, groupId } = req.body || {};
  if (!cli || !cliById(cli)) return res.status(400).json({ error: 'unknown cli' });
  const finalName = name && name.trim() ? name.trim() : nextName(cli);
  const s = store.create({ name: finalName, cli });
  if (groupId && groups.get(groupId)) groups.attach(groupId, s.id);
  else order.prepend(`s:${s.id}`);
  res.status(201).json({ ...s, running: false, state: 'stopped' });
});

app.put('/api/sessions/:id', (req, res) => {
  const name = (req.body || {}).name;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'bad name' });
  const existing = store.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const patch = { name: name.trim() };
  // A loose agent owns its folder, so rename it to match. (Grouped agents share
  // the group's folder, which is renamed with the group instead.)
  if (!groups.groupOf(existing.id)) patch.folder = renameFolderTo(existing.folder, name.trim());
  res.json(store.update(existing.id, patch));
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
  const patch = { ...(req.body || {}) };
  // Rename the group's shared folder to match a new name.
  if (typeof patch.name === 'string' && patch.name.trim() && patch.name.trim() !== existing.name) {
    patch.folder = renameFolderTo(existing.folder, patch.name.trim());
  }
  res.json(groups.update(existing.id, patch));
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

wss.on('connection', (ws, req) => {
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

  handle.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  handle.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send('\r\n[process exited]\r\n');
      // 4000 = real process exit. The client uses this to NOT auto-reconnect
      // (which would respawn the agent in a loop); it offers a Restart instead.
      try { ws.close(4000, 'exited'); } catch { ws.close(); }
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') handle.write(msg.d);
    else if (msg.t === 'r') handle.resize(msg.cols, msg.rows);
  });

  ws.on('close', () => handle.kill());
});

generateEnvSkill(loadSecretNotes()); // keep the environment skill current on boot

server.listen(PORT, () => {
  console.log(`Agent Manager :${PORT}  tmux=${USE_TMUX}  data=${DATA_DIR}`);
  console.log('⚠  No authentication: this app trusts whoever can reach it.');
  console.log('   Keep this Space PRIVATE — a public instance gives anyone a shell + your logged-in agents.');
});
