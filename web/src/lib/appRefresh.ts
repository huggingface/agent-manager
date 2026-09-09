/** The tree and metadata are small reads, but a fetch frozen with a backgrounded
 * page must not own the publication slot forever. This matches the reader's
 * bounded-read window without turning ordinary failures into visible UI. */
export const APP_REFRESH_TIMEOUT_MS = 12_000;
export const RETURN_EVENT_COALESCE_MS = 250;

export type RefreshKind = 'replace' | 'poll';

type Timer = ReturnType<typeof setTimeout>;
export interface RefreshClock {
  now(): number;
  setTimeout(run: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
}

const realClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (run, delay) => setTimeout(run, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * One publication slot for one app resource.
 *
 * Polls coalesce behind a live read. Explicit refreshes replace it immediately:
 * abort is sent to the transport, while the local race and generation check
 * also retire transports/mocks that ignore abort. The deadline releases the
 * slot even if neither the request nor its abort ever settles.
 */
export function createLatestRefresh<T>(
  read: (signal: AbortSignal) => Promise<T>,
  publish: (value: T) => void,
  options: { timeoutMs?: number; clock?: RefreshClock } = {},
) {
  const timeoutMs = options.timeoutMs ?? APP_REFRESH_TIMEOUT_MS;
  const clock = options.clock ?? realClock;
  let disposed = false;
  let generation = 0;
  let active: { generation: number; abort: AbortController; promise: Promise<T | null> } | null = null;

  const refresh = (kind: RefreshKind = 'replace'): Promise<T | null> => {
    if (disposed) return Promise.resolve(null);
    if (kind === 'poll' && active) return Promise.resolve(null);

    active?.abort.abort();
    const mine = ++generation;
    const abort = new AbortController();
    let timer: Timer;
    let rejectCanceled: (() => void) | null = null;
    const canceled = new Promise<never>((_, reject) => {
      rejectCanceled = () => reject(new Error('Refresh canceled'));
      abort.signal.addEventListener('abort', rejectCanceled, { once: true });
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = clock.setTimeout(() => {
        abort.abort();
        reject(new Error('Refresh timed out'));
      }, timeoutMs);
    });

    const promise = Promise.race([
      Promise.resolve().then(() => read(abort.signal)),
      canceled,
      deadline,
    ]).then((value) => {
      if (disposed || mine !== generation) return null;
      publish(value);
      return value;
    }).catch(() => null).finally(() => {
      clock.clearTimeout(timer);
      if (rejectCanceled) abort.signal.removeEventListener('abort', rejectCanceled);
      if (active?.generation === mine) active = null;
    });
    active = { generation: mine, abort, promise };
    return promise;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    active?.abort.abort();
    active = null;
  };

  return { refresh, dispose };
}

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Refresh on an actual return/reconnect, not on every focus-shaped event.
 * `blur` and hidden visibility establish that focus/visibility is a return;
 * initial focus and the ordinary non-persisted pageshow therefore do nothing.
 * The first useful event starts immediately, and the rest of its browser-event
 * burst are folded into it for a short window.
 */
export function observeAppReturns(
  refresh: () => void | Promise<unknown>,
  options: {
    window?: ListenerTarget;
    document?: ListenerTarget & { hidden: boolean };
    clock?: Pick<RefreshClock, 'now'>;
    coalesceMs?: number;
  } = {},
) {
  const win = options.window ?? window;
  const doc = options.document ?? document;
  const clock = options.clock ?? realClock;
  const coalesceMs = options.coalesceMs ?? RETURN_EVENT_COALESCE_MS;
  let documentWasHidden = doc.hidden;
  let windowWasBlurred = false;
  // Initial tree/meta reads have just started. Treat this instant as fresh so
  // browser startup noise cannot cancel and duplicate them.
  let lastRefreshAt = clock.now();

  const run = (force = false) => {
    if (doc.hidden) { documentWasHidden = true; return; }
    // Some browsers expose `hidden === false` to focus/pageshow/online before
    // dispatching visibilitychange. Whichever visible event arrives first owns
    // this return, so a later companion cannot force a duplicate refresh.
    const returnedFromHidden = documentWasHidden;
    documentWasHidden = false;
    const now = clock.now();
    if (!force && !returnedFromHidden && now - lastRefreshAt < coalesceMs) return;
    lastRefreshAt = now;
    void refresh();
  };
  const onVisibility = () => {
    if (doc.hidden) { documentWasHidden = true; return; }
    if (documentWasHidden) run();
  };
  const onBlur = () => { windowWasBlurred = true; };
  const onFocus = () => {
    if (!windowWasBlurred) return;
    windowWasBlurred = false;
    run();
  };
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) run();
  };
  const onOnline = () => run();

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
  };
}
