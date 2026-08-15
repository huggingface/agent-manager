// Reading a trace as WINDOWS, for whichever surface is doing the reading.
//
// The Trace pane and reader mode show the same conversation very differently —
// one as rows of turns, the other as exchanges with a composer under them — but
// they fetch it identically: open on the end, page backwards a window at a time,
// follow the end while it is being written. That fetching is subtle in ways two
// review rounds found the hard way (a load outliving its source, a second load
// racing the first, a pointer to a window nobody read), so it lives here once
// rather than twice.
//
// `src` MUST be memoized by the caller (all three call sites use useMemo on the
// session id or path): the reset effect depends on it, so a fresh object per
// render would refetch the tail forever.
//
// What stays with the caller is everything about presentation: how a row is
// measured, what is virtualized, and how the reading position is anchored when
// older turns arrive. The hook says WHEN turns are about to be prepended
// (`onPrepend`) and when everything has been replaced (`onReset`); the caller
// decides what that means for its own scroller.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import type { TraceCursor, TraceSummary, TraceTurn, TraceWindow } from '../api';

/** The first paint is deliberately smaller than an ordinary page. A turn floor
 *  made a nominal 384 KB tail grow to 1.5 MB / 737 KB of JSON on a real Codex
 *  trace before the reader could show anything. Two messages are enough to paint
 *  the latest exchange; the host can fill above it after that first paint. */
export const INITIAL_WINDOW_BYTES = 128 * 1024;
export const INITIAL_WINDOW_TURNS = 2;
/** Once something is on screen, larger pages make scrolling back efficient. */
export const WINDOW_BYTES = 384 * 1024;
// Following a trace that is still being written. Nothing in here knows whether
// an agent is running — but a transcript whose newest turn is seconds old is one
// being written, so the cadence follows the trace itself: quick while it moves,
// slow once it has gone quiet, which is also how it notices movement resuming.
const LIVE_MS = 3_000;
const IDLE_MS = 10_000;
const FRESH_MS = 120_000;
const SUMMARY_DELAY_MS = 400; // let the first paint happen before the whole-file read

export interface TraceSource {
  window: (req: api.TraceReq, bytes?: number, min?: number, signal?: AbortSignal) => Promise<TraceWindow>;
  summary: (signal?: AbortSignal) => Promise<TraceSummary>;
}

export type Meta = Omit<TraceWindow, 'turns' | 'window'>;

/** What a host's chrome needs. `total` is null until the summary lands. */
export type TraceHeadInfo = Meta & {
  /** turns the reader is holding right now */
  loaded: number;
  /** the first turn of the conversation is loaded — there is nothing above */
  atStart: boolean;
  /** one line is bigger than a window: nothing older can be reached */
  blocked: boolean;
};

// Keep whichever value actually says something: a window that doesn't reach the
// start of the trace reports no session start and no session cost, and must not
// blank out what an earlier response already told us. Identity is preserved when
// no SCALAR changed, which is what keeps a poll that learns nothing from looking
// like new state; an object-valued field (`usage`, `source`) compares by
// identity and would churn, so those only ever arrive once per source today.
export const mergeMeta = (prev: Meta | null, next: Meta): Meta => {
  if (!prev) return next;
  const out = { ...prev } as Record<string, unknown>;
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    // A window OLDER than what we hold describes an older stretch of the same
    // conversation. `lastTs` must not travel backwards — it drives how often we
    // look for new turns, and scrolling back would otherwise slow the live tail
    // to a crawl. `model` is simply first-one-wins: the tail is read first, so
    // that is the model the session is running now, and an older window's model
    // does not replace it.
    if ((k === 'lastTs' || k === 'model') && out[k] && (k !== 'lastTs' || (v as number) <= (out[k] as number))) continue;
    if ((v || !(k in out)) && out[k] !== v) { out[k] = v; changed = true; }
  }
  return changed ? (out as Meta) : prev;
};

