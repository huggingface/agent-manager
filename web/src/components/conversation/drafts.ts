// What the composer remembers when you walk away from it.
//
// Reported from a phone: open an agent's reader, start typing a reply, switch
// apps or lock the screen, come back — the text is gone. Two layers can lose it,
// and only one of them turned out to be guilty:
//
//   · The pane does NOT unmount on an in-app trip back to the session list —
//     App.tsx keeps a dozen terminal panes warm, reader and composer included —
//     so React state alone already survives that. Measured on `main`, not assumed.
//   · What kills it is the DOCUMENT going away: a reload, a backgrounded tab
//     evicted under memory pressure, and the Hub rebuilding the Space's iframe
//     on every visit. Coming back is a cold mount, not a resume.
//
// So in-memory state cannot be the answer, and neither can the URL (the Hub owns
// the iframe's src). It has to be storage, written through on every keystroke —
// a phone killing a backgrounded tab does not reliably run unload handlers.
//
// Same shape as filesMemory.ts, with one deliberate difference: every draft
// lives in ONE key rather than one key per session, because the two things that
// have to stay bounded — total bytes, and how long a draft may sit around — are
// properties of the whole set, and enumerating per-session keys to enforce them
// is how you end up with an unbounded pile nobody sweeps.
const KEY = 'am.drafts';
const VERSION = 1;

/**
 * Per draft. A reply is a message, not a file: past this you have pasted a log
 * into the box, and it stays in memory (so a pane switch is still lossless)
 * without being written to a ~5 MB budget shared with the whole app.
 */
const MAX_TEXT = 32 * 1024;
/** Every draft, together. The oldest fall off the end first. */
const MAX_TOTAL = 128 * 1024;
/**
 * A draft is text you typed and never sent, sitting in the storage of whatever
 * device you typed it on — which on a phone is not always only yours. A day is
 * long enough to cover the case this exists for (you left, you came back) and
 * short enough that last week's half-written answer is not still recoverable
 * from the browser. Sending clears it immediately; this is only the floor.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Entry { t: string; at: number }
type Store = Record<string, Entry>;

// First line of defence: a pane switch stays lossless even where storage is
// denied outright (private mode, or a third-party iframe under cross-site
// tracking prevention). Storage is the second line — it is what survives the
// document.
const mem = new Map<string, string>();

/**
 * `at` orders the set as well as dating it, and Date.now() is not fine-grained
 * enough to order two drafts saved in the same millisecond — which is how an
 * eviction pass ends up shedding an arbitrary one instead of the oldest. This
 * only ever moves forward, so it stays a timestamp (to the millisecond, for
 * expiry) and is a strict order (for eviction).
 */
let stamped = 0;
const stamp = () => {
  stamped = Math.max(Date.now(), stamped + 1);
  return stamped;
};

/** `dropped` is true when expired entries were filtered out and should be swept. */
function read(): { store: Store; dropped: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { store: {}, dropped: false };
    const parsed = JSON.parse(raw) as { v?: number; d?: Store };
    if (parsed?.v !== VERSION || !parsed.d || typeof parsed.d !== 'object') {
      // A older version, or something else's data under our key. Not ours to
      // read; the next write replaces it.
      return { store: {}, dropped: true };
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: Store = {};
    let dropped = false;
    for (const [id, e] of Object.entries(parsed.d)) {
      if (e && typeof e.t === 'string' && typeof e.at === 'number' && e.at > cutoff) out[id] = e;
      else dropped = true;
    }
    return { store: out, dropped };
  } catch {
    // Denied, or nonsense under our key. Either way: no remembered drafts, which
    // is exactly the behaviour we had before this file.
    return { store: {}, dropped: false };
  }
}

const load = (): Store => read().store;

function save(store: Store) {
  // Newest first, and drop from the tail once the set is over budget: the draft
  // being typed right now is the newest, so it is the last thing to go.
  const byNewest = Object.entries(store).sort((a, b) => b[1].at - a[1].at);
  let total = 0;
  let out: Store = {};
  for (const [id, e] of byNewest) {
    total += e.t.length + id.length + 24;
    if (total > MAX_TOTAL) break;
    out[id] = e;
  }
  // That budget is ours; the quota is the browser's, and the rest of the app
  // spends from it too. A write that fails sheds the oldest draft and tries
  // again, and if it still fails it gives up without a word — a composer that
  // throws on a keystroke is far worse than one that forgets.
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

/** The draft for one session — '' when there isn't one. */
export function recallDraft(id: string): string {
  const held = mem.get(id);
  if (held !== undefined) return held;
  const { store, dropped } = read();
  // Expiring has to mean deleted, not merely hidden: an abandoned draft that is
  // no longer offered but is still sitting in localStorage has not expired in
  // any sense the person who typed it would recognise. Reading is the moment we
  // know — the app reads on every mount, so nothing waits for a write.
  if (dropped) save(store);
  const text = store[id]?.t || '';
  if (text) mem.set(id, text);
  return text;
}

/**
 * Hold a draft in memory only. For text mid-IME-composition: it is what the
 * textarea contains, but not something the user has committed yet.
 */
export function holdDraft(id: string, text: string) {
  if (text) mem.set(id, text);
  else mem.delete(id);
}

/** Hold it, and write it through so it survives the document. */
export function rememberDraft(id: string, text: string) {
  holdDraft(id, text);
  const store = load();
  if (!text || text.length > MAX_TEXT) delete store[id];
  else store[id] = { t: text, at: stamp() };
  save(store);
}

/** Forget one session's draft everywhere. */
export function forgetDraft(id: string) {
  rememberDraft(id, '');
}
