import fs from 'node:fs';
import crypto from 'node:crypto';
import { SESSIONS_FILE } from './config.js';

let sessions = [];

function load() {
  try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (!Array.isArray(sessions)) sessions = [];
  } catch {
    sessions = [];
  }
}

function persist() {
  // A FUSE write hiccup must not throw out of a timer/handler and crash us.
  try {
    const tmp = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.error('[sessions.persist]', e && e.message); }
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'session'
  );
}

export function init() {
  load();
  let changed = false;
  for (const s of sessions) {
    if (!s.sessionUuid) { s.sessionUuid = crypto.randomUUID(); changed = true; }
  }
  if (changed) persist();
  // NOTE: `path` migration from the old folder/group-folder model happens in
  // index.js (it needs the groups store).
}

export function list() {
  return sessions.slice();
}

export function get(id) {
  return sessions.find((s) => s.id === id) || null;
}

export function create({ name, cli, path }) {
  const cleanName = (name || '').trim() || 'session';
  const id = `${slugify(cleanName)}-${crypto.randomBytes(3).toString('hex')}`;
  // `path` is the workspace-relative folder the agent runs in, chosen at
  // creation (or defaulted by the caller). It is a plain recorded value — the
  // display name can change freely without touching disk, and nothing tracks
  // the folder afterwards (deleted/moved folders are simply re-created empty on
  // next start). Files agents may use null = browse the whole workspace root.
  const session = {
    id,
    name: cleanName,
    cli,
    path: path ?? (cli === 'files' ? null : ''),
    // Stable per-session conversation id. Lets agents that share a folder (a
    // group) each resume their OWN conversation instead of all latching onto
    // the most-recent one in that directory.
    sessionUuid: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    everStarted: false,
  };
  sessions.push(session);
  persist();
  return session;
}

export function update(id, patch) {
  const s = get(id);
  if (!s) return null;
  Object.assign(s, patch);
  persist();
  return s;
}

export function remove(id) {
  const before = sessions.length;
  sessions = sessions.filter((s) => s.id !== id);
  if (sessions.length !== before) persist();
  // NOTE: the working directory under DATA_DIR/workspaces/<id> is intentionally
  // left on disk so a delete never destroys the user's files.
}
