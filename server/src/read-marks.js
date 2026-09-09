import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// What the operator has already read.
//
// One mark per session: the exact output version they were last shown. Unread
// is then a comparison — "is the newest reply the one they have seen?" — rather
// than a flag anyone has to remember to clear.
//
// Server-side because the answer has to be the same on the operator's phone as
// on their laptop, and has to survive a refresh. A browser can cache it; it
// cannot be the authority.
//
// A mark is {src, seq, hash}:
//   src  — which transcript generation it belongs to. When a session's trace is
//          replaced (codex repins a rollout on a new run) the old mark cannot
//          be read as covering the new file's replies, which start again at 1.
//   seq  — how far through that transcript's replies the operator has read.
//          Only ever moves forward, which is what makes a late or duplicated
//          request harmless.
//   hash — of the exact text shown. Two acknowledgements at the same seq can
//          still describe different content when a streaming answer grew, and
//          the newer one has not been read.

const FILE = path.join(DATA_DIR, 'read-marks.json');
let state = { initialized: false, marks: {} };

// Write first, adopt second. The in-memory copy is what /api/meta answers from,
// so promoting it before the file lands would publish a reply as read that a
// restart brings back unread — and the caller would have been told it failed.
// Nothing here mutates `state` unless the bytes are on disk.
function commit(next) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  state = next;
}

export function init() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = {
      initialized: !!parsed.initialized,
      marks: parsed.marks && typeof parsed.marks === 'object' ? parsed.marks : {},
    };
  } catch {
    state = { initialized: false, marks: {} };
  }
}

/** Has the one-time rollout baseline been taken? */
export function initialized() { return state.initialized; }

export function get(id) { return state.marks[id] || null; }

export function all() { return { ...state.marks }; }

const validMark = (m) => !!m
  && typeof m.src === 'string'
  && Number.isInteger(m.seq) && m.seq >= 0
  && typeof m.hash === 'string' && m.hash.length <= 64;

/**
 * Record that `mark` was shown for this session, against the output the server
 * currently believes is newest (`latest`).
 *
 * Returns the outcome rather than throwing, because a rejection here is an
 * ordinary answer — "that is not what is on screen any more" — and the caller
 * has to be able to tell it apart from a write that failed.
 *
 *   'ok'       — recorded (or already covered, which is the same outcome)
 *   'stale'    — describes output older than what is already acknowledged, or a
 *                generation that is no longer current. Progress never moves back.
 *   'future'   — claims to have seen further than the newest output that
 *                exists. A client cannot acknowledge what the server has not
 *                produced.
 *   'mismatch' — the right position but not the right content: a streaming
 *                answer moved on between rendering and acknowledging. The
 *                operator saw the old one, so the new one stays unread.
 */
export function acknowledge(id, mark, latest) {
  if (!validMark(mark)) return 'invalid';
  if (!latest || !latest.src) return 'unknown';
  // A mark from a previous run of the transcript says nothing about this one.
  if (mark.src !== latest.src) return 'stale';
  if (mark.seq > latest.seq) return 'future';
  if (mark.seq === latest.seq && mark.hash !== latest.hash) return 'mismatch';
  // Does this mark name exactly what is newest right now? That claim is always
  // recordable, even when the stored cursor carries a HIGHER number: a rotated
  // or replaced transcript restarts its sequence, and refusing the new, lower
  // one as "stale" would leave real new output permanently unacknowledgeable.
  const exact = mark.seq === latest.seq && mark.hash === latest.hash;

  const cur = state.marks[id];
  if (cur && cur.src === mark.src && !exact) {
    // Monotonic within a generation: a late or reordered request cannot undo
    // reading the operator has already done.
    if (cur.seq > mark.seq) return 'stale';
  }
  if (cur && cur.src === mark.src && cur.seq === mark.seq && cur.hash === mark.hash) {
    // Already recorded AND already on disk — `state` is only ever adopted from a
    // completed write, so this shortcut cannot stand in for one that failed.
    return 'ok';
  }
  commit({ ...state, marks: { ...state.marks, [id]: { src: mark.src, seq: mark.seq, hash: mark.hash, at: new Date().toISOString() } } });
  return 'ok';
}

/**
 * The one-time rollout baseline: everything that exists right now counts as
 * read, so turning this on does not declare the operator's whole history
 * unread.
 *
 * Takes exact observed versions, not a wall-clock cutoff — a reply landing
 * while this is being written is newer than the versions captured here, so it
 * stays eligible for Unread instead of being swallowed by a timestamp.
 *
 * Runs once ever. A session with no readable output yet is skipped rather than
 * marked read at seq 0, so its first reply is unread rather than presumed seen.
 */
export function baseline(latestById) {
  if (state.initialized) return false;
  const marks = { ...state.marks }, at = new Date().toISOString();
  for (const [id, latest] of latestById) {
    if (!latest || !latest.src || !latest.seq) continue;
    marks[id] = { src: latest.src, seq: latest.seq, hash: latest.hash, at };
  }
  // Same rule as acknowledge: the flag and the marks become true together, and
  // only once the file holds them. A failed write leaves the baseline untaken,
  // so the next poll retries it rather than starting to track from a moment
  // nothing recorded.
  commit({ ...state, initialized: true, marks });
  return true;
}

/** Drop marks for sessions that no longer exist. Renaming or moving a session
 *  keeps its id, and so keeps its mark. */
export function retain(validIds) {
  const marks = {};
  let changed = false;
  for (const [id, mark] of Object.entries(state.marks)) {
    if (validIds.has(id)) marks[id] = mark; else changed = true;
  }
  if (changed) commit({ ...state, marks });
}
