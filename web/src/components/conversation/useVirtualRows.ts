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
  const [viewport, setViewport] = useState({ top: 0, height: 700 });
  const offsets = useMemo(() => {
    const out = [0];
    for (const key of keys) out.push(out[out.length - 1] + (heights.current.get(key) ?? ESTIMATE));
    return out;
  }, [keys, measurement]);
  const current = useRef({ keys, offsets }); current.current = { keys, offsets };
  const origin = useCallback(() => {
    const el = scroller.current, list = container.current;
    return el && list ? list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
  }, [scroller]);
  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop - origin();
    const { keys: list, offsets: positions } = current.current;
    const index = lower(positions, top);
    anchor.current = list[index] ? { key: list[index], offset: top - positions[index] } : null;
    setViewport((v) => v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight });
  }, [origin, scroller]);
  useLayoutEffect(() => {
    const resize = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey;
        if (!key) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
        if (height > 0 && heights.current.get(key) !== height) { heights.current.set(key, height); changed = true; }
      }
      if (changed) measured((n) => n + 1);
      else update();
    });
    observer.current = resize;
    for (const node of nodes.current.values()) resize.observe(node);
    if (scroller.current) resize.observe(scroller.current);
    return () => { resize.disconnect(); observer.current = null; };
  }, [scroller, update]);
  const measure = useCallback((key: string, node: HTMLElement | null) => {
    const old = nodes.current.get(key);
    if (old === node) return;
    if (old) observer.current?.unobserve(old);
    if (node) { nodes.current.set(key, node); observer.current?.observe(node); }
    else nodes.current.delete(key);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wanted = target.current || anchor.current;
    if (following.current) el.scrollTop = el.scrollHeight;
    else if (wanted) {
      const index = keys.indexOf(wanted.key);
      if (index >= 0) el.scrollTop = origin() + offsets[index] + wanted.offset;
    }
    // Keep an explicit target until its estimate has been measured.
    if (target.current && heights.current.has(target.current.key)) target.current = null;
    update();
  }, [keys, offsets, following, origin, scroller, update]);
  const scrollTo = useCallback((index: number, offset = 0) => {
    const el = scroller.current;
    const { keys: list, offsets: positions } = current.current;
    if (!el || !list[index]) return;
    following.current = false;
    target.current = anchor.current = { key: list[index], offset };
    el.scrollTop = origin() + positions[index] + offset;
    update();
  }, [following, origin, scroller, update]);
  const onScroll = useCallback(() => { target.current = null; update(); }, [update]);
  const start = lower(offsets, Math.max(0, viewport.top - OVERSCAN));
  const end = Math.min(keys.length, lower(offsets, viewport.top + viewport.height + OVERSCAN) + 1);
  return { container, measure, scrollTo, onScroll, anchor, offsets,
    start, end, before: offsets[start], after: offsets[keys.length] - offsets[end] };
}