export function useTraceWindows(src: TraceSource, srcKey: string, opts: {
  /** About to prepend `count` older turns — capture the reading position now. */
  onPrepend?: (count: number) => void;
  /** About to append `count` new turns at the end. */
  onAppend?: (count: number) => void;
  /** Everything replaced: a new source, or a gap too big to splice. */
  onReset?: () => void;
  /** The surface is off-screen: stop asking for turns nobody is looking at. */
  paused?: boolean;
  /** The host knows the session is running. `false` means it is not, and a trace
   *  that has also been quiet for a while is then left alone entirely — which is
   *  what reader mode did before it had windows. Omit to decide on recency only. */
  live?: boolean;
} = {}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const turns = useRef<TraceTurn[]>([]);
  const cursor = useRef<TraceCursor | null>(null);
  // ONE request at a time. Flicking the wheel at the top of a long trace fires
  // scroll events by the dozen, and each one would otherwise start its own load;
  // they would arrive out of order and prepend the same turns twice.
  const loading = useRef(false);
  // Which source the turns in hand belong to. Every load reads this before its
  // await and checks it after: switch files in the Files pane while a window is
  // in flight and it would otherwise be prepended to the NEW file's turns, with
  // the old file's byte cursors and header — a conversation spliced out of two
  // different transcripts.
  const gen = useRef(0);
  const windowAbort = useRef<AbortController | null>(null);
  const summaryAbort = useRef<AbortController | null>(null);
  const summaryStarted = useRef(false);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((n) => n + 1), []);

  const cb = useRef(opts);
  cb.current = opts;

  const loadTail = useCallback(async () => {
    if (cb.current.paused) return;
    loading.current = true;
    const mine = gen.current;
    const abort = new AbortController();
    windowAbort.current = abort;
    try {
      const { turns: got, window: win, ...m } = await src.window(
        { at: 'tail' }, INITIAL_WINDOW_BYTES, INITIAL_WINDOW_TURNS, abort.signal,
      );
      if (mine !== gen.current) return;
      turns.current = got;
      cursor.current = win;
      cb.current.onReset?.();
      setMeta(m);
      setError(null);
      bump();
      // Nothing to render means nothing to measure, so no measurement will ever
      // arrive to unblock the paging: walk back until there is something. After
      // this call returns, so the one-request-at-a-time guard still holds.
      if (!got.length && !win.atStart) window.setTimeout(() => loadOlderRef.current(), 0);
    } catch (e) {
      if (mine !== gen.current) return;
      // The server distinguishes "nothing to show yet" from a real failure and
      // says which — pass its own words through rather than inventing a reason.
      setError(e instanceof api.TraceUnavailable ? e.message : 'could not read the trace');
    } finally {
      if (windowAbort.current === abort) windowAbort.current = null;
      if (mine === gen.current) loading.current = false;
    }
  }, [src, bump]);

  const loadOlderRef = useRef<() => Promise<number>>(async () => 0);

  /** Fetch the window before the oldest turn held. Returns how many arrived. */
  const loadOlder = useCallback(async () => {
    const cur = cursor.current;
    if (cb.current.paused || loading.current || !cur || cur.atStart || cur.blocked) return 0;
    loading.current = true;
    const mine = gen.current;
    const abort = new AbortController();
    windowAbort.current = abort;
    try {
      let from = cur.start;
      let atStart = false;
      let blocked = false;
      let got: TraceTurn[] = [];
      let meta2: Meta | null = null;
      // A window can legitimately hold no turns at all (a stretch of file-history
      // lines, a run of harness metadata). Keep walking back until it holds
      // something, the file starts, or the cursor stops moving.
      for (let hop = 0; hop < 8 && !got.length && !atStart; hop++) {
        const { turns: page, window: win, ...m } = await src.window(
          { at: 'before', cursor: from }, WINDOW_BYTES, undefined, abort.signal,
        );
        if (mine !== gen.current) return 0;
        got = page;
        meta2 = m;
        // `blocked` is a line too big for any window — the server cannot get
        // past it, so neither can we, and this is NOT the start of the trace.
        blocked = !!win.blocked;
        atStart = win.atStart || (!blocked && win.start >= from);
        from = win.start;
        if (blocked) break;
      }
      if (got.length) cb.current.onPrepend?.(got.length);
      turns.current = [...got, ...turns.current];
      cursor.current = { ...cur, start: from, atStart, blocked };
      if (meta2) setMeta((p) => mergeMeta(p, meta2 as Meta));
      bump();
      return got.length;
    } catch {
      // Keep what is on screen; the next scroll retries.
      return 0;
    } finally {
      if (windowAbort.current === abort) windowAbort.current = null;
      if (mine === gen.current) loading.current = false;
    }
  }, [src, bump]);
  loadOlderRef.current = loadOlder;

  /** Whatever the agent has written since we last looked. */
  const loadNewer = useCallback(async () => {
    const cur = cursor.current;
    if (cb.current.paused || loading.current || !cur) return 0;
    loading.current = true;
    const mine = gen.current;
    const abort = new AbortController();
    windowAbort.current = abort;
    try {
      const { turns: got, window: win, ...m } = await src.window(
        { at: 'after', cursor: cur.end }, undefined, undefined, abort.signal,
      );
      if (mine !== gen.current) return 0;
      if (win.gap) {
        // More was written than one window can carry. Splicing it in would leave
        // a hole in the middle of the conversation with nothing to say so —
        // start again from the new tail instead.
        turns.current = got;
        cursor.current = win;
        cb.current.onReset?.();
      } else {
        if (got.length) {
          cb.current.onAppend?.(got.length);
          turns.current = [...turns.current, ...got];
        }
        cursor.current = { ...cur, end: win.end, atEnd: win.atEnd };
      }
      setMeta((p) => mergeMeta(p, m));
      if (got.length) bump();
      return got.length;
    } catch {
      // A poll that fails must not throw away the conversation on screen.
      return 0;
    } finally {
      if (windowAbort.current === abort) windowAbort.current = null;
      if (mine === gen.current) loading.current = false;
    }
  }, [src, bump]);

  const paused = !!opts.paused;

  useEffect(() => {
    gen.current += 1;
    windowAbort.current?.abort();
    windowAbort.current = null;
    summaryAbort.current?.abort();
    summaryAbort.current = null;
    summaryStarted.current = false;
    loading.current = false;
    turns.current = [];
    cursor.current = null;
    cb.current.onReset?.();
    setMeta(null);
    setSummary(null);
    setError(null);
    if (!paused) loadTail();
    return () => {
      gen.current += 1;
      windowAbort.current?.abort();
      windowAbort.current = null;
      summaryAbort.current?.abort();
      summaryAbort.current = null;
    };
  }, [srcKey, loadTail, paused]);

  // The one read that touches the whole file, fired AFTER the first paint: it
  // buys the header a real turn count, the session's token total, the date the
  // conversation started and the disclosures a window cannot see — none of which
  // a window can know. If it fails or is slow, the header simply says how much
  // is loaded.
  const summaryReady = !!meta;
  useEffect(() => {
    // `meta` is set by the tail response and this effect runs after that render
    // commits. Starting the clock on mount let a slow tail lose a race to every
    // pane's full-file summary — exactly the work the delay meant to keep away
    // from first paint. A paused/hidden reader does no summary work at all.
    if (paused || !summaryReady || summary || summaryStarted.current) return undefined;
    let dead = false;
    const h = window.setTimeout(() => {
      if (summaryStarted.current) return;
      summaryStarted.current = true;
      const abort = new AbortController();
      summaryAbort.current = abort;
      src.summary(abort.signal)
        .then((s) => { if (!dead) setSummary(s); })
        .catch(() => {})
        .finally(() => { if (summaryAbort.current === abort) summaryAbort.current = null; });
    }, SUMMARY_DELAY_MS);
    return () => { dead = true; window.clearTimeout(h); };
  }, [src, srcKey, paused, summaryReady, summary]);

  // The transcript may still be being written — see LIVE_MS above. Except when
  // "a window" costs a whole-file read: the SQLite harnesses have no byte
  // offsets to seek, so every poll would re-parse the entire conversation (and
  // evict the Overview's memo doing it). They are not polled at all.
  const lastTs = meta ? meta.lastTs : 0;
  const seekable = cursor.current ? cursor.current.mode === 'bytes' : true;
  const live = opts.live;
  const [hidden, setHidden] = useState(() => (typeof document === 'undefined' ? false : document.hidden));
  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    const fresh = !!lastTs && Date.now() - lastTs < FRESH_MS;
    // Nothing to follow: the host says the session is not running and the trace
    // has not moved in a while. A pane behind another browser tab is the same
    // case — the reader is not looking, so nobody is waiting for the turn.
    if (!seekable || paused || hidden || (live === false && !fresh)) return undefined;
    const h = window.setInterval(loadNewer, fresh ? LIVE_MS : IDLE_MS);
    return () => window.clearInterval(h);
  }, [loadNewer, lastTs, seekable, paused, hidden, live]);

  // Coming back from another app has to show what happened while away, and none
  // of the loop above survives the trip. The interval is cleared while hidden,
  // and the effect that would restore it schedules NOTHING when the host says
  // the session stopped and the trace has been quiet — so a reader left on a
  // finished session shows the turns from before the operator switched away,
  // for as long as they keep looking at it. Even when a poll is scheduled, an
  // interval's first tick is one whole interval late.
  //
  // A frozen request makes it worse. iOS Safari suspends a backgrounded tab, so
  // a window request that was in flight when the operator left may never settle
  // — and `loading` is released only in that request's `finally`, so every later
  // read returns early against a latch nothing will ever release. That is a
  // reader which stays stale even once polling resumes.
  //
  // So a return reads immediately: abandon whatever was outstanding (bumping the
  // generation, which is what makes its response and its `finally` no longer
  // ours), release the latch, and ask for the turns written while away.
  useEffect(() => {
    const resync = () => {
      if (document.hidden || cb.current.paused) return;
      const outstanding = windowAbort.current;
      if (outstanding) {
        gen.current += 1;
        windowAbort.current = null;
        outstanding.abort();
      }
      loading.current = false;
      void (cursor.current ? loadNewer() : loadTail());
    };
    const onVisible = () => { if (!document.hidden) resync(); };
    // Restoring a page from the back/forward cache fires no visibilitychange:
    // the tab was never hidden, the whole page was frozen and thawed. Safari
    // leans on this hard — a swipe back, or an app switch that outlived the
    // renderer, comes back this way.
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) resync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onShow);
    };
  }, [loadNewer, loadTail]);

  const atStart = !!cursor.current?.atStart;
  const blocked = !!cursor.current?.blocked;
  // MEMOIZED, and it has to be: a host that lifts this into its own state — the
  // Trace pane does, `onHead={setHead}` — turns a fresh object per render into
  // effect → setState → render → fresh object, a loop that never trips React's
  // update-depth guard because it goes through an effect. It just spins: measured
  // at 98% of a core with an untouched pane open.
  // What the pane knows about the trace: whatever this window could tell us,
  // filled in from the summary for everything a window cannot know. That is not
  // only the counts — a window of a codex rollout cannot count the session's
  // encrypted reasoning steps (`note`), and a window of an STS file never sees
  // the `{type:'session'}` first line that carries the title, the harness and
  // the session id.
  const head: TraceHeadInfo | null = useMemo(() => (meta ? {
    ...meta,
    total: summary ? summary.total : null,
    userTurns: summary ? summary.userTurns : null,
    usage: meta.usage || (summary ? summary.usage : null),
    firstTs: meta.firstTs || (summary ? summary.firstTs : 0),
    truncated: meta.truncated || !!(summary && summary.truncated),
    note: meta.note || (summary ? summary.note : null),
    title: meta.title || (summary ? summary.title : ''),
    harnessLabel: meta.harnessLabel || (summary ? summary.harnessLabel : ''),
    sessionId: meta.sessionId || (summary ? summary.sessionId : null),
    model: meta.model || (summary ? summary.model : null),
    cwd: meta.cwd || (summary ? summary.cwd : null),
    source: meta.source || (summary ? summary.source : null),
    sharedBy: meta.sharedBy || (summary ? summary.sharedBy : null),
    loaded: turns.current.length,
    atStart,
    blocked,
  } : null), [meta, summary, version, atStart, blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  return { turns, head, meta, error, version, atStart, blocked, loadOlder, loadNewer, reload: loadTail };
}
