import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';

const ESTIMATE = 220;
const OVERSCAN = 700;
const lower = (offsets: number[], value: number) => {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (offsets[mid] <= value) lo = mid; else hi = mid - 1; }
  return Math.min(lo, Math.max(0, offsets.length - 2));
};

/** Measured, keyed rows. Only this scroller moves: no scrollIntoView (which can
 * scroll the pane, deck and document too). Height changes preserve a visible
 * row, or the end when following. Browser scroll anchoring is disabled here so
 * it cannot apply a second, competing correction. */
export function useVirtualRows(keys: string[], scroller: RefObject<HTMLDivElement>, following: MutableRefObject<boolean>) {
  const container = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const heights = useRef(new Map<string, number>());
  const observer = useRef<ResizeObserver | null>(null);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const target = useRef<{ key: string; offset: number } | null>(null);
  const [measurement, measured] = useState(0);
  /**
   * The scroller height the reading position was last asserted against.
   *
   * The reason a height needs remembering: a scroll event is also how the
   * browser reports a correction this hook applied, and one delivered after the
   * content grew looks exactly like the user scrolling away from the bottom.
   * Rather than teach every consumer to tell those apart, the correction is
   * applied in the same frame as the size change (see below), so by the time
   * any scroll event is delivered the position is already right.
   */
  const placedAt = useRef(-1);
  const [viewport, setViewport] = useState({ top: 0, height: 700 });
  const offsets = useMemo(() => {
    const out = [0];
    for (const key of keys) out.push(out[out.length - 1] + (heights.current.get(key) ?? ESTIMATE));
    return out;
  }, [keys, measurement]);
  const current = useRef({ keys, offsets }); current.current = { keys, offsets };
  const keysRef = useRef(keys); keysRef.current = keys;
  /**
   * Is the list this hook owns the thing on screen?
   *
   * The reader can borrow its scroller for something else — an old part of the
   * conversation opened from a search result — and hide this list while it
   * does. Every position below is computed from these rows' boxes, and a
   * `display: none` subtree reports every box as zero, so continuing to read or
   * write the scroll offset against it scrolls the borrower to the top and
   * loses the place the reader was going to come back to.
   */
  const mounted = () => {
    const list = container.current;
    return !!list && (!keysRef.current.length || list.getClientRects().length > 0);
  };
  const origin = useCallback(() => {
    const el = scroller.current, list = container.current;
    return el && list ? list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
  }, [scroller]);
  const update = useCallback(() => {
    const el = scroller.current;
    // Same reason as `mounted()` below: while the scroller is showing something
    // else, its offset says nothing about where this list is being read, and
    // adopting it as the anchor throws away the place to come back to.
    if (!el || !mounted()) return;
    const top = el.scrollTop - origin();
    const { keys: list, offsets: positions } = current.current;
    const index = lower(positions, top);
    anchor.current = list[index] ? { key: list[index], offset: top - positions[index] } : null;
    setViewport((v) => v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight });
  }, [origin, scroller]);
  /**
   * Re-assert the current reading intent from the MODEL: the end when
   * following, otherwise the anchored row's offset in `offsets`.
   *
   * This is the right source immediately after a render, where `offsets` is
   * fresh and the anchored row may not even be mounted. `hold()` below is the
   * same intent read from the DOM instead, for the moments when `offsets` is
   * the stale one.
   */
  const place = useCallback(() => {
    const el = scroller.current;
    if (!el || !mounted()) return;
    const put = (top: number) => { el.scrollTop = top; placedAt.current = el.scrollHeight; };
    if (following.current) { put(el.scrollHeight); return; }
    const wanted = target.current || anchor.current;
    if (!wanted) return;
    const { keys: list, offsets: positions } = current.current;
    const index = list.indexOf(wanted.key);
    if (index >= 0) put(origin() + positions[index] + wanted.offset);
  }, [following, origin, scroller]);
  /**
   * Hold the reading position using the DOM, not the model.
   *
   * Runs inside the ResizeObserver callback, which is before paint — the
   * correction has to land in the same frame as the size change. Waiting for
   * React to re-render from the new heights is one frame too late, and that
   * frame is visible: a prepended page measured taller than its estimate
   * dropped the text on screen ~217px and the next frame pulled it back.
   *
   * Measured rather than computed because `offsets` is rebuilt in a later
   * render pass and is stale here by definition, and a correction from stale
   * offsets is its own jump. The anchor says "the top of the viewport is
   * `offset` px into row `key`", which the row's live box answers directly.
   */
  const hold = useCallback(() => {
    const el = scroller.current;
    if (!el || !mounted()) return;
    placedAt.current = el.scrollHeight;
    if (following.current) { el.scrollTop = el.scrollHeight; return; }
    const wanted = target.current || anchor.current;
    const node = wanted && nodes.current.get(wanted.key);
    if (!wanted || !node) return;
    const rowTop = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = rowTop + wanted.offset;
  }, [following, scroller]);
  useLayoutEffect(() => {
    const resize = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey;
        if (!key) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
        if (height > 0 && heights.current.get(key) !== height) { heights.current.set(key, height); changed = true; }
      }
      // Before paint, whatever changed: a row that grew past its estimate, the
      // scroller itself, a font settling. Only then let React catch up.
      hold();
      if (changed) measured((n) => n + 1);
      else update();
    });
    observer.current = resize;
    for (const node of nodes.current.values()) resize.observe(node);
    if (scroller.current) resize.observe(scroller.current);
    return () => { resize.disconnect(); observer.current = null; };
  }, [hold, scroller, update]);
  const measure = useCallback((key: string, node: HTMLElement | null) => {
    const old = nodes.current.get(key);
    if (old === node) return;
    if (old) observer.current?.unobserve(old);
    if (node) { nodes.current.set(key, node); observer.current?.observe(node); }
    else nodes.current.delete(key);
  }, []);
  useLayoutEffect(() => {
    if (!scroller.current) return;
    place();
    // Keep an explicit target until its estimate has been measured.
    if (target.current && heights.current.has(target.current.key)) target.current = null;
    update();
  }, [keys, offsets, place, scroller, update]);
  const scrollTo = useCallback((index: number, offset = 0) => {
    const el = scroller.current;
    const { keys: list, offsets: positions } = current.current;
    if (!el || !list[index]) return;
    following.current = false;
    target.current = anchor.current = { key: list[index], offset };
    el.scrollTop = origin() + positions[index] + offset;
    placedAt.current = el.scrollHeight;
    update();
  }, [following, origin, scroller, update]);
  // scrollTo itself emits a scroll event. Keep its semantic target until the
  // row is measured, even if its saved offset exceeds the initial estimate.
  // Only fresh user input should cancel that pending restoration.
  const cancelTarget = useCallback(() => { target.current = null; }, []);
  /**
   * Real conversation height, in pixels that were actually measured.
   *
   * Estimated row heights and the spacer divs are excluded on purpose: the
   * question this answers is "is a page of conversation really available", and
   * an estimate cannot answer it. Unmeasured rows count as zero, so the number
   * is a lower bound — it can ask for one page too many, never one too few.
   */
  const measuredHeight = useCallback(
    () => keys.reduce((sum, key) => sum + (heights.current.get(key) ?? 0), 0),
    [keys],
  );
  /**
   * After every commit, before paint, and last of this hook's effects: if the
   * scroller is a different height than when the position was last asserted,
   * assert it again.
   *
   * The height is the trigger because it is the thing that actually moves text,
   * and the renders that change it are not the renders `keys`/`offsets` can
   * describe. A prepend commits with a viewport-derived row slice computed from
   * the PREVIOUS scroll position; the effect above then corrects the viewport,
   * which re-renders with the right slice and a different real height — and
   * that render changes neither the keys nor the offsets, so no effect keyed on
   * them runs for it. The frame it painted was a visible jump, undone only when
   * the newly observed rows reported in on the following frame.
   *
   * Deliberately no `update()`: reading the anchor back here would adopt the
   * displaced position instead of correcting it, and would make this a loop.
   */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollHeight === placedAt.current) return;
    hold();
  });
  const start = lower(offsets, Math.max(0, viewport.top - OVERSCAN));
  const end = Math.min(keys.length, lower(offsets, viewport.top + viewport.height + OVERSCAN) + 1);
  return { container, measure, scrollTo, onScroll: update, cancelTarget, anchor, offsets, measuredHeight,
    start, end, before: offsets[start], after: offsets[keys.length] - offsets[end] };
}
