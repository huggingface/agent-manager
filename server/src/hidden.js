// Refs the operator has hidden from the Overview.
//
// A deliberate, standing choice — "I don't want to see the cats group when I'm
// looking at my fleet" — and therefore NOT the same thing as archiving, which is
// derived from how long a session has been quiet and expires by itself. Hiding
// never expires, never depends on state, and hides a group whose agents are
// working right now if that is what you asked for.
//
// It lives on the server rather than in localStorage because it is a fact about
// the fleet, not about the browser looking at it: hide the group on the desktop
// and it stays hidden on the phone. (Contrast the Overview's sort and view, which
// are per-browser localStorage — those describe how you are looking, not what is
// worth looking at.)
//
// Scope: the OVERVIEW only. The sidebar still lists everything, which is both the
// way back to a hidden group and the reason hiding can never lose an agent.
//
// The stored values are the same refs `tree.order` speaks — `g:<id>` for a group,
// `s:<id>` for a loose session — so one list covers "hide this whole group" and
// "hide this one agent" without a second concept.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'overview-hidden.json');
let refs = new Set();

const REF_RE = /^[gs]:[A-Za-z0-9._-]+$/;

function persist() {
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...refs], null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[hidden.persist]', e && e.message);
  }
}

export function init() {
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    refs = new Set(Array.isArray(p) ? p.filter((r) => typeof r === 'string' && REF_RE.test(r)) : []);
  } catch { refs = new Set(); }   // no file yet → nothing hidden
}

export const list = () => [...refs];
export const has = (ref) => refs.has(ref);

/** Hide or unhide one ref. Returns false for anything that isn't a ref. */
export function set(ref, hidden) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return false;
  if (hidden) refs.add(ref); else refs.delete(ref);
  persist();
  return true;
}

/**
 * Drop refs that no longer name anything, given the live set.
 *
 * Self-cleaning on read rather than a hook on every delete path: a group can stop
 * existing in more ways than the delete endpoint (an edited groups.json, a
 * restore, a bucket that lost a write), and a stale ref that outlives its group
 * would silently hide a NEW group that later reuses the id. Only persists when
 * something actually went away.
 *
 * Feed it EVERY live group and session, not the refs `tree.order` happens to
 * hold: order lists loose sessions only, so a hidden agent that gets dragged into
 * a group would otherwise quietly un-hide itself. And feed it the unfiltered
 * lists — under demo mode the visible tree is a subset, and pruning against that
 * would erase the operator's choices for everything demo mode is covering up.
 */
export function retain(validRefs) {
  const live = validRefs instanceof Set ? validRefs : new Set(validRefs);
  let dropped = false;
  for (const r of refs) if (!live.has(r)) { refs.delete(r); dropped = true; }
  if (dropped) persist();
  return dropped;
}
