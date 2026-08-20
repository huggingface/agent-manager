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
// What this cannot show, by design: the log stores {present, chars, sha256} for
// prompt text and never the text. So this answers who asked whom to do
// something, when, and how big the ask was — never what it said. Equal
// checksums mean identical prompts, which is what a repeating job produces, so
// repeats are marked rather than hidden.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';

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

/** What the Payload column says. Text length, never text. */
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
  return {
    text: isFileRoute(op.path) ? `${what} · ${KB(sum.chars)}` : `${what} · ${sum.chars.toLocaleString()} chars`,
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

  const load = () => api.getOperations(500)
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
        <div className="seg al-view">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Map</button>
        </div>
        <button className="btn-ghost al-refresh" onClick={load}>Refresh</button>
      </div>

      <div className="al-filters">
        <button className={`al-chip${withOperator ? ' on' : ''}`} onClick={() => setWithOperator((v) => !v)}>
          {withOperator ? 'Including your own calls' : `Your own calls hidden${hidden ? ` (${hidden})` : ''}`}
        </button>
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
    window.clearTimeout(hideTimer.current);
    setSel((cur) => (cur?.pinned ? cur : { op, pinned: false }));
  };
  const release = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setSel((cur) => (cur?.pinned ? cur : null)), 220);
  };
  const pin = (op: api.Operation) => { window.clearTimeout(hideTimer.current); setSel({ op, pinned: true }); };
  const hover = sel?.op ?? null;

  const { lanes, marks, born, from, to, dropped } = useMemo(() => {
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
    const xStart = new Map<string, number>();
    const xResolved = new Map<string, number>();
    events.forEach((e, i) => {
      const x = events.length < 2 ? 0.5 : i / (events.length - 1);
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
    return {
      lanes,
      marks,
      born,
      // The axis spans the EVENTS on screen, so a wait that resolved after the
      // last request still ends inside the frame rather than off it.
      from: events.length ? new Date(events[0].t).toISOString() : '',
      to: events.length ? new Date(events[events.length - 1].t).toISOString() : '',
      dropped: Math.max(0, rows.length - MAX_MARKS),
    };
  }, [rows, names]);

  if (!lanes.length) return <div className="s-muted al-empty">Nothing to draw yet.</div>;

  const width = 760;
  const height = TOP + lanes.length * LANE_H + FOOT;
  const laneY = (i: number) => TOP + i * LANE_H + 6;
  const xOf = (t: number) => LEFT + t * (width - LEFT - RIGHT);


  return (
    <div className="al-map">
      <div className="al-mapwrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img"
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
                {b !== undefined && <line x1="2" y1={laneY(i)} x2={xOf(b)} y2={laneY(i)} className="al-lane unborn" />}
                <line x1={b === undefined ? 2 : xOf(b)} y1={laneY(i)} x2={width - 4} y2={laneY(i)} className="al-lane" />
              </g>
            );
          })}
          {marks.map(({ op, x, x0, a, b }) => {
            const back = isWait(op);
            const isNew = !!created(op);
            const src = back ? (b >= 0 ? b : a) : a;
            const dst = back ? a : b;
            const px = xOf(x);
            const on = hover?.id === op.id;
            const cls = `${back ? ' back' : ''}${op.ok ? '' : ' bad'}${isNew ? ' new' : ''}`;
            if (src < 0 || dst < 0 || src === dst) {
              const lane = src >= 0 ? src : dst;
              return (
                <circle key={op.id} cx={px} cy={laneY(lane)} r={on ? 3.4 : 2}
                  className={`al-dot${cls}${on ? ' on' : ''}`}
                  onMouseEnter={() => preview(op)} onMouseLeave={release} onClick={() => pin(op)}>
                  <title>{`${HHMMSS(op.at)} ${op.method} ${op.path}`}</title>
                </circle>
              );
            }
            const y1 = laneY(src) + (dst > src ? 4 : -4);
            const y2 = laneY(dst) + (dst > src ? -6 : 6);
            return (
              <g key={op.id} onMouseEnter={() => preview(op)} onMouseLeave={release} onClick={() => pin(op)}
                className={`al-arrowg${on ? ' on' : ''}`}>
                <title>{`${HHMMSS(op.at)} ${op.method} ${op.path}`}</title>
                {/* how long the caller was blocked, on the caller's own lane */}
                {back && x0 !== undefined && x0 < x && (
                  <line x1={xOf(x0)} y1={laneY(dst)} x2={px} y2={laneY(dst)} className="al-held" />
                )}
                <line x1={px} y1={y1} x2={px} y2={y2}
                  className={`al-arrow${cls}`}
                  markerEnd={`url(#${back ? 'al-arb' : 'al-ar'})`} />
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
          {/* axis and legend, both inside the frame */}
          {from && <text x="2" y={height - 22} className="al-axis">{`${DAY(from)} ${HHMMSS(from).slice(0, 5)} →`}</text>}
          {to && <text x={width - 4} y={height - 22} textAnchor="end" className="al-axis">{HHMMSS(to).slice(0, 5)}</text>}
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
  if (!op) {
    return (
      <div className="al-card al-card-idle">
        Hover a call for the whole entry — who, what it hit, its status, how long it took. Click one to keep it here.
      </div>
    );
  }
  const body = {
    at: op.at,
    call: `${op.method} ${op.path}`,
    from: op.origin ? `${op.origin.name || op.origin.id}${op.origin.type ? ` (${op.origin.type})` : ''}` : null,
    to: whom(op, names) || created(op)?.name || null,
    status: op.status,
    took: took(op.durationMs),
    ...(created(op) ? { created: created(op) } : {}),
    ...(op.query && Object.keys(op.query).length ? { query: op.query } : {}),
    ...(op.request === undefined ? {} : { request: op.request }),
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
      <pre className="al-json">{json(body)}</pre>
      <div className="al-card-foot">
        prompt text is not stored — {'{'}present, chars, sha256{'}'} only
        {!pinned && <span className="al-card-hint"> · click the call to keep this open</span>}
      </div>
    </div>
  );
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
