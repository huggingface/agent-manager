import type { TraceCursor, TraceReq, TraceSummary, TraceTurn, TraceWindow } from '../api';
import { countExchanges, reconcileTrace } from './readerModel';

export const INITIAL_WINDOW_BYTES = 128 * 1024;
export const INITIAL_WINDOW_TURNS = 2;
export const WINDOW_BYTES = 384 * 1024;
export const REQUEST_TIMEOUT_MS = 12_000;
export const SUMMARY_DELAY_MS = 400;
export const SUMMARY_REFRESH_MS = 5 * 60_000;

/* ---- automatic recent-history fill (docs/reader-architecture.md §Initial history) ----
 *
 * The first window is deliberately small so the first paint is cheap. That is
 * also why a cold reader used to show one or two exchanges: 128 KiB is one
 * exchange of a tool-heavy trace, and an indexed source took `min` literally.
 * So after the first window lands, the store keeps paging backward on its own
 * until it holds a useful amount of recent conversation.
 *
 * A count is a target, never a promise: a trace whose records are huge will hit
 * a budget first, and the reader still discloses the remaining history behind
 * `Load earlier turns`. Every bound below exists so that a pathological trace
 * costs a bounded amount of work rather than looping. */

/** Exchanges a cold reader tries to have available. A starting point, tuned
 * against the fixtures in `web/test/readerHistory.test.mjs`; the operator asked
 * for "a bit more extensive" history, not for an exact number. */
export const HISTORY_TARGET_EXCHANGES = 20;
/** A viewport of very short exchanges can ask for more than the target. Past
 * this the reader stops raising it, so tiny rows cannot page a whole trace. */
export const HISTORY_MAX_EXCHANGES = 60;
/** Backward pages one fill may spend. Six 384 KiB pages ≈ 2.3 MiB. */
export const FILL_MAX_REQUESTS = 6;
/** Bytes (or index rows) one fill may pull in beyond the first window. */
export const FILL_MAX_BYTES = 3 * 1024 * 1024;
/** Wall clock one continuous run may span, including waits between steps. */
export const FILL_MAX_MS = 20_000;
/** Between steps, so the paint, the live poll and user input all get a turn. */
export const FILL_STEP_MS = 50;
/** Assumed cost of one indexed row, so both source kinds share one byte budget. */
const INDEX_ROW_COST = 4 * 1024;

const sameFields = (a: object, b: object) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

export interface TraceSource {
  window(req: TraceReq, bytes?: number, min?: number, signal?: AbortSignal): Promise<TraceWindow>;
  summary(signal?: AbortSignal): Promise<TraceSummary>;
}
export type Meta = Omit<TraceWindow, 'turns' | 'window'>;
export type TraceHeadInfo = Meta & { loaded: number; atStart: boolean; blocked: boolean };
export type ReaderChange = { type: 'prepend' | 'append' | 'reset'; count: number };
export interface ReaderSnapshot {
  turns: TraceTurn[];
  head: TraceHeadInfo | null;
  cursor: TraceCursor | null;
  phase: 'loading' | 'empty' | 'ready' | 'error';
  loading: 'tail' | 'before' | 'after' | null;
  error: string | null;
  errorCode: string | null;
  notice: string | null;
  lastSuccess: number;
  activityConfirmed: boolean;
  version: number;
  /** Automatic recent-history fill: 'filling' while it pages backward, 'done'
   * when the target is met, 'limited' when a budget or the source stopped it
   * first (the reader keeps disclosing earlier history either way). */
  fill: 'idle' | 'filling' | 'done' | 'limited';
}

export function mergeMeta(prev: Meta | null, next: Meta): Meta {
  if (!prev) return next;
  const out = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'lastTs' && (value as number) < prev.lastTs) continue;
    if (key === 'firstTs' && (!value || (prev.firstTs && (value as number) > prev.firstTs))) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return sameFields(prev, out) ? prev : out;
}

