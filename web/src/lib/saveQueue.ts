import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

// One writer per thing being saved.
//
// Saves lose work in two ways, and both of them look like success. Two writes in
// flight at once land in whichever order the server happens to finish them, so
// the last word belongs to nobody in particular. And a response that arrives
// after the user has typed again describes a version that is already history:
// acting on it — clearing the draft, saying "saved" — either throws the newer
// text away or lies about where it is.
//
// So there is one request at a time and a single pending slot holding the LATEST
// value asked for, never a queue of stale revisions. When the write settles,
// whatever is waiting goes out immediately: no timer stands between an edit and
// its save, and none stands between one write and the next. A response may only
// speak for the editor — clear its draft, report it saved — if nothing newer was
// asked for while it was away, which is what `superseded` reports.
//
// The policy of *when* to ask is the caller's: settings ask on every change,
// files ask when the user says so. Both need the same ordering guarantees.
//
// This core is deliberately NOT a hook. A save has to outlive the panel it was
// made in — closing Settings cannot be the thing that cancels the only copy of
// the work — so the state lives in a plain object a module can own, and
// `useSaver` is only a window onto it.

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type SaverState = {
  status: SaveStatus;
  /** The message from the failed attempt, while `status` is 'error'. */
  error: string | null;
  /** Something asked for is not on the server yet. */
  outstanding: boolean;
  /** The last answer never came. What is on the server is not yet known. */
  unresolved: boolean;
};

/** What the server turned out to hold after a response went missing. */
export type Reconciled<R> = { outcome: 'committed'; result: R } | { outcome: 'lost' };

export type SaverOptions<T, R> = {
  send: (value: T) => Promise<R>;
  /**
   * A write landed. `superseded` means something newer was asked for while it
   * was in flight and is going out next — the caller must not report saved or
   * release its draft on the strength of this response.
   */
  onCommit?: (value: T, result: R, superseded: boolean) => void;
  /** A write was refused. The value stays put, so Retry has something to send. */
  onFail?: (error: Error, value: T) => void;
  /**
   * How long to wait for an answer before giving the slot back. Without this a
   * request that never settles holds the resource forever: every later edit
   * piles into the pending slot and the UI says "saving…" for good.
   */
  timeoutMs?: number;
  /**
   * A lost response may mean the server committed. Before anything is sent
   * again, this asks what is actually stored — retrying blind would either
   * repeat a write that already landed or overwrite whatever replaced it.
   */
  reconcile?: (value: T) => Promise<Reconciled<R>>;
};

export type Saver<T> = {
  /**
   * Ask for `value` to be on the server. Resolves true once it — or something
   * newer, which supersedes it — has been committed, and false if the attempt
   * failed. "Save and close" waits on this, so it must not resolve early.
   */
  request: (value: T) => Promise<boolean>;
  /** Try the value the last attempt failed on again. */
  retry: () => Promise<boolean>;
  /** Drop anything still waiting: the caller has thrown the buffer away. */
  reset: () => void;
  /** The value still waiting to be saved, if any — what a reopened panel shows. */
  pending: () => T | null;
} & SaverState;

const IDLE: SaverState = { status: 'idle', error: null, outstanding: false, unresolved: false };

class TimedOut extends Error {
  constructor() { super('the server did not answer — this change may or may not have been saved'); }
}

export type SaverHandle<T, R> = {
  request: (value: T) => Promise<boolean>;
  retry: () => Promise<boolean>;
  reset: () => void;
  pending: () => T | null;
  state: () => SaverState;
  /** The finite window an answer has to arrive in, if one is set. */
  timeout: () => number | null;
  subscribe: (fn: () => void) => () => void;
  /** Point the callbacks at the current render's closures. */
  configure: (opts: Partial<SaverOptions<T, R>>) => void;
};

