// An opt-in observer for terminal touch gestures, for diagnosing a phone we
// cannot attach a debugger to.
//
// Off unless asked for: `?touchdebug=1`. It records COUNTERS, TIMINGS AND
// STRUCTURAL LABELS ONLY — how many events arrived, on what kind of element,
// how far the finger travelled and what actually scrolled. It never reads
// terminal contents, keystrokes, or anything the session is showing.
//
// Why it watches the DOCUMENT rather than only the terminal's own handler:
// the first version could only add a row from the terminal's touchend, so a
// gesture that never reached that handler — landing on another element, in
// reader mode where the handler stands down, or scrolling natively because
// `touch-action: none` is only applied under `max-width: 720px` — left the box
// unchanged and looked like nothing happened. An empty box has to mean "no
// touch reached the page", not "the path I instrumented was not the path used".

type Row = {
  target: string;        // structural label of where the finger landed
  mode: string;          // what the pane was showing
  starts: number; moves: number; ends: number; cancels: number;
  seen: number;          // touchmoves the terminal handler actually processed
  foreign: number; reacq: number;
  finger: number;        // px of finger travel, from the raw events
  rows: number;          // rows the terminal handler applied
  scrolled: string;      // what moved, and by how much
  maxGap: number; ms: number;
  open: boolean;         // still in progress / never completed
};

let on = false;
try {
  on = new URLSearchParams(window.location.search).has('touchdebug')
    || window.localStorage.getItem('am-touchdebug') === '1';
} catch { /* storage denied; the query parameter still works */ }
export const touchDebugOn = on;

const CLASSES = /^(term-host|xterm|xterm-viewport|xterm-screen|cxv-body|cxv|tile-terminal|pane|mbar|keybar|kb|sidebar|row|app|main|stage|am-touchdiag)/;
// A short "where did this land" label: the nearest few meaningful classes.
const label = (node: EventTarget | null) => {
  const parts: string[] = [];
  const start = node instanceof Element ? node : null;
  // Innermost first: what the finger actually landed on matters more than the
  // frame around it, and two levels is enough to tell these regions apart.
  for (let el = start, hop = 0; el && hop < 8 && parts.length < 2; hop++, el = el.parentElement) {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
    const hit = cls.find((c) => CLASSES.test(c));
    if (hit && parts[parts.length - 1] !== hit) parts.push(hit);
  }
  if (parts.length) return parts.reverse().join('>');
  return start?.tagName?.toLowerCase() || '?';
};

const paneMode = () => {
  if (document.querySelector('.term-host.reading')) return 'reader';
  if (document.querySelector('.tile-terminal:not(.tile-cached) .term-host')) return 'terminal';
  return 'other';
};

const blank = (target: string): Row => ({
  target, mode: paneMode(), starts: 0, moves: 0, ends: 0, cancels: 0, seen: 0,
  foreign: 0, reacq: 0, finger: 0, rows: 0, scrolled: '', maxGap: 0, ms: 0, open: true,
});

let row: Row | null = null;
let rows: Row[] = [];
let startedAt = 0;
let lastMoveAt = 0;
let lastY = 0;
let scrolls: Record<string, number> = {};
let scrollAt: Record<string, number> = {};
let box: HTMLElement | null = null;
let pre: HTMLElement | null = null;
let idle = 0;
let closedAt = 0;

const scrolledText = () => Object.entries(scrolls).map(([k, v]) => `${k}:${Math.round(v)}px`).join(' ');
const fmt = (r: Row) =>
  `${r.open ? '*' : ' '}${r.target} [${r.mode}]`
  + ` s:${r.starts} m:${r.moves} e:${r.ends} c:${r.cancels}`
  + ` seen:${r.seen} fgn:${r.foreign} re:${r.reacq}`
  + ` finger:${Math.round(r.finger)} rows:${r.rows}`
  + ` moved:${(r === row ? scrolledText() : r.scrolled) || 'none'} gap:${Math.round(r.maxGap)}ms dur:${Math.round(r.ms)}ms`;

const paint = () => {
  if (!pre) return;
  const recent = rows.slice(-3).reverse();
  pre.textContent = (row ? [fmt(row), ...recent.map(fmt)] : recent.map(fmt)).join('\n') || 'drag the terminal…';
};

const close = () => {
  if (!row) return;
  row.open = row.ends === 0 && row.cancels === 0;
  row.ms = performance.now() - startedAt;
  row.scrolled = scrolledText();
  rows.push(row);
  if (rows.length > 40) rows = rows.slice(-40);
  row = null;
  closedAt = performance.now();
  paint();
};

const bump = () => {
  window.clearTimeout(idle);
  // A gesture that never completes must still appear, or "no new row" cannot be
  // told apart from "no touch at all".
  idle = window.setTimeout(close, 1200);
};

const summary = () => [
  `am touch diag — last ${Math.min(rows.length, 12)} gestures (* = never completed)`,
  ...rows.slice(-12).map((r, i) => `${String(i + 1).padStart(2)}.${fmt(r)}`),
].join('\n');