/** Deadlines race the operation, not just AbortSignal: suspended/fixture fetches
 * may never reject when aborted. A canceled request must always release its slot. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, abort: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort: () => void;
  const canceled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error('Read canceled'));
    abort.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('The transcript read timed out. Retrying…')); abort.abort(); }, REQUEST_TIMEOUT_MS);
  });
  try { return await Promise.race([Promise.resolve().then(() => run(abort.signal)), canceled, deadline]); }
  finally { clearTimeout(timer); abort.signal.removeEventListener('abort', rejectAbort); }
}

export class ReaderStore {
  private state: ReaderSnapshot = { turns: [], head: null, cursor: null, phase: 'loading', loading: null,
    error: null, errorCode: null, notice: null, lastSuccess: 0, activityConfirmed: false, version: 0, fill: 'idle' };
  private raw: TraceTurn[] = [];
  private meta: Meta | null = null;
  private summary: TraceSummary | null = null;
  private listeners = new Set<() => void>();
  private observers = new Set<(change: ReaderChange) => void>();
  private consumers = 0;
  private sequence = 0;
  private request: { abort: AbortController; token: number; promise: Promise<number> } | null = null;
  private summaryRequest: AbortController | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private summaryAt = 0;
  private summaryFailures = 0;
  /** 0 = this consumer does not want automatic history (child readers, previews). */
  private want = 0;
  private fillTimer: ReturnType<typeof setTimeout> | null = null;
  private spent = { requests: 0, bytes: 0, since: 0 };
  private lastStart: number | null = null;
  constructor(private source: TraceSource) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  observe = (listener: (change: ReaderChange) => void) => { this.observers.add(listener); return () => { this.observers.delete(listener); }; };
  setSource(source: TraceSource) { this.source = source; }
  get retainedSize() { return this.raw.reduce((n, t) => n + 128 + 2 * (t.event?.text.length || 0)
    + t.blocks.reduce((b, v) => b + 128 + 2 * ('text' in v ? v.text.length : 'src' in v ? v.src.length : 100), 0), 0); }
  get active() { return this.consumers > 0; }

  private publish(patch: Partial<ReaderSnapshot>, change?: ReaderChange) {
    if (change) for (const observer of this.observers) observer(change);
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private head(turns: TraceTurn[], cursor: TraceCursor): TraceHeadInfo {
    const summary = this.summary && (!this.meta?.revision || this.summary.revision === this.meta.revision) ? this.summary : null;
    const head = { ...summary, ...this.meta, total: summary?.total ?? this.meta?.total ?? null,
      userTurns: this.meta?.userTurns ?? summary?.userTurns ?? null,
      usage: this.meta?.usage || summary?.usage || null,
      firstTs: this.meta?.firstTs || summary?.firstTs || 0,
      // The matching full summary sees lifecycle markers outside a small tail.
      activity: summary?.activity ?? this.meta?.activity ?? null,
      loaded: turns.length, atStart: cursor.atStart, blocked: !!cursor.blocked } as TraceHeadInfo;
    for (const key of ['note', 'title', 'harnessLabel', 'sessionId', 'model', 'cwd', 'source', 'sharedBy'] as const) {
      if (!head[key] && summary?.[key]) (head as Record<string, unknown>)[key] = summary[key];
    }
    head.truncated = !!(this.meta?.truncated || summary?.truncated);
    return this.state.head && sameFields(head, this.state.head) ? this.state.head : head;
  }

  retain() {
    this.consumers++;
    if (this.consumers === 1) {
      void this.read(this.state.cursor ? 'after' : 'tail'); this.scheduleSummary();
      // A warm store keeps its history and its spent budget: coming back to a
      // pane must not re-run the preload, but it may still finish one that a
      // budget or an unmount cut short.
      this.planFill();
    }
    return () => {
      this.consumers = Math.max(0, this.consumers - 1);
      if (!this.consumers) {
        this.cancel();
        this.stopFill();
        clearTimeout(this.poll); this.poll = null;
        clearTimeout(this.summaryTimer); this.summaryTimer = null;
        this.summaryRequest?.abort(); this.summaryRequest = null;
        if (this.state.activityConfirmed) this.publish({ activityConfirmed: false });
        // React may be transferring ownership to a new mounted subscriber in
        // this same effect pass. Evict only after those retains have run.
        queueMicrotask(pruneReaders);
      }
    };
  }
  private cancel() {
    this.sequence++;
    this.request?.abort.abort(); this.request = null;
    if (this.state.loading) this.publish({ loading: null });
  }
  /** Explicit refresh/foreground recovery replaces a possibly frozen request. */
  refresh = () => {
    this.cancel(); this.resetFill(); this.failures = 0;
    this.summaryRequest?.abort(); this.summaryRequest = null;
    clearTimeout(this.summaryTimer); this.summaryTimer = null;
    this.summaryFailures = 0; this.summaryAt = 0; this.scheduleSummary();
    return this.read(this.state.cursor ? 'after' : 'tail');
  };
  loadOlder = () => {
    // A user paging backward must not inherit an unrelated poll's promise.
    // Canceling leaves the accepted forward cursor intact for the next poll.
    const cursor = this.state.cursor;
    if (cursor && !cursor.atStart && !cursor.blocked && this.state.loading === 'after') this.cancel();
    return this.read('before');
  };
  loadNewer = () => this.read(this.state.cursor ? 'after' : 'tail');
  dismissNotice = () => this.publish({ notice: null });

  /**
   * How many recent exchanges this reader wants available without being asked.
   * Consumers opt in: a child transcript opens at the top of its own context
   * and a collapsed preview should not page anything, so both leave it at 0.
   *
   * Raising it (the view does, when a page of very short exchanges has not
   * covered the scroller yet) resumes a fill that had reached the old target.
   * It never resets a budget that a real limit already exhausted.
   */
  wantHistory = (exchanges: number) => {
    const next = Math.min(Math.max(0, Math.trunc(exchanges)), HISTORY_MAX_EXCHANGES);
    if (next <= this.want) return;
    this.want = next;
    if (this.state.fill === 'done') this.publish({ fill: 'idle' });
    this.planFill();
  };

  private stopFill() {
    clearTimeout(this.fillTimer); this.fillTimer = null;
    // The wall clock measures one continuous run: it exists to stop a slow
    // source filling forever, not to forbid a fill on a pane reopened later.
    // Requests and bytes stay cumulative, so total work per transcript is still
    // capped however many times it is reopened.
    this.spent.since = 0;
    if (this.state.fill === 'filling') this.publish({ fill: 'idle' });
  }
  /** A fresh transcript (or an explicit refresh) is allowed a fresh budget. */
  private resetFill() {
    this.stopFill();
    this.spent = { requests: 0, bytes: 0, since: 0 };
    this.lastStart = null;
    if (this.state.fill !== 'idle') this.publish({ fill: 'idle' });
  }
  /**
   * Decide whether to take another backward step, and why not if not. Called
   * after every accepted read, so a fill that a user page or a live append
   * interrupted simply continues from wherever the store now is.
   */
  private planFill() {
    if (this.fillTimer || !this.want || !this.active) return;
    const { cursor, turns } = this.state;
    if (!cursor || this.state.loading) return;             // wait for the read in flight
    const have = countExchanges(turns);
    if (have >= this.want) { if (this.state.fill !== 'done') this.publish({ fill: 'done' }); return; }
    // Nothing more to fetch, or nothing we can fetch: an honest partial view.
    if (cursor.atStart || cursor.blocked || this.state.error) return this.limited();
    // A backward page that did not move the cursor cannot be retried into
    // progress — an oversized record is in the way.
    if (this.lastStart !== null && cursor.start >= this.lastStart) return this.limited();
    if (!this.spent.since) this.spent.since = Date.now();
    if (this.spent.requests >= FILL_MAX_REQUESTS || this.spent.bytes >= FILL_MAX_BYTES
      || Date.now() - this.spent.since >= FILL_MAX_MS) return this.limited();
    if (this.state.fill !== 'filling') this.publish({ fill: 'filling' });
    this.fillTimer = setTimeout(() => {
      this.fillTimer = null;
      if (!this.want || !this.active || this.state.loading) return this.planFill();
      const from = this.state.cursor;
      const held = this.state.turns.length;
      this.lastStart = from ? from.start : null;
      this.spent.requests++;
      void this.read('before').then(() => {
        const to = this.state.cursor;
        // What this step actually cost. An index source has no byte offsets, so
        // its rows are charged at an assumed size — the point is a single
        // budget that both kinds of source can exhaust, not an exact byte count.
        this.spent.bytes += from && to && to.mode !== 'index'
          ? Math.max(0, from.start - to.start)
          : Math.max(0, this.state.turns.length - held) * INDEX_ROW_COST;
      });
    }, FILL_STEP_MS);
  }
  private limited() {
    if (this.state.fill !== 'limited') this.publish({ fill: 'limited' });
  }

  private schedule(delay?: number) {
    clearTimeout(this.poll);
    if (!this.active) return;
    const recent = Date.now() - (this.meta?.lastTs || 0) < 120_000;
    const cadence = this.state.cursor?.mode === 'index' ? 10_000 : recent ? 3_000 : 10_000;
    this.poll = setTimeout(() => { this.poll = null; void this.loadNewer(); }, delay ?? (this.failures ? Math.min(30_000, 1500 * 2 ** Math.min(this.failures, 5)) : cadence));
  }
  private read(direction: 'tail' | 'before' | 'after'): Promise<number> {
    const cursor = this.state.cursor;
    if (direction === 'before' && (!cursor || cursor.atStart || cursor.blocked)) return Promise.resolve(0);
    if (this.request) return this.request.promise;
    if (direction === 'after' && !cursor) direction = 'tail';
    const token = ++this.sequence;
    const abort = new AbortController();
    const req: TraceReq = direction === 'tail' ? { at: 'tail' } : { at: direction,
      cursor: direction === 'before' ? cursor.start : cursor.end, generation: cursor.generation };
    this.publish({ loading: direction });
    const promise = bounded((signal) => this.source.window(req,
      direction === 'tail' ? INITIAL_WINDOW_BYTES : WINDOW_BYTES,
      direction === 'tail' ? INITIAL_WINDOW_TURNS : undefined, signal), abort)
      .then((response) => {
        if (token !== this.sequence) return 0;
        const { turns: got, window: win, ...metadata } = response;
        const reset = direction === 'tail' || !!win.reset || !!win.gap
          || !!(cursor?.generation && win.generation && cursor.generation !== win.generation);
        let nextCursor: TraceCursor;
        if (reset) { this.raw = got; this.meta = metadata; this.summary = null; nextCursor = win; }
        else if (direction === 'before') {
          this.raw = [...got, ...this.raw]; this.meta = mergeMeta(this.meta, { ...metadata,
            activity: this.meta?.activity, model: this.meta?.model, revision: this.meta?.revision });
          nextCursor = { ...cursor, start: win.start, atStart: win.atStart, blocked: win.blocked };
        } else {
          if (win.mode === 'index' && win.replaceFrom !== undefined) {
            const keep = Math.max(0, win.replaceFrom - cursor.start);
            const skip = Math.max(0, cursor.start - win.replaceFrom);
            // Reuse unchanged DB messages; a revision can change while this
            // source's selected conversation has not.
            const incoming = got.slice(skip).map((turn, i) => {
              const old = this.raw[keep + i]; return old && JSON.stringify(old) === JSON.stringify(turn) ? old : turn;
            });
            this.raw = [...this.raw.slice(0, keep), ...incoming];
          } else if (got.length) this.raw = [...this.raw, ...got];
          this.meta = mergeMeta(this.meta, metadata);
          nextCursor = { ...cursor, end: win.end, atEnd: win.atEnd, generation: win.generation, revision: win.revision };
        }
        const turns = reconcileTrace(this.raw, reset ? [] : this.state.turns);
        const changed = turns !== this.state.turns;
        const count = turns.length - this.state.turns.length;
        const change: ReaderChange | undefined = reset ? { type: 'reset', count: turns.length }
          : changed ? { type: direction === 'before' ? 'prepend' : 'append', count: Math.max(0, count) } : undefined;
        this.failures = win.blocked ? 5 : 0;
        this.publish({ turns, cursor: nextCursor, head: this.head(turns, nextCursor), phase: turns.length ? 'ready' : 'empty',
          error: win.blocked && direction === 'after' ? 'A transcript record is too large to read. Download the raw trace to inspect it.' : null,
          errorCode: null, lastSuccess: Date.now(), version: this.state.version + (changed || reset ? 1 : 0),
          activityConfirmed: direction !== 'before' ? !!win.atEnd : this.state.activityConfirmed,
          notice: reset && cursor ? 'The transcript changed or was replaced. Showing its current content.' : this.state.notice }, change);
        if (reset) this.resetFill();
        this.scheduleSummary();
        return Math.max(0, count);
      }).catch((error) => {
        if (token !== this.sequence) return 0;
        this.failures++;
        // Failure ends the fill; the text and composer that are already here
        // stay, and Earlier/Retry remain the way forward.
        this.stopFill();
        const code = typeof error?.code === 'string' ? error.code : null;
        this.publish({ error: code === 'no-trace' && !this.state.head ? null : error?.message || 'Could not read the transcript',
          errorCode: code, activityConfirmed: false, phase: this.state.head ? this.state.phase : code === 'no-trace' ? 'empty' : 'error' });
        return 0;
      }).finally(() => {
        if (token !== this.sequence) return;
        this.request = null; this.publish({ loading: null });
        const catchup = direction !== 'before' && this.state.cursor && !this.state.cursor.atEnd && !this.failures && !this.state.error;
        this.schedule(catchup ? 50 : undefined);
        // After the slot is free, so a fill step never races the read that
        // produced it. Every accepted read re-decides: a fill that a user page
        // or a live append interrupted just continues from where the store is.
        this.planFill();
      });
    this.request = { abort, token, promise };
    return promise;
  }

  private scheduleSummary() {
    if (!this.active || !this.meta || this.summaryRequest || this.summaryTimer) return;
    if (this.summary && (!this.meta.revision || this.summary.revision === this.meta.revision)) return;
    const wait = Math.max(SUMMARY_DELAY_MS, this.summaryAt + (this.summaryFailures ? Math.min(30_000, 2000 * 2 ** this.summaryFailures) : this.summary ? SUMMARY_REFRESH_MS : 0) - Date.now());
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      if (!this.active) return;
      const abort = new AbortController(); this.summaryRequest = abort; this.summaryAt = Date.now();
      const generation = this.state.cursor?.generation;
      void bounded((signal) => this.source.summary(signal), abort).then((summary) => {
        if (this.summaryRequest !== abort || generation !== this.state.cursor?.generation) return;
        this.summary = summary; this.summaryFailures = 0;
        if (this.state.cursor) this.publish({ head: this.head(this.state.turns, this.state.cursor) });
      }).catch(() => { if (this.summaryRequest === abort) this.summaryFailures = Math.min(4, this.summaryFailures + 1); })
        .finally(() => { if (this.summaryRequest === abort) { this.summaryRequest = null; this.scheduleSummary(); } });
    }, wait);
  }
}

const readers = new Map<string, ReaderStore>();
function pruneReaders() {
  const inactive = [...readers].filter(([, reader]) => !reader.active);
  let count = inactive.length;
  let size = inactive.reduce((n, [, reader]) => n + reader.retainedSize, 0);
  for (const [key, reader] of inactive) {
    if (count <= 8 && size <= 32 * 1024 * 1024) break;
    size -= reader.retainedSize; readers.delete(key);
    count--;
  }
}
export function readerFor(key: string, source: TraceSource): ReaderStore {
  let reader = readers.get(key);
  if (!reader) reader = new ReaderStore(source);
  else reader.setSource(source);
  readers.delete(key); readers.set(key, reader);
  return reader;
}
