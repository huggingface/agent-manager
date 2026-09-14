// An opt-in counter for terminal touch gestures, for diagnosing a phone we
// cannot attach a debugger to.
//
// Off unless asked for: add `?touchdebug=1` to the URL. It records COUNTERS AND
// TIMINGS ONLY — how many touch events arrived, how far the finger travelled,
// how far the view moved. It never reads terminal contents, keystrokes, or
// anything the session is showing.
//
// What it is for: when a drag delivers less movement than the finger asked for,
// this says WHERE it was lost. `foreign`/`reacq` non-zero means the gesture's
// ownership was disturbed (another finger, or a system cancel). A large `gap`
// means the browser stopped delivering touchmoves — the finger kept moving and
// the page never heard about it, which no amount of scrolling arithmetic can
// fix. `finger` far above `scrolled` with neither of those means the loss is in
// our own conversion.

type Gesture = {
  moves: number; foreign: number; reacq: number; cancels: number;
  finger: number; rows: number; scrolled: number; maxGap: number; ms: number;
};

const blank = (): Gesture => ({ moves: 0, foreign: 0, reacq: 0, cancels: 0, finger: 0, rows: 0, scrolled: 0, maxGap: 0, ms: 0 });

let on = false;
try {
  on = new URLSearchParams(window.location.search).has('touchdebug')
    || window.localStorage.getItem('am-touchdebug') === '1';
} catch { /* storage denied; the query parameter still works */ }

export const touchDebugOn = on;

let now: Gesture = blank();
let startedAt = 0;
let lastMoveAt = 0;
let startTop = 0;
let history: Gesture[] = [];
let box: HTMLElement | null = null;

const line = (g: Gesture) =>
  `moves:${g.moves} foreign:${g.foreign} reacq:${g.reacq} cancel:${g.cancels}`
  + ` finger:${Math.round(g.finger)}px rows:${g.rows} scrolled:${Math.round(g.scrolled)}px`
  + ` gap:${Math.round(g.maxGap)}ms dur:${Math.round(g.ms)}ms`;

const summary = () => {
  const last = history.slice(-12);
  const worst = last.reduce((a, g) => (g.maxGap > a.maxGap ? g : a), last[0] || blank());
  return [
    `am touch diag — last ${last.length} gestures`,
    ...last.map((g, i) => `${String(i + 1).padStart(2)}. ${line(g)}`),
    `worst gap: ${Math.round(worst.maxGap)}ms`,
  ].join('\n');
};

const paint = () => {
  if (!box) return;
  const last = history.slice(-4).reverse();
  box.querySelector('pre')!.textContent = last.map((g) => line(g)).join('\n') || 'drag the terminal…';
};

const ensureBox = () => {
  if (box || !on) return;
  box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:99999;max-width:calc(100vw - 8px);'
    + 'background:rgba(0,0,0,.82);color:#9fe;font:10px/1.35 ui-monospace,monospace;padding:6px 8px;'
    + 'border-radius:6px;pointer-events:auto;white-space:pre-wrap;word-break:break-all';
  box.innerHTML = '<pre style="margin:0"></pre>';
  const copy = document.createElement('button');
  copy.textContent = 'copy';
  copy.style.cssText = 'margin-top:4px;font:10px ui-monospace,monospace;padding:3px 8px';
  copy.onclick = (e) => {
    e.stopPropagation();
    const text = summary();
    navigator.clipboard?.writeText(text).then(
      () => { copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy'; }, 1200); },
      () => {
        // Clipboard is refused without a secure context or a user-gesture
        // grant; show it so it can still be selected by hand.
        const pre = box!.querySelector('pre')!;
        pre.textContent = text;
      },
    );
  };
  box.appendChild(copy);
  document.body.appendChild(box);
  paint();
};

export const touchDebug = {
  start(scrollTop: number) {
    if (!on) return;
    ensureBox();
    now = blank();
    startedAt = performance.now();
    lastMoveAt = startedAt;
    startTop = scrollTop;
  },
  move(dy: number) {
    if (!on) return;
    const t = performance.now();
    now.maxGap = Math.max(now.maxGap, t - lastMoveAt);
    lastMoveAt = t;
    now.moves += 1;
    now.finger += Math.abs(dy);
  },
  foreign() { if (on) now.foreign += 1; },
  reacquire() { if (on) now.reacq += 1; },
  cancel() { if (on) now.cancels += 1; },
  rows(n: number) { if (on) now.rows += Math.abs(n); },
  end(scrollTop: number) {
    if (!on) return;
    now.ms = performance.now() - startedAt;
    now.scrolled = Math.abs(scrollTop - startTop);
    history.push(now);
    if (history.length > 40) history = history.slice(-40);
    paint();
  },
};
