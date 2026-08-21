// Settings → API log: what the agents actually did to each other.
//
// Two views over /api/operations, which the manager already writes for every
// call that changes something (plus, since this feature, the one read that is an
// event between two agents — a `wait` that resolved).
//
//   list — one call per LINE. Not per row: per line. A wrapped row halves how
//          many calls fit on a screen, so every cell is nowrap/ellipsis and the
//          path is the one column allowed to take the remaining width.
//   map  — one lane per agent, time left to right, and the calls drawn BETWEEN
//          the lanes: a prompt is an arrow from caller to target, a resolved
//          wait is an arrow back the other way. That return arrow is the whole
//          reason reads are logged at all; without it the picture shows work
//          going out and nothing ever coming back.
//
// The log stores each call WHOLE — body included, on the operator's instruction —
// with credentials the one thing withheld. So this can answer who asked whom to
// do what, when, and in their own words. Equal checksums still mean identical
// prompts, which is what a repeating job produces, so repeats are marked; and
// because an entry is now as big as the call it records, the card decides how
// much of a body to paint rather than trying to paint all of it.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import { renderMarkdown } from '../lib/markdown';

type View = 'list' | 'map';

const HHMMSS = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
const DAY = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** 6ms · 576ms · 18.4s · 4m 18s — always three glyphs of information, never more. */
export function took(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

const KB = (chars: number) => (chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1)} KB`);

/** The summariser stores text as {present, chars, sha256} — sometimes as the
 *  whole body (a prompt), sometimes one field inside it (`input` wraps it in
 *  `text`). Find it either way; anything else has no payload worth a column. */
function textSummary(value: unknown): api.OperationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.chars === 'number') return v as api.OperationSummary;
  for (const inner of Object.values(v)) {
    if (inner && typeof inner === 'object' && typeof (inner as api.OperationSummary).chars === 'number') {
      return inner as api.OperationSummary;
    }
  }
  return null;
}

const isFileRoute = (p: string) => p.startsWith('/api/files') || p.startsWith('/api/skills');
/** A create names nothing in its path — the session it made is in the RESULT.
 *  Without this the call drew as a dot on the caller's lane and the agent it
 *  brought into being appeared to have been there all along. */
const created = (op: api.Operation): { id: string; name: string } | null => {
  if (op.method !== 'POST' || !op.ok) return null;
  if (op.path !== '/api/agents' && op.path !== '/api/sessions') return null;
  const r = op.result as { id?: string; name?: string } | undefined;
  return r?.id ? { id: r.id, name: r.name || r.id } : null;
};
export const isWait = (op: api.Operation) => op.method === 'GET' && /\/wait$/.test(op.path);
const isPrompt = (op: api.Operation) => /\/(prompt|input)$/.test(op.path);

/** The body as sent. Every route's body is kept now, so this is the prompt for a
 *  prompt, the file for a write, and null only when the call carried no body. */
export function promptText(op: api.Operation): string | null {
  const sum = textSummary(op.request) as (api.OperationSummary & { text?: string }) | null;
  return typeof sum?.text === 'string' ? sum.text : null;
}

/** What the Payload column says: how long the ask was. The words are in the card. */
function payloadOf(op: api.Operation): { text: string; sha?: string } {
  if (isWait(op)) {
    const state = (op.result as { state?: string } | undefined)?.state;
    return { text: `resolved · ${state || 'finished'}` };
  }
  const bytes = (op.result as { bytes?: number } | undefined)?.bytes;
  if (typeof bytes === 'number') return { text: `upload · ${KB(bytes)}` };
  const sum = textSummary(op.request);
  if (!sum || !sum.chars) return { text: '—' };
  const what = isFileRoute(op.path) ? 'file' : isPrompt(op) ? 'prompt' : 'body';
  // KB rather than a character count once it stops being something you read
  return {
    text: isFileRoute(op.path) || sum.chars > 100_000
      ? `${what} · ${KB(sum.chars)}`
      : `${what} · ${sum.chars.toLocaleString()} chars`,
    sha: sum.sha256,
  };
}

const statusClass = (op: api.Operation) =>
  (op.ok ? 'ok' : op.status >= 500 ? 'bad' : 'warn');

/** For the MAP: the caller's lane, or nothing. These have to be different. A
 *  `wait` may arrive with no origin — the server keeps that path working for
 *  the watch loops already running — and the em dash is a display fallback, not
 *  an agent. Treating it as one added a lane called "—" and drew a return arrow
 *  into it, inventing a caller the log never knew. Unattributed means a mark on
 *  the lane of whoever was waited ON, which is the one end that IS known. */
const originLane = (op: api.Operation) => op.origin?.name || op.origin?.id || '';
/** For the Who column: something readable, even when nobody was attributed. */
const who = (op: api.Operation) => originLane(op) || '—';
/** The id of whoever the call acted on. `target` is written into the log from
 *  this version on; entries recorded before it have the id in the path, which is
 *  worth digging out so the map is not empty on the day this ships. */
const TARGET_IN_PATH = /^\/api\/(?:agents|sessions|trace|files)\/([^/]+)/;
const targetId = (op: api.Operation) => op.target?.id || (op.path.match(TARGET_IN_PATH) || [])[1] || '';
const whom = (op: api.Operation, names?: Map<string, string>) => {
  const id = targetId(op);
  return op.target?.name || (id && names?.get(id)) || id;
};

// What the CARD is willing to paint. The log stores whole bodies now — a file
// write is megabytes on one line — and a <pre> with five million characters in
// it locks the tab. Nothing is truncated on disk; this is only how much of it
// the viewer draws at once, and it says when it is holding some back.
const SHOW_CHARS = 20_000;
const clip = (text: string) => (text.length > SHOW_CHARS ? text.slice(0, SHOW_CHARS) : text);

export default function ApiLog() {
  const [ops, setOps] = useState<api.Operation[] | null>(null);
  // id → name for sessions that still exist, so an older entry whose target was
  // never recorded still draws with a name rather than an id.
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('list');
  // The operator's own clicks are most of the log and none of the story: this
  // view is for what the AGENTS did to each other. Off by default, and the only
  // filter — the chips and the path search that used to sit here made a screen
  // of controls for a screen of rows.
  const [withOperator, setWithOperator] = useState(false);

  // 200, not 500: entries carry their whole body now, so a page of them is
  // measured in megabytes rather than kilobytes.
  const load = () => api.getOperations(200)
    .then((d) => { setOps(d.operations); setError(''); })
    .catch(() => setError('could not read the log'));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    api.getTree()
      .then((t) => setNames(new Map(t.sessions.map((s) => [s.id, s.name]))))
      .catch(() => {});
  }, []);

  const rows = useMemo(() => (ops || []).filter(
    (op) => withOperator || op.origin?.type !== 'operator',
  ), [ops, withOperator]);
  // how many calls the checkbox is holding back, so ticking it is an informed act
  const hidden = (ops || []).length - rows.length;
  const failures = rows.filter((op) => !op.ok).length;

  // Identical prompts have identical checksums. Counting them is the only thing
  // the log can honestly say about repetition, and it is enough to spot a job
  // that fires the same text on a schedule.
  const repeats = useMemo(() => {
    const n = new Map<string, number>();
    for (const op of rows) {
      const sha = payloadOf(op).sha;
      if (sha) n.set(sha, (n.get(sha) || 0) + 1);
    }
    return n;
  }, [rows]);

  const span = rows.length ? `${DAY(rows[rows.length - 1].at)}–${DAY(rows[0].at)}` : '';

  return (
    <div className="al">
      <div className="al-head">
        <span className="al-count">
          {ops ? `${rows.length} call${rows.length === 1 ? '' : 's'}` : 'loading…'}
          {span ? ` · ${span}` : ''}
          {/* the failure count was a filter chip; it is more useful as a fact */}
          {failures > 0 && <span className="al-fails"> · {failures} failed</span>}
        </span>
        <label className="al-check">
          <input type="checkbox" checked={withOperator} onChange={(e) => setWithOperator(e.target.checked)} />
          show user calls{hidden ? <span className="al-check-n"> ({hidden})</span> : null}
        </label>
        <div className="seg al-view">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Map</button>
        </div>
        <button className="btn-ghost al-refresh" onClick={load}>Refresh</button>
      </div>

      {error && <div className="s-warn">{error}</div>}
      {view === 'list'
        ? <LogTable rows={rows} repeats={repeats} names={names} />
        : <LogMap rows={rows} names={names} />}
      {ops && !rows.length && !error && <div className="s-muted al-empty">No calls match.</div>}
    </div>
  );
}

function LogTable({ rows, repeats, names }: {
  rows: api.Operation[]; repeats: Map<string, number>; names: Map<string, string>;
}) {
  return (
    <div className="al-tblwrap">
      <table className="al-tbl">
        <thead>
          <tr>
            <th>Time</th><th>Who</th><th className="grow">Call</th>
            <th>Status</th><th className="num">Took</th><th>Payload</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((op) => {
            const pay = payloadOf(op);
            const n = pay.sha ? repeats.get(pay.sha) || 0 : 0;
            return (
              <tr key={op.id} title={`${op.at}${whom(op, names) ? ` → ${whom(op, names)}` : ''}`}>
                <td className="al-time">{HHMMSS(op.at)}</td>
                <td className="al-who">{who(op)}</td>
                <td className="grow">
                  <span className={`al-meth${isWait(op) ? ' back' : ''}`}>{op.method}</span>{' '}
                  <span className="al-path">{op.path}</span>
                </td>
                <td className={`al-st ${statusClass(op)}`}>{op.status}</td>
                <td className="num">{took(op.durationMs)}</td>
                <td className="al-pay">
                  {pay.text}
                  {n > 1 && <span className="al-rep" title={`${n} calls with this exact payload — ${pay.sha}`}> ×{n}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- the map ----------------------------------------------------------------
// Geometry follows the approved mock: a labelled hairline per lane, arrows
// drawn between lanes, a dot on the lane the call was made from.
// Denser than the mock: at a real pane width its 46px lanes left the plot mostly
// empty, and the point of the picture is to hold a lot of calls at once.
const LANE_H = 30;
const TOP = 18;
const LEFT = 104;      // room for the longest lane label
const RIGHT = 20;
const FOOT = 40;       // axis + legend, both inside the frame
const MAX_LANES = 14;
const MAX_MARKS = 60;

function LogMap({ rows, names }: { rows: api.Operation[]; names: Map<string, string> }) {
  // Two ways to lay out the same calls. RANKED spaces events evenly, which is
  // what makes a sparse trace readable — a night of nothing does not eat the
  // plot. REAL TIME places them by the clock, which is the only way to see that
  // three prompts went out in the same second. Neither is a substitute for the
  // other, so both exist and ranked is the default.
  const [byClock, setByClock] = useState(false);
  // The window you are looking at, in domain units [0,1] of all the data. null
  // is "everything". Drag horizontally across the plot to set it — the brush
  // every charting library has — double-click or the button to clear it.
  const [win, setWin] = useState<{ a: number; b: number } | null>(null);
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ from: number; moved: boolean; id: number } | null>(null);
  // A drag that happened to start on a mark must not also select it: the click
  // arrives after the pointer is up, so it has to be swallowed once.
  // Selection is committed from the SVG's own pointerup, not from a mark's
  // onClick: brushing captures the pointer, and a captured pointer retargets the
  // trailing click to the capture element, so the mark's onClick never ran. That
  // is why clicking an entry "did nothing" — the handler was on the wrong
  // element, and the earlier test only ever proved a SYNTHETIC click worked.
  // What was pressed is read from the event's own target rather than from
  // mouseenter bookkeeping, which capture and re-renders can both invalidate.
  const pressedRef = useRef<string | null>(null);
  // Hovering previews an entry; CLICKING keeps it. Both are needed: the card is
  // fixed below the plot and its JSON scrolls, so clearing on the mark's
  // mouseleave meant the pointer could never reach the card — the lower half of
  // a long entry could not be read, scrolled or copied. A short grace period
  // carries the pointer across the gap, and a click pins the entry so it
  // survives the pointer going anywhere at all.
  const [sel, setSel] = useState<{ op: api.Operation; pinned: boolean } | null>(null);
  const hideTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const preview = (op: api.Operation) => {
    if (dragRef.current) return;      // dragging out a window, not reading an entry
    window.clearTimeout(hideTimer.current);
    setSel((cur) => (cur?.pinned ? cur : { op, pinned: false }));
  };
  // Leaving a mark no longer empties the card. Two reasons, and the first is a
  // bug the operator diagnosed exactly: the card appearing grows the page, the
  // page growing can add a scrollbar, the scrollbar narrows the layout, the
  // graph shifts left, the cursor is no longer over the mark, the card
  // disappears — and back again, forever. If the card never empties, that loop
  // cannot close. The second is simply that reading an entry means moving the
  // pointer away from a 1px arrow. Hover swaps the card to another entry;
  // nothing but Escape, the ✕, or picking another call takes it away.
  const release = () => window.clearTimeout(hideTimer.current);
  const pin = (op: api.Operation) => {
    window.clearTimeout(hideTimer.current);
    setSel({ op, pinned: true });
  };
  // Escape lets go of a pinned entry without hunting for the ✕.
  useEffect(() => {
    if (!sel?.pinned) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel?.pinned]);
  const hover = sel?.op ?? null;

  const { lanes, marks, born, axis, dropped } = useMemo(() => {
    const recent = rows.slice(0, MAX_MARKS).slice().reverse();  // oldest first, left to right
    // Lanes: everything that CALLS above everything that is only called. Then a
    // prompt points down the picture and a resolved wait points back up it,
    // which is the whole claim the legend makes.
    const made = new Map<string, number>();
    const got = new Map<string, number>();
    const bump = (m: Map<string, number>, name: string) => name && m.set(name, (m.get(name) || 0) + 1);
    const other = (op: api.Operation) => created(op)?.name || whom(op, names);
    for (const op of recent) { bump(made, originLane(op)); bump(got, other(op)); }
    const byCount = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const lanes = [...byCount(made), ...byCount(got).filter((n) => !made.has(n))].slice(0, MAX_LANES);
    // x is RANK, not clock position: real traffic arrives in bursts, and spacing
    // by time collapses a burst into one unreadable column while leaving the
    // quiet hours as empty space. The axis still says what period is on screen.
    //
    // The rank is over EVENTS, not calls, and a wait is two events — issued, and
    // resolved. That is what makes a five-minute wait occupy five minutes' worth
    // of the picture even when nothing else happens while it blocks: snapping its
    // resolution to the nearest other call, as this did first, gave a wait in
    // quiet traffic no span at all, which is the ordinary shape of waiting.
    const events: Array<{ t: number; id: string; end?: boolean }> = [];
    for (const op of recent) {
      const t = new Date(op.at).getTime();
      events.push({ t, id: op.id });
      if (isWait(op) && op.durationMs > 0) events.push({ t: t + op.durationMs, id: op.id, end: true });
    }
    events.sort((a, b) => a.t - b.t);
    const t0 = events.length ? events[0].t : 0;
    const t1 = events.length ? events[events.length - 1].t : 1;
    const xStart = new Map<string, number>();
    const xResolved = new Map<string, number>();
    events.forEach((e, i) => {
      const x = byClock
        ? (t1 === t0 ? 0.5 : (e.t - t0) / (t1 - t0))
        : (events.length < 2 ? 0.5 : i / (events.length - 1));
      (e.end ? xResolved : xStart).set(e.id, x);
    });
    const marks = recent.map((op) => ({
      op,
      // a wait is DRAWN where it resolved; its span reaches back to where it began
      x: xResolved.get(op.id) ?? xStart.get(op.id) ?? 0.5,
      x0: xResolved.has(op.id) ? xStart.get(op.id) : undefined,
      a: lanes.indexOf(originLane(op)),
      b: lanes.indexOf(other(op)),
    })).filter((m) => m.a >= 0 || m.b >= 0);
    // When a lane came into being, if we watched it happen. Before that its line
    // is drawn faint: the agent did not exist, and a solid line all the way to
    // the left edge said it had been there the whole time.
    const born = new Map<string, number>();
    for (const { op, x } of marks) {
      const c = created(op);
      if (c && !born.has(c.name)) born.set(c.name, x);
    }
    // x → time, for labelling any point of the axis (including a brushed edge
    // that falls between two events). In real time this is a straight line; in
    // ranked mode it is piecewise, one segment per event.
    const axis: Array<{ x: number; t: number }> = [];
    events.forEach((e, i) => {
      const x = byClock
        ? (t1 === t0 ? 0.5 : (e.t - t0) / (t1 - t0))
        : (events.length < 2 ? 0.5 : i / (events.length - 1));
      if (!axis.length || axis[axis.length - 1].x !== x) axis.push({ x, t: e.t });
    });
    return {
      lanes,
      marks,
      born,
      // The axis spans the EVENTS on screen — so a wait that resolved after the
      // last request still ends inside the frame — and `axis` is what turns any
      // point of it back into a time, for the labels and the brush readout.
      axis,
      dropped: Math.max(0, rows.length - MAX_MARKS),
    };
  }, [rows, names, byClock]);

  if (!lanes.length) return <div className="s-muted al-empty">Nothing to draw yet.</div>;

  const width = 760;
  const height = TOP + lanes.length * LANE_H + FOOT;
  const laneY = (i: number) => TOP + i * LANE_H + 6;
  const PLOT = width - LEFT - RIGHT;
  // Everything is placed in DOMAIN units and then mapped through the window, so
  // zooming is one function rather than a special case in every mark.
  const lo = win ? win.a : 0;
  const hi = win ? win.b : 1;
  const inWin = (t: number) => t >= lo - 1e-9 && t <= hi + 1e-9;
  const xOf = (t: number) => LEFT + ((t - lo) / (hi - lo)) * PLOT;
  const clampX = (t: number) => LEFT + Math.min(1, Math.max(0, (t - lo) / (hi - lo))) * PLOT;
  // A time for any point on the axis, so a brushed edge can be named.
  const timeAt = (t: number) => {
    if (!axis.length) return 0;
    if (t <= axis[0].x) return axis[0].t;
    for (let i = 1; i < axis.length; i++) {
      if (t <= axis[i].x) {
        const span = axis[i].x - axis[i - 1].x || 1;
        return axis[i - 1].t + ((t - axis[i - 1].x) / span) * (axis[i].t - axis[i - 1].t);
      }
    }
    return axis[axis.length - 1].t;
  };
  const clock = (ms: number) => HHMMSS(new Date(ms).toISOString());
  // A wait counts as visible when any part of the stretch it blocked for is in
  // the window, so zooming into the middle of a five-minute wait still shows it.
  const visible = marks.filter((m) => inWin(m.x) || (m.x0 !== undefined && m.x0 <= hi && m.x >= lo));
  const shown = visible.length;

  // Brushing is MOUSE (and pen) only. A horizontal drag on a phone is how you
  // scroll — the frame scrolls sideways and the page scrolls down — so touch is
  // left alone entirely rather than fighting it for the gesture.
  const domainAt = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return 0;
    // through the SVG's own box, so a frame scrolled sideways needs no correction
    const svgX = ((clientX - box.left) / box.width) * width;
    return lo + Math.min(1, Math.max(0, (svgX - LEFT) / PLOT)) * (hi - lo);
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    pressedRef.current = (e.target as Element)?.closest?.('[data-op]')?.getAttribute('data-op') ?? null;
    // Capture is taken when the drag STARTS, not on press: capturing here sends
    // the mark under the cursor a mouseleave, and losing that would have thrown
    // away the very thing the press is selecting.
    dragRef.current = { from: domainAt(e.clientX), moved: false, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const to = domainAt(e.clientX);
    // a few pixels of slop, so a click on a mark stays a click
    if (!d.moved && Math.abs(to - d.from) * PLOT < 5) return;
    if (!d.moved) svgRef.current?.setPointerCapture(d.id);
    d.moved = true;
    setBrush({ from: d.from, to });
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setBrush(null);
    if (!d) return;
    // A press that did not travel is a selection of whatever it was pressed on.
    if (!d.moved) {
      const op = marks.find((m) => m.op.id === pressedRef.current)?.op;
      if (op) pin(op);
      return;
    }
    const to = domainAt(e.clientX);
    const a = Math.min(d.from, to);
    const b = Math.max(d.from, to);
    // a window narrower than a couple of pixels is a slip, not an intention
    if ((b - a) * PLOT > 4) setWin({ a, b });
  };


  return (
    <div className="al-map">
      <div className="al-mapbar">
        <div className="seg al-scale">
          <button className={byClock ? '' : 'on'} onClick={() => setByClock(false)}>even</button>
          <button className={byClock ? 'on' : ''} onClick={() => setByClock(true)}>real time</button>
        </div>
        {win ? (
          <>
            <button className="btn-ghost al-reset" onClick={() => setWin(null)}>reset zoom</button>
            <span className="al-scale-note al-window">
              {clock(timeAt(win.a))} → {clock(timeAt(win.b))} · {shown} of {marks.length} calls
            </span>
          </>
        ) : (
          <span className="al-scale-note">
            {byClock ? 'spaced by the clock' : 'evenly spaced, one step per event'} · drag across the plot to zoom
          </span>
        )}
      </div>
      <div className="al-mapwrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className={`al-svg${brush ? ' brushing' : ''}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={() => setWin(null)}
          role="img"
          aria-label="Swimlanes: one lane per agent, prompts drawn from caller to target, resolved waits back the other way, and a lane drawn faint until the agent is created.">
          <defs>
            <marker id="al-ar" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" />
            </marker>
            <marker id="al-arb" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--muted)" />
            </marker>
          </defs>
          {lanes.map((name, i) => {
            const b = born.get(name);
            return (
              <g key={name}>
                <text x="2" y={laneY(i) - 5} className={`al-lane-lbl${b !== undefined ? ' new' : ''}`}>{name}</text>
                {/* faint before the agent existed, solid after — clipped to the
                    window, so zooming past the birth shows a solid lane and
                    zooming before it shows a dashed one. */}
                {b !== undefined && b > lo && <line x1={LEFT} y1={laneY(i)} x2={clampX(b)} y2={laneY(i)} className="al-lane unborn" />}
                {b !== undefined && b > lo && <line x1="2" y1={laneY(i)} x2={LEFT} y2={laneY(i)} className="al-lane unborn" />}
                {(b === undefined || b <= hi) && (
                  <line x1={b === undefined || b <= lo ? 2 : clampX(b)} y1={laneY(i)} x2={width - 4} y2={laneY(i)} className="al-lane" />
                )}
              </g>
            );
          })}
          {visible.map(({ op, x, x0, a, b }) => {
            const back = isWait(op);
            const isNew = !!created(op);
            const src = back ? (b >= 0 ? b : a) : a;
            const dst = back ? a : b;
            const px = clampX(x);
            const on = hover?.id === op.id;
            const held = on && !!sel?.pinned;   // selected and staying that way
            const cls = `${back ? ' back' : ''}${op.ok ? '' : ' bad'}${isNew ? ' new' : ''}`;
            if (src < 0 || dst < 0 || src === dst) {
              const lane = src >= 0 ? src : dst;
              return (
                <g key={op.id} data-op={op.id} className={`al-dotg${held ? ' held' : ''}`}
                  onMouseEnter={() => preview(op)} onMouseLeave={release}>
                  <title>{`${HHMMSS(op.at)} ${op.method} ${op.path}`}</title>
                  {held && <circle cx={px} cy={laneY(lane)} r="5" className="al-held-ring" />}
                  <circle cx={px} cy={laneY(lane)} r={on ? 3.4 : 2} className={`al-dot${cls}${on ? ' on' : ''}`} />
                </g>
              );
            }
            const y1 = laneY(src) + (dst > src ? 4 : -4);
            const y2 = laneY(dst) + (dst > src ? -6 : 6);
            return (
              <g key={op.id} data-op={op.id}
                onMouseEnter={() => preview(op)} onMouseLeave={release}
                className={`al-arrowg${on ? ' on' : ''}${held ? ' held' : ''}`}>
                <title>{`${HHMMSS(op.at)} ${op.method} ${op.path}`}</title>
                {/* how long the caller was blocked, on the caller's own lane */}
                {back && x0 !== undefined && x0 < x && (
                  <line x1={clampX(x0)} y1={laneY(dst)} x2={px} y2={laneY(dst)} className="al-held" />
                )}
                <line x1={px} y1={y1} x2={px} y2={y2}
                  className={`al-arrow${cls}`}
                  markerEnd={`url(#${back ? 'al-arb' : 'al-ar'})`} />
                {held && <circle cx={px} cy={laneY(src)} r="5" className="al-held-ring" />}
                <circle cx={px} cy={laneY(src)} r="2" className={`al-dot${cls}`} />
                {/* a create ends on a lane that did not exist a moment ago: an
                    open mark says "this one begins here" where a filled dot
                    would just be one more call */}
                {isNew && <circle cx={px} cy={laneY(dst)} r="3.2" className="al-birth" />}
                {/* a hit area wider than a 1px line, or nothing is hoverable */}
                <line x1={px} y1={y1} x2={px} y2={y2} className="al-hit" />
              </g>
            );
          })}
          {/* what is being dragged out right now */}
          {brush && (
            <g className="al-brushg">
              <rect
                x={clampX(Math.min(brush.from, brush.to))}
                y={TOP - 8}
                width={Math.max(1, Math.abs(clampX(brush.to) - clampX(brush.from)))}
                height={lanes.length * LANE_H + 10}
                className="al-brush"
              />
              <text x={clampX(Math.min(brush.from, brush.to)) + 3} y={TOP - 11} className="al-brush-lbl">
                {clock(timeAt(Math.min(brush.from, brush.to)))} → {clock(timeAt(Math.max(brush.from, brush.to)))}
              </text>
            </g>
          )}
          {/* axis and legend, both inside the frame. The ends follow the window,
              so a zoomed plot says which slice of time it is showing. */}
          <text x="2" y={height - 22} className="al-axis">
            {`${DAY(new Date(timeAt(lo)).toISOString())} ${clock(timeAt(lo)).slice(0, 5)} →`}
          </text>
          <text x={width - 4} y={height - 22} textAnchor="end" className="al-axis">
            {clock(timeAt(hi)).slice(0, 5)}
          </text>
          <g className="al-key">
            <line x1="2" y1={height - 7} x2="18" y2={height - 7} className="al-arrow" markerEnd="url(#al-ar)" />
            <text x="22" y={height - 4}>prompt</text>
            <line x1="72" y1={height - 7} x2="88" y2={height - 7} className="al-arrow back" markerEnd="url(#al-arb)" />
            <text x="92" y={height - 4}>wait, from where it started</text>
            <line x1="228" y1={height - 7} x2="240" y2={height - 7} className="al-arrow new" markerEnd="url(#al-ar)" />
            <circle cx="245" cy={height - 7} r="3.2" className="al-birth" />
            <text x="252" y={height - 4}>created</text>
            <line x1="304" y1={height - 7} x2="320" y2={height - 7} className="al-lane unborn" />
            <text x="324" y={height - 4}>before it existed</text>
            {dropped > 0 && <text x={width - 4} y={height - 4} textAnchor="end">newest {MAX_MARKS} of {rows.length}</text>}
          </g>
        </svg>
      </div>
      {/* Under the plot, not floating over it: a card that follows the cursor
          covers the very lanes you are reading, and clips against a frame that
          scrolls. This one is always the same size and in the same place. */}
      <HoverCard
        op={hover}
        pinned={!!sel?.pinned}
        names={names}
        onEnter={() => window.clearTimeout(hideTimer.current)}
        onLeave={release}
        onClose={() => setSel(null)}
      />
    </div>
  );
}