const ensureBox = () => {
  if (box) return;
  box = document.createElement('div');
  // TOP of the screen and transparent to touch: at the bottom, and hit-testable,
  // it sat exactly where a thumb rests and could swallow the very gestures it
  // was meant to measure.
  box.className = 'am-touchdiag';
  box.style.cssText = 'position:fixed;left:2px;top:2px;right:2px;z-index:99999;pointer-events:none;'
    + 'background:rgba(0,0,0,.8);color:#9fe;font:9px/1.3 ui-monospace,monospace;padding:4px 5px;'
    + 'border-radius:5px;white-space:pre-wrap;word-break:break-all';
  pre = document.createElement('pre');
  pre.style.cssText = 'margin:0';
  box.appendChild(pre);
  const copy = document.createElement('button');
  copy.textContent = 'copy';
  // The one hit-testable thing, and it is small and at the top.
  copy.style.cssText = 'pointer-events:auto;margin-top:3px;font:9px ui-monospace,monospace;padding:2px 8px';
  copy.onclick = (e) => {
    e.stopPropagation();
    const text = summary();
    navigator.clipboard?.writeText(text).then(
      () => { copy.textContent = 'copied'; window.setTimeout(() => { copy.textContent = 'copy'; }, 1200); },
      () => { pre!.textContent = text; },
    );
  };
  box.appendChild(copy);
  document.body.appendChild(box);
  paint();
};

/** Watches the document, so a gesture is recorded whatever it lands on. */
export function installTouchDebug() {
  if (!on || box) return;
  ensureBox();
  const opts = { capture: true, passive: true } as const;

  document.addEventListener('touchstart', (e: TouchEvent) => {
    if ((e.target as Element)?.closest?.('.am-touchdiag')) return;  // our own UI
    if (row) close();
    row = blank(label(e.target));
    scrolls = {};
    startedAt = performance.now();
    lastMoveAt = startedAt;
    lastY = e.touches[0]?.clientY ?? 0;
    row.starts = 1;
    bump(); paint();
  }, opts);

  document.addEventListener('touchmove', (e: TouchEvent) => {
    if (!row) { row = blank(`${label(e.target)}(no-start)`); startedAt = performance.now(); lastMoveAt = startedAt; lastY = e.touches[0]?.clientY ?? 0; scrolls = {}; }
    const y = e.touches[0]?.clientY ?? lastY;
    const t = performance.now();
    row.maxGap = Math.max(row.maxGap, t - lastMoveAt);
    lastMoveAt = t;
    row.moves += 1;
    row.finger += Math.abs(lastY - y);
    lastY = y;
    row.ms = t - startedAt;
    bump(); paint();
  }, opts);

  document.addEventListener('touchend', (e: TouchEvent) => {
    if ((e.target as Element)?.closest?.('.am-touchdiag')) return;
    if (row) { row.ends += 1; close(); }
  }, opts);

  document.addEventListener('touchcancel', () => {
    if (row) { row.cancels += 1; close(); }
  }, opts);

  // Scroll does not bubble, but capture on the document sees every element's.
  document.addEventListener('scroll', (e: Event) => {
    const el = e.target as Element & { scrollTop?: number };
    if (!el || typeof el.scrollTop !== 'number') return;
    const key = label(el);
    const previous = scrollAt[key];
    scrollAt[key] = el.scrollTop;
    if (previous === undefined) return;            // first sighting sets the origin
    // A scroll with no gesture open is the interesting case: something moved
    // the view without a touch this instrumentation ever saw.
    const delta = Math.abs(el.scrollTop - previous);
    if (!row) {
      // Ignore the settle that trails a gesture, and anything too small to see;
      // what is worth a row of its own is a real move with no touch behind it.
      if (delta < 8 || performance.now() - closedAt < 500) { return; }
      row = blank(`${key}(scroll-only)`);
      startedAt = performance.now();
      lastMoveAt = startedAt;
    }
    scrolls[key] = (scrolls[key] ?? 0) + delta;
    bump(); paint();
  }, opts);

  // Not every one-line move has to come from touch.
  document.addEventListener('wheel', (e: WheelEvent) => {
    if (!row) row = blank(`${label(e.target)}(wheel)`);
    row.moves += 1; row.finger += Math.abs(e.deltaY);
    bump(); paint();
  }, opts);
}

/** Called by the terminal's own handler, so its view can be compared with the
 *  document's. A gesture the handler never saw shows seen:0 against moves:N. */
export const touchDebug = {
  seen() { if (on && row) { row.seen += 1; paint(); } },
  foreign() { if (on && row) row.foreign += 1; },
  reacquire() { if (on && row) row.reacq += 1; },
  cancel() { if (on && row) row.cancels += 1; },
  rows(n: number) { if (on && row) row.rows += Math.abs(n); },
};
