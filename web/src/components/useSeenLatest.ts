import { useEffect, useRef } from 'react';
import type { OutputVersion } from '../api';

/**
 * Acknowledge a reply only once it has actually been put in front of the
 * operator.
 *
 * The bar is deliberately higher than "the component rendered". Mounting a
 * conversation, selecting a route, a fetch resolving, or the reader's `At
 * latest` flag all say something about the program, not about what the operator
 * can see. So this asks the browser instead: is the element carrying the latest
 * reply intersecting the viewport, in a foreground tab, on a surface the caller
 * says is the active one?
 *
 * `eligible` is the caller's own honesty check — that what is on screen really
 * is the newest reply and really is complete. A card paged back to an older
 * turn, a clipped answer, a reader scrolled up: all of those render an element
 * that is perfectly visible and are not the thing we would be acknowledging.
 *
 * Fires once per version. A newer reply is a new version, so it needs its own
 * observation; nothing here ever says "mark whatever is latest read".
 */
export function useSeenLatest({ version, eligible, onSeen }: {
  /** The exact output being displayed, or null when there is nothing to claim. */
  version: (OutputVersion & { id: string }) | null;
  /** Caller's guard: is this element really showing that version, in full? */
  eligible: boolean;
  /** Resolves false when nothing was durably stored, which schedules a retry. */
  onSeen: (marks: (OutputVersion & { id: string })[]) => Promise<boolean> | void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const done = useRef<string>('');
  // One attempt at a time for a given version, so a burst of intersection
  // callbacks is one request rather than a queue of identical ones.
  const inFlight = useRef<string>('');
  const cb = useRef(onSeen);
  cb.current = onSeen;

  const key = version ? `${version.id}:${version.src}:${version.seq}:${version.hash}` : '';
  useEffect(() => {
    const el = ref.current;
    if (!el || !version || !eligible || done.current === key) return undefined;

    let cancelled = false;
    const fire = () => {
      if (cancelled || done.current === key || inFlight.current === key) return;
      // A background tab renders and reports intersection perfectly well. The
      // operator is not looking at it.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      // Claimed, not finished. Marking it done here would retire the version on
      // a request that never stored anything: the reply stays unread on the
      // server and this observer refuses to try again for as long as it lives.
      // It becomes done only when the write is confirmed.
      inFlight.current = key;
      Promise.resolve(cb.current([version])).then((ok) => {
        inFlight.current = '';
        // `undefined` means the caller does not report an outcome; treat that as
        // done rather than retrying forever against a caller that cannot answer.
        if (ok !== false) done.current = key;
      }).catch(() => { inFlight.current = ''; });
    };

    // No IntersectionObserver (jsdom, very old browsers): do nothing rather
    // than fall back to "it exists, so it was seen" — the whole point is that
    // presence is not evidence.
    if (typeof IntersectionObserver === 'undefined') return undefined;
    // A slice of the answer is enough: a long reply may not fit the viewport at
    // any scroll position, and demanding all of it would never acknowledge one.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) fire();
    }, { threshold: 0.15 });
    // Scrolling away and back is a fresh chance for a version whose write
    // failed: the observer fires again on re-entry, and `done` was never set.

    io.observe(el);
    // Coming back to the tab with the reply already on screen counts; the
    // observer will not re-fire on its own for an element that never moved.
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || 0;
      if (r.bottom > 0 && r.top < h) fire();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  }, [key, eligible, version]);

  return ref;
}
