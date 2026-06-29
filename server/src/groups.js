import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, allocFolder } from './config.js';

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
let groups = [];

function persist() {
  const tmp = `${GROUPS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(groups, null, 2));
  fs.renameSync(tmp, GROUPS_FILE);
}

export function init() {
  try {
    groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    if (!Array.isArray(groups)) groups = [];
  } catch {
    groups = [];
  }
  // Backfill: groups now own a shared workspace folder.
  let changed = false;
  for (const g of groups) {
    if (!g.folder) { g.folder = allocFolder(g.name); changed = true; }
  }
  if (changed) persist();
}

export function list() {
  return groups.slice();
}

export function get(id) {
  return groups.find((g) => g.id === id) || null;
}

export function create(name) {
  const clean = (name || '').trim() || 'Group';
  const g = {
    id: `g-${crypto.randomBytes(3).toString('hex')}`,
    name: clean,
    sessionIds: [],
    folder: allocFolder(clean),
    createdAt: new Date().toISOString(),
  };
  groups.push(g);
  persist();
  return g;
}

export function update(id, { name, sessionIds, folder }) {
  const g = get(id);
  if (!g) return null;
  if (typeof name === 'string' && name.trim()) g.name = name.trim();
  if (typeof folder === 'string' && folder) g.folder = folder;
  if (Array.isArray(sessionIds)) {
    // Enforce single-group membership: drop these ids from every other group.
    const set = new Set(sessionIds);
    for (const other of groups) {
      if (other.id !== id) other.sessionIds = other.sessionIds.filter((s) => !set.has(s));
    }
    g.sessionIds = [...new Set(sessionIds)];
  }
  persist();
  return g;
}

export function remove(id) {
  groups = groups.filter((g) => g.id !== id);
  persist();
}

/** Attach a session to a group at an optional index, removing it from any other group. */
export function attach(groupId, sessionId, index) {
  const g = get(groupId);
  if (!g) return null;
  for (const other of groups) other.sessionIds = other.sessionIds.filter((s) => s !== sessionId);
  const at = Number.isInteger(index) && index >= 0 && index <= g.sessionIds.length ? index : g.sessionIds.length;
  g.sessionIds.splice(at, 0, sessionId);
  persist();
  return g;
}

/** Which group (if any) currently contains this session. */
export function groupOf(sessionId) {
  return groups.find((g) => g.sessionIds.includes(sessionId)) || null;
}

/** Remove a session from every group (used on session delete). */
export function detachSession(sessionId) {
  let changed = false;
  for (const g of groups) {
    const next = g.sessionIds.filter((s) => s !== sessionId);
    if (next.length !== g.sessionIds.length) {
      g.sessionIds = next;
      changed = true;
    }
  }
  if (changed) persist();
}

/** Drop ids that no longer correspond to a live session. */
export function prune(validIds) {
  const valid = new Set(validIds);
  let changed = false;
  for (const g of groups) {
    const next = g.sessionIds.filter((s) => valid.has(s));
    if (next.length !== g.sessionIds.length) {
      g.sessionIds = next;
      changed = true;
    }
  }
  if (changed) persist();
}