export function createSaver<T, R>(opts: SaverOptions<T, R>): SaverHandle<T, R> {
  let options = opts;
  let state: SaverState = IDLE;
  let active = false;
  let slot: { value: T; waiters: ((ok: boolean) => void)[] } | null = null;
  let failed = false;
  // The value whose answer never arrived. Nothing else may be sent until we know
  // what the server did with it.
  let unresolved: { value: T } | null = null;
  const listeners = new Set<() => void>();

  // The tick fades and a failure does not: presentation only, and it has never
  // gated a write. It lives here so a save that outlives its panel still stops
  // saying "saved ✓" at the same moment for whoever reopens it.
  let fade: ReturnType<typeof setTimeout> | null = null;
  const emit = (next: Partial<SaverState>) => {
    if (fade) { clearTimeout(fade); fade = null; }
    state = { ...state, ...next };
    if (state.status === 'saved') fade = setTimeout(() => emit({ status: 'idle' }), 1800);
    listeners.forEach((fn) => fn());
  };
  const settleWaiters = (job: { waiters: ((ok: boolean) => void)[] }, ok: boolean) => {
    const waiters = job.waiters;
    job.waiters = [];
    waiters.forEach((w) => w(ok));
  };

  const withTimeout = (p: Promise<R>): Promise<R> => (
    options.timeoutMs
      ? new Promise<R>((resolve, reject) => {
        const t = setTimeout(() => reject(new TimedOut()), options.timeoutMs);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      })
      : p
  );

  // A lost answer, resolved before anything else is allowed out.
  const settleUnresolved = async () => {
    const missing = unresolved!;
    active = true;
    emit({ status: 'saving', error: null });
    let answer: Reconciled<R>;
    try {
      answer = options.reconcile
        ? await options.reconcile(missing.value)
        : { outcome: 'lost' };
    } catch (e) {
      active = false;
      emit({ status: 'error', error: `could not check whether that saved — ${String((e as Error)?.message || e)}`, outstanding: true, unresolved: true });
      return;
    }
    active = false;
    unresolved = null;
    if (answer.outcome === 'committed') {
      // It had landed after all. Treat it exactly as a commit, so the base
      // advances and nothing is written twice.
      const superseded = !!slot && slot.value !== missing.value;
      if (!superseded && slot) { const done = slot; slot = null; settleWaiters(done, true); }
      options.onCommit?.(missing.value, answer.result, superseded);
      emit({ unresolved: false });
      if (superseded) { pump(); return; }
      emit({ status: 'saved', error: null, outstanding: false });
      return;
    }
    // It never landed. The value is still owed to the server; sending it goes
    // through the ordinary path, precondition and all — never a forced write.
    if (!slot) slot = { value: missing.value, waiters: [] };
    emit({ unresolved: false });
    pump();
  };

  const pump = () => {
    if (active) return;
    if (unresolved) { void settleUnresolved(); return; }
    const job = slot;
    if (!job) return;
    slot = null;
    active = true;
    failed = false;
    emit({ status: 'saving', error: null, outstanding: true });
    void (async () => {
      try {
        const result = await withTimeout(options.send(job.value));
        active = false;
        // Anything asked for while this was away outranks it.
        const superseded = !!slot;
        options.onCommit?.(job.value, result, superseded);
        settleWaiters(job, true);
        if (superseded) { pump(); return; }
        emit({ status: 'saved', error: null, outstanding: false });
      } catch (e) {
        active = false;
        const err = e instanceof Error ? e : new Error(String(e));
        const lost = err instanceof TimedOut;
        // A refused write must leave something behind to retry with — unless the
        // caller has already asked for something newer, which replaces it.
        const superseded = !!slot;
        if (lost && !superseded) unresolved = { value: job.value };
        else if (!superseded) { slot = { value: job.value, waiters: [] }; failed = true; }
        options.onFail?.(err, job.value);
        settleWaiters(job, false);
        if (superseded) { pump(); return; }
        emit({ status: 'error', error: err.message, outstanding: true, unresolved: lost });
      }
    })();
  };

  const handle: SaverHandle<T, R> = {
    request: (value: T) => new Promise<boolean>((resolve) => {
      const waiting = slot;
      // The value replaces whatever was waiting; its waiters carry over, because
      // "this or newer is committed" is answered by the newer one landing.
      slot = { value, waiters: waiting ? waiting.waiters : [] };
      slot.waiters.push(resolve);
      failed = false;
      emit({ outstanding: true });
      pump();
    }),
    retry: () => {
      // A lost answer is checked before anything is sent again.
      if (unresolved) { pump(); return Promise.resolve(false); }
      if (!failed || !slot) return Promise.resolve(true);
      return handle.request(slot.value);
    },
    reset: () => {
      if (slot) settleWaiters(slot, false);
      slot = null;
      unresolved = null;
      failed = false;
      emit(IDLE);
    },
    pending: () => (slot ? slot.value : (unresolved ? unresolved.value : null)),
    state: () => state,
    timeout: () => options.timeoutMs ?? null,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    configure: (next) => { options = { ...options, ...next }; },
  };
  return handle;
}

/** Watch a saver that belongs to somebody else (a module, another component). */
export function useSaverState<T, R>(handle: SaverHandle<T, R>): SaverState {
  return useSyncExternalStore(handle.subscribe, handle.state, handle.state);
}

/**
 * A saver owned by one component — the file viewer's case, where the buffer dies
 * with the view anyway. The callbacks are refreshed every render, so a response
 * runs against the current closures rather than the render that sent it.
 */
export function useSaver<T, R>(opts: SaverOptions<T, R>): Saver<T> {
  const handle = useMemo(() => createSaver<T, R>(opts), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => { handle.configure(latest.current); });
  const st = useSaverState(handle);
  const request = useCallback((v: T) => handle.request(v), [handle]);
  const retry = useCallback(() => handle.retry(), [handle]);
  const reset = useCallback(() => handle.reset(), [handle]);
  const pending = useCallback(() => handle.pending(), [handle]);
  // A stable object while nothing has changed: callers hang other memos off this
  // one, and a fresh identity every render turns a viewer that reports itself
  // upward into a render loop.
  return useMemo(
    () => ({ request, retry, reset, pending, ...st }),
    [request, retry, reset, pending, st],
  );
}
