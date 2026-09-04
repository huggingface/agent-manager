import type { TraceCursor, TraceReq, TraceSummary, TraceTurn, TraceWindow } from '../api';
import { reconcileTrace } from './readerModel';

export const INITIAL_WINDOW_BYTES = 128 * 1024;
export const INITIAL_WINDOW_TURNS = 2;
export const WINDOW_BYTES = 384 * 1024;
export const REQUEST_TIMEOUT_MS = 12_000;
export const SUMMARY_DELAY_MS = 400;

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
  version: number;
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
  return JSON.stringify(prev) === JSON.stringify(out) ? prev : out;
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
    error: null, errorCode: null, notice: null, lastSuccess: 0, version: 0 };
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
      loaded: turns.length, atStart: cursor.atStart, blocked: !!cursor.blocked } as TraceHeadInfo;
    for (const key of ['note', 'title', 'harnessLabel', 'sessionId', 'model', 'cwd', 'source', 'sharedBy'] as const) {
      if (!head[key] && summary?.[key]) (head as Record<string, unknown>)[key] = summary[key];
    }
    head.truncated = !!(this.meta?.truncated || summary?.truncated);
    return JSON.stringify(head) === JSON.stringify(this.state.head) ? this.state.head : head;
  }

  retain() {
    this.consumers++;
    if (this.consumers === 1) { void this.read(this.state.cursor ? 'after' : 'tail'); this.scheduleSummary(); }
    return () => {
      this.consumers = Math.max(0, this.consumers - 1);
      if (!this.consumers) {
        this.cancel();
        clearTimeout(this.poll); this.poll = null;
        clearTimeout(this.summaryTimer); this.summaryTimer = null;
        this.summaryRequest?.abort(); this.summaryRequest = null;
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
    this.cancel(); this.failures = 0;
    this.summaryRequest?.abort(); this.summaryRequest = null;
    clearTimeout(this.summaryTimer); this.summaryTimer = null;
    this.summaryFailures = 0; this.scheduleSummary();
    return this.read(this.state.cursor ? 'after' : 'tail');
  };
  loadOlder = () => this.read('before');
  loadNewer = () => this.read(this.state.cursor ? 'after' : 'tail');
  dismissNotice = () => this.publish({ notice: null });

  private schedule(delay?: number) {
    clearTimeout(this.poll);
    if (!this.active) return;
    const recent = Date.now() - (this.meta?.lastTs || 0) < 120_000;
    const cadence = this.state.cursor?.mode === 'index' ? 10_000 : recent ? 3_000 : 10_000;
    this.poll = setTimeout(() => { this.poll = null; void this.loadNewer(); }, delay ?? (this.failures ? Math.min(30_000, 1500 * 2 ** Math.min(this.failures, 5)) : cadence));
  }
  private read(direction: 'tail' | 'before' | 'after'): Promise<number> {
    if (this.request) return this.request.promise;
    const cursor = this.state.cursor;
    if (direction === 'before' && (!cursor || cursor.atStart || cursor.blocked)) return Promise.resolve(0);
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
          notice: reset && cursor ? 'The transcript changed or was replaced. Showing its current content.' : this.state.notice }, change);
        this.scheduleSummary();
        return Math.max(0, count);
      }).catch((error) => {
        if (token !== this.sequence) return 0;
        this.failures++;
        const code = typeof error?.code === 'string' ? error.code : null;
        this.publish({ error: code === 'no-trace' && !this.state.head ? null : error?.message || 'Could not read the transcript',
          errorCode: code, phase: this.state.head ? this.state.phase : code === 'no-trace' ? 'empty' : 'error' });
        return 0;
      }).finally(() => {
        if (token !== this.sequence) return;
        this.request = null; this.publish({ loading: null });
        const catchup = direction !== 'before' && this.state.cursor && !this.state.cursor.atEnd && !this.failures && !this.state.error;
        this.schedule(catchup ? 50 : undefined);
      });
    this.request = { abort, token, promise };
    return promise;
  }

  private scheduleSummary() {
    if (!this.active || !this.meta || this.summaryRequest || this.summaryTimer) return;
    if (this.summary && (!this.meta.revision || this.summary.revision === this.meta.revision)) return;
    const wait = Math.max(SUMMARY_DELAY_MS, this.summaryAt + (this.summaryFailures ? Math.min(30_000, 2000 * 2 ** this.summaryFailures) : this.summary ? 30_000 : 0) - Date.now());
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
  let size = [...readers.values()].reduce((n, reader) => n + (reader.active ? 0 : reader.retainedSize), 0);
  for (const [key, reader] of readers) {
    if (reader.active) continue;
    if (readers.size <= 8 && size <= 32 * 1024 * 1024) break;
    size -= reader.retainedSize; readers.delete(key);
  }
}
export function readerFor(key: string, source: TraceSource): ReaderStore {
  let reader = readers.get(key);
  if (!reader) reader = new ReaderStore(source);
  else reader.setSource(source);
  readers.delete(key); readers.set(key, reader);
  return reader;
}
