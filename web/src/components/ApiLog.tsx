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
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';

type View = 'list' | 'map';
type Kind = 'fail' | 'prompt' | 'file';

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

const who = (op: api.Operation) => op.origin?.name || op.origin?.id || '—';
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
  const [origin, setOrigin] = useState('');            // '' = everyone
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [q, setQ] = useState('');

  const load = () => api.getOperations(500)
    .then((d) => { setOps(d.operations); setError(''); })
    .catch(() => setError('could not read the log'));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    api.getTree()
      .then((t) => setNames(new Map(t.sessions.map((s) => [s.id, s.name]))))
      .catch(() => {});
  }, []);

  const origins = useMemo(() => {
    const seen = new Map<string, string>();
    for (const op of ops || []) if (op.origin) seen.set(op.origin.id, op.origin.name || op.origin.id);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [ops]);

  const failures = (ops || []).filter((op) => !op.ok).length;
  const toggle = (k: Kind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));

  const rows = useMemo(() => (ops || []).filter((op) => {
    if (origin && op.origin?.id !== origin) return false;
    if (q && !op.path.toLowerCase().includes(q.toLowerCase())) return false;
    if (!kinds.length) return true;
    return kinds.some((k) => (k === 'fail' ? !op.ok : k === 'prompt' ? isPrompt(op) : isFileRoute(op.path)));
  }), [ops, origin, q, kinds]);

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

  const span = ops && ops.length
    ? `${DAY(ops[ops.length - 1].at)}–${DAY(ops[0].at)}`
    : '';

  return (
    <div className="al">
      <div className="al-head">
        <span className="al-count">{ops ? `${ops.length} calls` : 'loading…'}{span ? ` · ${span}` : ''}</span>
        <div className="seg al-view">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Map</button>
        </div>
        <button className="btn-ghost al-refresh" onClick={load}>Refresh</button>
      </div>

      <div className="al-filters">
        <button className={`al-chip${origin ? '' : ' on'}`} onClick={() => setOrigin('')}>Everyone</button>
        {origins.map(([id, name]) => (
          <button key={id} className={`al-chip${origin === id ? ' on' : ''}`} onClick={() => setOrigin(id)}>{name}</button>
        ))}
        <span className="al-gap" />
        <button className={`al-chip${kinds.includes('fail') ? ' on' : ''}`} onClick={() => toggle('fail')}>
          Only failures ({failures})
        </button>
        <button className={`al-chip${kinds.includes('prompt') ? ' on' : ''}`} onClick={() => toggle('prompt')}>Prompts</button>
        <button className={`al-chip${kinds.includes('file') ? ' on' : ''}`} onClick={() => toggle('file')}>Files</button>
        <input className="al-find mono" placeholder="path contains…" value={q} onChange={(e) => setQ(e.target.value)} />
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
const LANE_H = 46;
const TOP = 26;
const LEFT = 108;      // room for the longest lane label
const RIGHT = 26;
const MAX_LANES = 12;
const MAX_MARKS = 48;

function LogMap({ rows, names }: { rows: api.Operation[]; names: Map<string, string> }) {
  const [hover, setHover] = useState<api.Operation | null>(null);

  const { lanes, marks, from, to, dropped } = useMemo(() => {
    const recent = rows.slice(0, MAX_MARKS).slice().reverse();  // oldest first, left to right
    // Lanes: everything that CALLS above everything that is only called. Then a
    // prompt points down the picture and a resolved wait points back up it,
    // which is the whole claim the legend makes. Sorting by traffic alone put
    // targets above their callers and the two directions stopped meaning
    // anything.
    const made = new Map<string, number>();
    const got = new Map<string, number>();
    const bump = (m: Map<string, number>, name: string) => name && m.set(name, (m.get(name) || 0) + 1);
    for (const op of recent) { bump(made, who(op)); bump(got, whom(op, names)); }
    const byCount = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const callers = byCount(made);
    const lanes = [...callers, ...byCount(got).filter((n) => !made.has(n))].slice(0, MAX_LANES);
    const t0 = recent.length ? new Date(recent[0].at).getTime() : 0;
    const t1 = recent.length ? new Date(recent[recent.length - 1].at).getTime() : 1;
    // x is the call's RANK, not its clock position: real traffic arrives in
    // bursts, and spacing by time collapses a burst into one unreadable column
    // while leaving the quiet hours as empty space. The axis still says what
    // period is on screen.
    const marks = recent.map((op, i) => ({
      op,
      x: recent.length < 2 ? 0.5 : i / (recent.length - 1),
      a: lanes.indexOf(who(op)),
      b: lanes.indexOf(whom(op, names)),
    })).filter((m) => m.a >= 0 || m.b >= 0);
    void t0; void t1;
    return {
      lanes,
      marks,
      from: recent.length ? recent[0].at : '',
      to: recent.length ? recent[recent.length - 1].at : '',
      dropped: Math.max(0, rows.length - MAX_MARKS),
    };
  }, [rows, names]);

  if (!lanes.length) return <div className="s-muted al-empty">Nothing to draw yet.</div>;

  const width = 760;
  const height = TOP + lanes.length * LANE_H + 34;
  const laneY = (i: number) => TOP + i * LANE_H + 8;
  const xOf = (t: number) => LEFT + t * (width - LEFT - RIGHT);

  return (
    <div className="al-map">
      <div className="al-mapwrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img"
          aria-label="Swimlanes: one lane per agent, prompts drawn from caller to target and resolved waits back the other way.">
          <defs>
            <marker id="al-ar" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" />
            </marker>
            <marker id="al-arb" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--muted)" />
            </marker>
          </defs>
          {lanes.map((name, i) => (
            <g key={name}>
              <text x="2" y={laneY(i) - 6} className="al-lane-lbl">{name}</text>
              <line x1="2" y1={laneY(i)} x2={width - 4} y2={laneY(i)} className="al-lane" />
            </g>
          ))}
          {marks.map(({ op, x, a, b }) => {
            const back = isWait(op);
            // A wait is attention coming BACK: it is drawn from the agent that
            // was waited on to the one that waited.
            const src = back ? (b >= 0 ? b : a) : a;
            const dst = back ? a : b;
            const px = xOf(x);
            const on = hover?.id === op.id;
            if (src < 0 || dst < 0 || src === dst) {
              const lane = src >= 0 ? src : dst;
              return (
                <circle key={op.id} cx={px} cy={laneY(lane)} r={on ? 4 : 2.6}
                  className={`al-dot${back ? ' back' : ''}${op.ok ? '' : ' bad'}${on ? ' on' : ''}`}
                  onMouseEnter={() => setHover(op)} onMouseLeave={() => setHover(null)}>
                  <title>{`${HHMMSS(op.at)} ${op.method} ${op.path}`}</title>
                </circle>
              );
            }
            const y1 = laneY(src) + (dst > src ? 5 : -5);
            const y2 = laneY(dst) + (dst > src ? -7 : 7);
            return (
              <g key={op.id} onMouseEnter={() => setHover(op)} onMouseLeave={() => setHover(null)}
                className={`al-arrowg${on ? ' on' : ''}`}>
                <title>{`${HHMMSS(op.at)} ${op.method} ${op.path}`}</title>
                <line x1={px} y1={y1} x2={px} y2={y2}
                  className={`al-arrow${back ? ' back' : ''}${op.ok ? '' : ' bad'}`}
                  markerEnd={`url(#${back ? 'al-arb' : 'al-ar'})`} />
                <circle cx={px} cy={laneY(src)} r="2.6" className={`al-dot${back ? ' back' : ''}${op.ok ? '' : ' bad'}`} />
                {/* a hit area wider than a 1.6px line, or nothing is hoverable */}
                <line x1={px} y1={y1} x2={px} y2={y2} className="al-hit" />
              </g>
            );
          })}
          {from && <text x="2" y={height - 8} className="al-axis">{`${DAY(from)} ${HHMMSS(from).slice(0, 5)} →`}</text>}
          {to && <text x={width - 4} y={height - 8} textAnchor="end" className="al-axis">{HHMMSS(to).slice(0, 5)}</text>}
        </svg>
      </div>
      <div className="al-readout mono">
        {hover
          ? `${HHMMSS(hover.at)}  ${who(hover)}${whom(hover, names) ? ` → ${whom(hover, names)}` : ''}  ${hover.method} ${hover.path}  ${hover.status}  ${took(hover.durationMs)}  ${payloadOf(hover).text}`
          : 'Hover a line for its time, status and payload.'}
      </div>
      <div className="al-legend">
        <span><i className="al-key" /> prompt (caller → target)</span>
        <span><i className="al-key back" /> wait resolved (target → caller)</span>
        <span><i className="al-key dot" /> the call&apos;s own lane</span>
        {dropped > 0 && <span className="s-muted">newest {MAX_MARKS} of {rows.length} drawn</span>}
      </div>
    </div>
  );
}
