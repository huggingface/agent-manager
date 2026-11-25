import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, PASSIVE_CLIS } from './config.js';
import { findByName, normalizeName } from './agent-list.js';
import { createJsonStore } from './json-store.js';
import * as sessions from './sessions.js';

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const store = createJsonStore(GROUPS_FILE, {
  empty: () => [],
  validate(parsed) {
    if (!Array.isArray(parsed)) throw new TypeError('groups.json must contain a JSON array');
    return parsed;
  },
});
let groups = [];

export const isPoisoned = () => store.isPoisoned();

function persist() {
  try {
    store.save(groups);
  } catch (e) { console.error('[groups.persist]', e && e.message); }
}

// Groups are purely VISUAL: sidebar organization + tiling. They own no folder —
// each session records its own `path`. (Old groups.json entries may still carry
// a `folder` key; it's kept for the one-time path migration in index.js and
// otherwise ignored.)
// Membership revokes an individual pin, and it has to do so by CLEARING it.
//
// The rule is that a session inside a group cannot be pinned — the group is the
// thing that gets pinned, and its members inherit what that buys. A `pinnedAt`
// left behind on a member is not inert: every read that suppresses it is
// conditioned on the session being grouped, so the value comes back to life the
// moment the session leaves the group, by any of the ways it can (dragged out,
// the group deleted, an anchor move, a tree edit that drops it). The operator
// then sees a row lift above the rule because of a pin they set before it was
// grouped and have had no way to see or change since.
//
// So it is cleared here, where membership is written, rather than guarded at
// each of the places membership can end. This is the only choke point: every
// route that groups a session goes through attach() or update().
function clearMemberPins(ids) {
  for (const id of ids) {
    const s = sessions.get(id);
    if (s && s.pinnedAt) sessions.update(id, { pinnedAt: undefined });
  }
}

export function init() {
  groups = store.load();
  // Records written before membership cleared pins can still carry one. Fix
  // them on load rather than leaving a pin that springs back on the way out.
  for (const g of groups) clearMemberPins(g.sessionIds || []);
}

export function list() {
  return groups.slice();
}

export function get(id) {
  return groups.find((g) => g.id === id) || null;
}

export function create(name, { path: groupPath } = {}) {
  const clean = (name || '').trim() || 'Group';
  const g = {
    id: `g-${crypto.randomBytes(3).toString('hex')}`,
    name: clean,
    sessionIds: [],
    ...(typeof groupPath === 'string' ? { path: groupPath } : {}),
    createdAt: new Date().toISOString(),
  };
  groups.push(g);
  persist();
  return g;
}

export function update(id, { name, sessionIds, layout, path: groupPath } = {}) {
  const g = get(id);
  if (!g) return null;
  if (typeof name === 'string' && name.trim()) g.name = name.trim();
  if (groupPath !== undefined) {
    if (groupPath === null) delete g.path;
    else if (typeof groupPath === 'string') g.path = groupPath;
  }
  // Tile layout: {cols, rows} each 1..3; anything else (incl. null) = auto.
  if (layout !== undefined) {
    const ok = layout && Number.isInteger(layout.cols) && Number.isInteger(layout.rows)
      && layout.cols >= 1 && layout.cols <= 3 && layout.rows >= 1 && layout.rows <= 3;
    if (ok) g.layout = { cols: layout.cols, rows: layout.rows };
    else delete g.layout;
  }
  if (Array.isArray(sessionIds)) {
    // Enforce single-group membership: drop these ids from every other group.
    const set = new Set(sessionIds);
    for (const other of groups) {
      if (other.id !== id) other.sessionIds = other.sessionIds.filter((s) => !set.has(s));
    }
    g.sessionIds = [...new Set(sessionIds)];
    clearMemberPins(g.sessionIds);
  }
  persist();
  return g;
}

/**
 * Effective workspace-relative folder for a group: its stored `g.path` if defined,
 * else the non-empty `path` of its non-passive member sessions, else `undefined`.
 */
export function effectivePath(groupOrId) {
  const g = typeof groupOrId === 'string' ? get(groupOrId) : groupOrId;
  if (!g) return undefined;
  if (typeof g.path === 'string') return g.path;
  if (Array.isArray(g.sessionIds) && g.sessionIds.length > 0) {
    for (const sid of g.sessionIds) {
      const s = sessions.get(sid);
      if (s && !PASSIVE_CLIS.includes(s.cli) && typeof s.path === 'string' && s.path) {
        return s.path;
      }
    }
  }
  return undefined;
}

// Pinned is a standing choice about where the group sits and whether its
// members age out, so it is stored on the record beside the name — not derived,
// and not part of update()'s field set, which is the shape the tree editor
// sends and would clear a pin it never knew about.
export function setPinned(id, pinned) {
  const g = get(id);
  if (!g) return null;
  if (pinned) g.pinnedAt = new Date().toISOString();
  else delete g.pinnedAt;
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
  clearMemberPins([sessionId]);
  persist();
  return g;
}

/** Which group (if any) currently contains this session. */
export function groupOf(sessionId) {
  return groups.find((g) => g.sessionIds.includes(sessionId)) || null;
}

/**
 * Which group a newly spawned session should join, for the agent-facing spawn
 * API. Mirrors how that route picks a folder: omitted means "same as the caller",
 * because a peer you spawn is usually working on the same thing you are.
 *
 * `requested` is the raw ?group= value: omitted/blank inherits the caller's
 * group, 'none' opts out and leaves the session loose in the sidebar, and
 * anything else names a group — by id, or by the display name, which is the
 * only form an agent ever sees (GET /api/agents reports `group` as a name).
 *
 * Returns {groupId} (null = ungrouped) or {error} for a name that matches
 * nothing. An unknown group is refused rather than created: the sidebar is the
 * operator's, and a typo should be loud instead of quietly fragmenting it.
 */
export function resolveSpawnGroup(requested, callerId) {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) {
    const g = groupOf(callerId);
    return { groupId: g ? g.id : null };
  }
  if (normalizeName(raw) === 'none') return { groupId: null };
  const byId = get(raw);
  if (byId) return { groupId: byId.id };
  let byName;
  try { byName = findByName(groups, raw); }
  catch (e) { return { error: e.message }; }
  if (byName) return { groupId: byName.id };
  const known = groups.map((g) => g.name).filter(Boolean).join(', ');
  return { error: `unknown group '${raw}'${known ? ` — groups here: ${known}` : ' — no groups exist yet'}; pass group=none to stay ungrouped` };
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
