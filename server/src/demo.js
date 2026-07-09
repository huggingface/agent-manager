// Demo mode: a pure view filter. Activating snapshots the session and group IDs
// that exist right now and hides them from the sidebar/overview, so the Space
// reads like a fresh install (empty workspace + welcome). Nothing is deleted —
// tmux sessions keep running, logins and secrets stay valid — and anything
// created *after* activation shows through (it isn't in the snapshot).
// Deactivating clears the snapshot and every real session reappears untouched.
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'demo.json');
let state = { active: false, sessions: [], groups: [] };

export function init() {
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { active: !!p.active, sessions: p.sessions || [], groups: p.groups || [] };
  } catch { /* no file yet → inactive */ }
}

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(state)); }
  catch (e) { console.error('[demo.persist]', e && e.message); }
}

export const active = () => state.active;
export const hiddenSessions = () => new Set(state.sessions);
export const hiddenGroups = () => new Set(state.groups);

// Snapshot the currently-visible sessions/groups as the hidden set.
export function activate(sessionIds, groupIds) {
  state = { active: true, sessions: [...sessionIds], groups: [...groupIds] };
  persist();
}

export function deactivate() {
  state = { active: false, sessions: [], groups: [] };
  persist();
}
