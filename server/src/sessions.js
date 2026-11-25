import crypto from 'node:crypto';
import { SESSIONS_FILE } from './config.js';
import { createJsonStore } from './json-store.js';

const store = createJsonStore(SESSIONS_FILE, {
  empty: () => [],
  validate(parsed) {
    if (!Array.isArray(parsed)) throw new TypeError('sessions.json must contain a JSON array');
    return parsed;
  },
});

let sessions = [];

export const isPoisoned = () => store.isPoisoned();

function load() {
  sessions = store.load();
}

function persist() {
  // A FUSE write hiccup (or a poisoned boot read) must not throw out of a
  // timer/handler and crash us; when poisoned, store.save() refuses to clobber.
  try {
    store.save(sessions);
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

export function create({ name, cli, path, model, effort }) {
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
    // The model / reasoning effort chosen at creation, passed as flags on
    // every launch (config.js launchFlags). Absent = the CLI's default.
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
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

// Shared archive is a visibility decision, not a process stop. A failed write
// must not acknowledge that decision or mutate the in-memory session first.
export function setArchived(id, archived) {
  const current = get(id);
  if (!current) return null;
  const nextSession = {
    ...current,
    archivedAt: archived ? new Date().toISOString() : undefined,
    ...(archived ? { pinnedAt: undefined } : {}),
  };
  const next = sessions.map((s) => (s.id === id ? nextSession : s));
  store.save(next, { onRenamed: () => { sessions = next; } });
  return nextSession;
}

// Imports are references, never fresh agents. Persist the fail-closed launch
// marker before attempting a separate binding write. A crash between the two
// writes leaves a repairable reference that cannot start a standalone TUI.
export function createCodexReference({ name, path, threadId }) {
  const session = {
    id: `codex-shared-${crypto.randomBytes(6).toString('hex')}`,
    name, path, cli: 'codex', sessionUuid: crypto.randomUUID(),
    codexSessionId: threadId, codexSharedOnly: true, everStarted: true,
    createdAt: new Date().toISOString(),
  };
  const next = [...sessions, session];
  // Also keep the protective record if directory fsync fails after rename.
  store.save(next, { onRenamed: () => { sessions = next; } });
  return session;
}

export function remove(id) {
  const before = sessions.length;
  sessions = sessions.filter((s) => s.id !== id);
  if (sessions.length !== before) persist();
  // NOTE: the working directory under DATA_DIR/workspaces/<id> is intentionally
  // left on disk so a delete never destroys the user's files.
}

// Keep the original AM identity, name, folder, group references and history pin.
// Never acknowledge a migration guard before its durable replacement succeeds.
export function prepareCodexMigration(id, migration) {
  const current = get(id);
  if (!current || current.cli !== 'codex' || current.codexSessionId !== migration.threadId) {
    throw new Error('Migration identity changed');
  }
  const session = { ...current, codexSharedOnly: true, codexMigration: migration };
  const next = sessions.map((s) => (s.id === id ? session : s));
  store.save(next, { onRenamed: () => { sessions = next; } });
  return session;
}
