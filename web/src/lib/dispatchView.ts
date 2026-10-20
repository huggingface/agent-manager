// The view side of dispatched sessions: icons, their order, and where a
// preview card goes. Only the lazily loaded strip (components/conversation/
// Dispatches.tsx) imports this, so none of it is in the entry chunk; the rules
// the reader itself needs at first paint stay in dispatches.ts.
import { resultOf, type Dispatch, type DispatchResult, type Outcome } from './dispatches';

export type Side = 'running' | 'done' | 'failed';
const sideOf = (o: Outcome): Side => (o === 'running' || o === 'queued' ? 'running' : o === 'failed' ? 'failed' : 'done');

/** One icon: every dispatch this turn made to one session, rolled up. */
export interface PeerIcon {
  key: string;
  name: string;
  cli: string;
  color: string | null;
  exists: boolean;
  targetId: string | null;
  results: DispatchResult[];
  /** the latest dispatch — what the preview shows */
  latest: DispatchResult;
  side: Side;
  /** for the frame: running animates, queued has not started, the rest are finished */
  frame: 'working' | 'waiting' | 'stopped';
  launched: boolean;
  firstAt: number;
  endedAt: number;
}

const endOf = (r: DispatchResult) => (r.x ? r.x.endTs : r.d.at);

export function iconsOf(ds: Dispatch[], now = Date.now()): PeerIcon[] {
  const by = new Map<string, PeerIcon>();
  for (const d of ds) {
    const r = resultOf(d, now);
    const key = d.target.id || d.target.name || d.id;
    let p = by.get(key);
    if (!p) {
      p = {
        key, name: d.target.name || key, cli: d.target.cli || 'shell', color: d.target.color, exists: d.target.exists,
        targetId: d.target.id, results: [], latest: r, side: 'done', frame: 'waiting', launched: false, firstAt: d.at, endedAt: 0,
      };
      by.set(key, p);
    }
    p.results.push(r);
    p.latest = r;
    if (d.kind === 'launch') p.launched = true;
  }
  for (const p of by.values()) {
    const sides = p.results.map((r) => sideOf(r.outcome));
    p.side = sides.includes('running') ? 'running' : sides.includes('failed') ? 'failed' : 'done';
    const live = p.results.find((r) => sideOf(r.outcome) === 'running');
    p.frame = live ? (live.outcome === 'running' ? 'working' : 'stopped') : p.exists ? 'waiting' : 'stopped';
    p.endedAt = Math.max(...p.results.map(endOf));
  }
  return [...by.values()];
}

/**
 * Running on the left in the order they were reached; finished to their right,
 * the most recently finished nearest the running ones; failed at the very right.
 */
export function ordered(icons: PeerIcon[]): PeerIcon[] {
  const run = icons.filter((p) => p.side === 'running').sort((a, b) => a.firstAt - b.firstAt);
  const done = icons.filter((p) => p.side === 'done').sort((a, b) => b.endedAt - a.endedAt);
  const bad = icons.filter((p) => p.side === 'failed').sort((a, b) => b.endedAt - a.endedAt);
  return [...run, ...done, ...bad];
}

// ---------- where the preview card goes ----------

const GAP = 6;        // between the icon and the card
const EDGE = 8;       // the least the card keeps from the viewport's edges

/** The part of the window the operator can see: the visual viewport when there is one. */
export function viewport() {
  const v = window.visualViewport;
  return v ? { left: v.offsetLeft, top: v.offsetTop, width: v.width, height: v.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

type Rect = { left: number; top: number; width: number; height: number };
/** The part of `box` (a DOMRect-like) that is also inside `vp`. */
export function within(box: { left: number; top: number; right: number; bottom: number }, vp: Rect): Rect {
  const left = Math.max(box.left, vp.left);
  const top = Math.max(box.top, vp.top);
  const right = Math.min(box.right, vp.left + vp.width);
  const bottom = Math.min(box.bottom, vp.top + vp.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Where the card goes: below the icon, above it when there is not room below,
 * and — when it fits neither way — on the roomier side with its height capped,
 * scrolling inside itself. Horizontally it starts at the icon and is pushed
 * back on-screen at the edges.
 */
export function placeCard(icon: { left: number; top: number; bottom: number }, card: { width: number; height: number },
  vp: { left: number; top: number; width: number; height: number }) {
  const width = Math.min(card.width, vp.width - 2 * EDGE);
  const left = Math.max(vp.left + EDGE, Math.min(icon.left - 4, vp.left + vp.width - EDGE - width));
  const below = vp.top + vp.height - EDGE - (icon.bottom + GAP);
  const above = icon.top - GAP - (vp.top + EDGE);
  if (card.height <= below) return { left, width, top: icon.bottom + GAP, maxHeight: null as number | null, side: 'below' as const };
  if (card.height <= above) return { left, width, top: icon.top - GAP - card.height, maxHeight: null, side: 'above' as const };
  return below >= above
    ? { left, width, top: icon.bottom + GAP, maxHeight: Math.max(0, below), side: 'below' as const }
    : { left, width, top: vp.top + EDGE, maxHeight: Math.max(0, above), side: 'above' as const };
}