/** The whole call, pretty-printed, plus the metadata that is not in the body:
 *  who, what it hit, the status and how long it took. The log's request/result
 *  are already summaries — this shows them as they are stored rather than
 *  paraphrasing them into a sentence. */
function HoverCard({ op, pinned, names, onEnter, onLeave, onClose }: {
  op: api.Operation | null;
  pinned: boolean;
  names: Map<string, string>;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  // A prompt is written as markdown by the people and agents writing it, so it
  // is read as markdown here. `Rendered`/`Source` is the file viewer's own
  // control and wording (FilesPane's fv-toggles) rather than a second idiom for
  // the same choice; unlike the file viewer there is nothing to edit.
  const [raw, setRaw] = useState(false);
  if (!op) {
    return (
      <div className="al-card al-card-idle">
        Hover a call for the whole entry — who, what it hit, its status, how long it took. Click one to keep it here.
      </div>
    );
  }
  const text = promptText(op);
  const body = {
    at: op.at,
    call: `${op.method} ${op.path}`,
    from: op.origin ? `${op.origin.name || op.origin.id}${op.origin.type ? ` (${op.origin.type})` : ''}` : null,
    to: whom(op, names) || created(op)?.name || null,
    status: op.status,
    took: took(op.durationMs),
    ...(created(op) ? { created: created(op) } : {}),
    ...(op.query && Object.keys(op.query).length ? { query: op.query } : {}),
    ...(op.request === undefined ? {} : { request: withoutText(op.request) }),
    ...(op.result === undefined ? {} : { result: op.result }),
  };
  return (
    <div className={`al-card${pinned ? ' pinned' : ''}`} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="al-card-head">
        <span className={`al-meth${isWait(op) ? ' back' : ''}`}>{op.method}</span>
        <span className="al-card-path">{op.path}</span>
        <span className={`al-st ${statusClass(op)}`}>{op.status}</span>
        <span className="al-card-took">{took(op.durationMs)}</span>
        {pinned && <button type="button" className="al-card-x" onClick={onClose} aria-label="Release this entry">✕</button>}
      </div>
      {text !== null && (
        <div className="al-prompt">
          <div className="al-prompt-lbl">
            <span>
              body as sent
              {text.length > SHOW_CHARS && (
                <span className="al-clipped">
                  {' '}· showing the first {SHOW_CHARS.toLocaleString()} of {text.length.toLocaleString()} characters
                </span>
              )}
            </span>
            <span className="seg al-md-toggle">
              <button className={raw ? '' : 'on'} onClick={() => setRaw(false)}>Rendered</button>
              <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>Source</button>
            </span>
          </div>
          {raw
            ? <pre className="al-prompt-body">{clip(text)}</pre>
            : (
              <div
                className="markdown al-md"
                /* renderMarkdown sanitizes; the same call the file viewer makes */
                dangerouslySetInnerHTML={{ __html: renderMarkdown(clip(text)) }}
              />
            )}
        </div>
      )}
      <pre className="al-json">{json(body)}</pre>
      <div className="al-card-foot">
        {text === null
          ? 'no prompt on this call — bodies that are not prompts stay summarised'
          : 'stored with the entry; the checksum beside it is what makes a repeated prompt visible'}
        {!pinned && <span className="al-card-hint"> · click the call to keep this open</span>}
      </div>
    </div>
  );
}

/** The prompt is shown as itself, above; JSON-escaped into one line it is
 *  unreadable. Its length and checksum stay in the JSON. */
function withoutText(request: unknown): unknown {
  if (!request || typeof request !== 'object') return request;
  const strip = (v: Record<string, unknown>) => {
    const { text, base64, ...rest } = v;
    // base64 of an upload is not readable and not small; its bytes and checksum
    // are in the entry, and the file itself is on disk.
    if (typeof base64 === 'string') return { ...rest, base64: `[${base64.length.toLocaleString()} chars]` };
    return typeof text === 'string' ? rest : v;
  };
  const top = request as Record<string, unknown>;
  if (typeof top.text === 'string' && typeof top.chars === 'number') return strip(top);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(top)) {
    out[k] = v && typeof v === 'object' && typeof (v as Record<string, unknown>).text === 'string'
      ? strip(v as Record<string, unknown>)
      : v;
  }
  return out;
}

/** JSON with the keys tinted. Small enough not to want a highlighter. */
function json(value: unknown) {
  return JSON.stringify(value, null, 2).split('\n').map((line, i) => {
    const m = line.match(/^(\s*)"([^"]+)":\s?(.*)$/);
    return (
      <span key={i}>
        {m ? <>{m[1]}<span className="al-k">{m[2]}</span>: {m[3]}</> : line}
        {'\n'}
      </span>
    );
  });
}
