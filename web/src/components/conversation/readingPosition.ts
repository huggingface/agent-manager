// Where you had got to in a conversation.
//
// The reader keeps no memory of this, so every cold mount opens on the end of the
// trace (§3.3, and #55) — better than the top it used to open on, but still not
// the place you had scrolled to. In-app navigation happens to survive, because
// the pane stays mounted and the browser preserves the scroll box across the
// `display: none` that hides a warm tile; that is why this looks fine on a
// desktop and not on a phone, where coming back is a reload, an evicted tab, or
// the Hub rebuilding the Space's iframe. Same layer as drafts.ts, same reason.
//
// The anchor is a **turn timestamp**, and that choice is forced by how the reader
// reads. It holds a byte window of the transcript and pages backwards, and when
// an older window arrives the exchanges REGROUP: an exchange at the top of the
// list is a fragment whose prompt was in the window not yet read, and the two
// become one exchange when it lands. So neither the React key, nor an index into
// the list, nor a pixel offset identifies a place for longer than one fetch. A
// turn's `ts` comes from the transcript and never moves. `off` then only carries
// where inside that turn you were.
//
// `end` is the case that matters most: if you were reading the tail and the agent
// added six turns while you were away, you want the new bottom, not the row that
// used to be at the bottom.

const KEY = 'am.reading';
const VERSION = 2;

/**
 * How many sessions' positions to keep. Each entry is a few dozen bytes, so this
 * is about not growing without bound rather than about the storage budget.
 * Unlike a draft this never expires: a reading position is not text you typed, so
 * it carries nothing worth forgetting for its own sake, and it stays useful for
 * exactly as long as the conversation does.
 */
const MAX_ENTRIES = 100;

export interface Reading {
  /** `ts` of the turn that opened the exchange at the top of the reading area. */
  ts: number;
  /** How far below the reading area's top edge that exchange started, in px. */
  off: number;
  /** You were at the end of the conversation — follow the end, not the turn. */
  end: boolean;
}

interface Entry { t: number; o: number; e: 0 | 1; at: number }
type Store = Record<string, Entry>;

const mem = new Map<string, Reading>();

// Same reason as drafts.ts: `at` orders the set as well as dating it, and
// Date.now() cannot separate two writes in the same millisecond.
let stamped = 0;
const stamp = () => {
  stamped = Math.max(Date.now(), stamped + 1);
  return stamped;
};

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { v?: number; d?: Store };
    // A v1 blob anchored on an absolute turn number, which the windowed reader
    // cannot resolve. Not upgradeable; dropped, and the next write replaces it.
    if (parsed?.v !== VERSION || !parsed.d || typeof parsed.d !== 'object') return {};
    const out: Store = {};
    for (const [id, e] of Object.entries(parsed.d)) {
      if (e && typeof e.t === 'number' && typeof e.o === 'number' && typeof e.at === 'number') out[id] = e;
    }
    return out;
  } catch {
    // Denied (private mode, a third-party iframe under tracking prevention) or
    // nonsense under our key. No remembered positions, which is where we were.
    return {};
  }
}

function save(store: Store) {
  // Newest first; the tail past MAX_ENTRIES falls off, so the session you are
  // reading right now is the last thing to go.
  const byNewest = Object.entries(store).sort((a, b) => b[1].at - a[1].at);
  let out: Store = Object.fromEntries(byNewest.slice(0, MAX_ENTRIES));
  // A scroll position is never worth an exception on the way past. If the quota
  // is full — of other things, mostly — shed the oldest and try again, then give
  // up in silence.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VERSION, d: out }));
      return;
    } catch {
      const oldest = Object.keys(out).sort((a, b) => out[a].at - out[b].at)[0];
      if (!oldest) {
        try { localStorage.removeItem(KEY); } catch { /* nothing left to try */ }
        return;
      }
      const next = { ...out };
      delete next[oldest];
      out = next;
    }
  }
}

/** Where this session was last being read, or null if we have never seen it. */
export function recallReading(id: string): Reading | null {
  const held = mem.get(id);
  if (held) return held;
  const e = load()[id];
  if (!e) return null;
  const r: Reading = { ts: e.t, off: e.o, end: !!e.e };
  mem.set(id, r);
  return r;
}

export function rememberReading(id: string, r: Reading | null) {
  if (!r) {
    mem.delete(id);
    const store = load();
    delete store[id];
    save(store);
    return;
  }
  mem.set(id, r);
  const store = load();
  store[id] = { t: Math.round(r.ts), o: Math.round(r.off), e: r.end ? 1 : 0, at: stamp() };
  save(store);
}
