import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// One writer per thing being saved.
//
// Saves lose work in two ways, and both of them look like success. Two writes
// in flight at once land in whichever order the server happens to finish them,
// so the last word belongs to nobody in particular. And a response that arrives
// after the user has typed again describes a version that is already history:
// acting on it — clearing the draft, saying "saved" — either throws the newer
// text away or lies about where it is.
//
// So there is one request at a time and a single pending slot holding the
// LATEST value asked for, never a queue of stale revisions. When the write
// settles, whatever is waiting goes out immediately: no timer stands between an
// edit and its save, and none stands between one write and the next. A response
// may only speak for the editor — clear its draft, report it saved — if nothing
// newer was asked for while it was away, which is what `superseded` reports.
//
// The policy of *when* to ask is the caller's: settings ask on every change,
// files ask when the user says so. Both need the same ordering guarantees.

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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
  status: SaveStatus;
  /** The message from the failed attempt, while `status` is 'error'. */
  error: string | null;
  /** Something asked for is not on the server yet. */
  outstanding: boolean;
};

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
};

export function useSaver<T, R>(opts: SaverOptions<T, R>): Saver<T> {
  // Read at fire time: these callbacks close over the render that made them, and
  // a response outlives it.
  const cb = useRef(opts);
  cb.current = opts;

  const active = useRef(false);
  const slot = useRef<{ value: T; waiters: ((ok: boolean) => void)[] } | null>(null);
  const failed = useRef(false);
  // Unmounting stops the reporting, not the work: a change already asked for is
  // still owed to the server, so closing the panel it was made in must not be a
  // way to lose it.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outstanding, setOutstanding] = useState(false);

  const pump = useCallback(() => {
    if (active.current) return;
    const job = slot.current;
    if (!job) return;
    slot.current = null;
    active.current = true;
    failed.current = false;
    if (mounted.current) { setStatus('saving'); setError(null); setOutstanding(true); }
    void (async () => {
      try {
        const result = await cb.current.send(job.value);
        active.current = false;
        // Anything asked for while this was away outranks it.
        const superseded = !!slot.current;
        cb.current.onCommit?.(job.value, result, superseded);
        job.waiters.forEach((w) => w(true));
        if (superseded) { pump(); return; }
        if (!mounted.current) return;
        setStatus('saved'); setOutstanding(false);
      } catch (e) {
        active.current = false;
        const err = e instanceof Error ? e : new Error(String(e));
        // A refused write must leave something behind to retry with — unless the
        // caller has already asked for something newer, which replaces it.
        const superseded = !!slot.current;
        if (!superseded) { slot.current = { value: job.value, waiters: [] }; failed.current = true; }
        cb.current.onFail?.(err, job.value);
        job.waiters.forEach((w) => w(false));
        if (superseded) { pump(); return; }
        if (!mounted.current) return;
        setStatus('error'); setError(err.message); setOutstanding(true);
      }
    })();
  }, []);

  const request = useCallback((value: T) => new Promise<boolean>((resolve) => {
    const waiting = slot.current;
    // The value replaces whatever was waiting; its waiters carry over, because
    // "this or newer is committed" is answered by the newer one landing.
    slot.current = { value, waiters: waiting ? waiting.waiters : [] };
    slot.current.waiters.push(resolve);
    failed.current = false;
    if (mounted.current) setOutstanding(true);
    pump();
  }), [pump]);

  const retry = useCallback(() => {
    const waiting = slot.current;
    if (!failed.current || !waiting) return Promise.resolve(true);
    return request(waiting.value);
  }, [request]);

  const reset = useCallback(() => {
    slot.current = null;
    failed.current = false;
    setStatus('idle'); setError(null); setOutstanding(false);
  }, []);

  // Presentation only: the tick fades, and it has never gated a write.
  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('idle'), 1800);
    return () => clearTimeout(t);
  }, [status]);

  // A stable object while nothing has changed: callers hang other memos off this
  // one, and a fresh identity every render turns a viewer that reports itself
  // upward into a render loop.
  return useMemo(
    () => ({ request, retry, reset, status, error, outstanding }),
    [request, retry, reset, status, error, outstanding],
  );
}
