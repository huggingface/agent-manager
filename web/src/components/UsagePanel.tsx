import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import type { ProviderUsage, QuotaWindow, Traces, TraceStats } from '../api';
import {
  DEFAULT_TRACE_SORT,
  firstTraceSortDirection,
  visibleTraceSessions,
  type TraceSort,
  type TraceSortKey,
} from '../lib/usageTraces';
import Logo from './Logo';

const PROVS = [
  { id: 'claude', label: 'Claude Code', color: '#d97757' },
  { id: 'codex', label: 'Codex', color: '#5eb6a6' },
  { id: 'opencode', label: 'OpenCode', color: '#8a93a0' },
  { id: 'hermes', label: 'Hermes', color: '#a78bfa' },
  { id: 'openclaw', label: 'OpenClaw', color: '#c83636' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4796e3' },
];

const TRACE_COLUMNS: { key: TraceSortKey; label: string }[] = [
  { key: 'agent', label: 'agent' },
  { key: 'turns', label: 'turns' },
  { key: 'prompts', label: 'prompts' },
  { key: 'tools', label: 'tools' },
  { key: 'web', label: 'web' },
  { key: 'tokensIn', label: 'tok in' },
  { key: 'tokensOut', label: 'tok out' },
  { key: 'lastTs', label: 'last active' },
];

const fmtTok = (n = 0) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const fmtCost = (n: number) => `$${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)}`;
const resetStr = (s?: number) => {
  if (!s) return '';
  const mins = Math.round((s * 1000 - Date.now()) / 60000);
  if (mins <= 0) return 'resetting';
  if (mins < 60) return `resets in ${mins}m`;
  return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};
const fmtAgo = (ts: number) => {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const topTools = (tools: Record<string, number>) =>
  Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(' · ');

function Bar({ label, q }: { label: string; q?: QuotaWindow }) {
  if (!q || q.usedPercent == null) return null;
  const pct = Math.max(0, Math.min(100, Math.round(q.usedPercent)));
  return (
    <div className="qrow">
      <span className="qlabel">{label}</span>
      <div className="qbar"><div className="qfill" style={{ width: `${pct}%` }} /></div>
      <span className="qpct">{pct}%<span className="s-muted"> {resetStr(q.resetsAt)}</span></span>
    </div>
  );
}

function TraceRow({ label, cli, path, st, strong }: { label: string; cli?: string; path?: string | null; st: TraceStats; strong?: boolean }) {
  const cachePct = st.tokensIn + st.cacheRead > 0 ? Math.round((st.cacheRead / (st.tokensIn + st.cacheRead)) * 100) : 0;
  return (
    <tr className={strong ? 'tr-total' : undefined}>
      <td className="tr-agent" title={path || undefined}>
        {cli && <Logo cli={cli} size={12} />}
        <span>{label}</span>
      </td>
      <td>{st.turns}</td>
      <td>{st.prompts}</td>
      <td title={topTools(st.tools) || undefined}>{st.toolCalls}</td>
      <td>{st.web}</td>
      <td title={`${cachePct}% served from cache (${fmtTok(st.cacheRead)} cached)`}>{fmtTok(st.tokensIn)}</td>
      <td>{fmtTok(st.tokensOut)}</td>
      <td className="tr-when">{fmtAgo(st.lastTs)}</td>
    </tr>
  );
}

function TraceSortHeader({ column, sort, onSort }: {
  column: (typeof TRACE_COLUMNS)[number];
  sort: TraceSort;
  onSort: (key: TraceSortKey) => void;
}) {
  const active = sort.key === column.key;
  const direction = active ? sort.direction : firstTraceSortDirection(column.key);
  return (
    <th aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        className={`tr-sort${active ? ' active' : ''}`}
        aria-label={`Sort by ${column.label}${active ? `, currently ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}`}
        onClick={() => onSort(column.key)}
      >
        <span>{column.label}</span>
        <span className="tr-sort-arrow" aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  );
}

export default function UsagePanel() {
  // Each provider loads independently (undefined = loading, null = failed), so
  // the page frame paints immediately and cards fill in as answers arrive —
  // one hung provider no longer blanks the whole page.
  const [prov, setProv] = useState<Record<string, ProviderUsage | null | undefined>>({});
  const [t, setT] = useState<Traces | null>(null);
  const [sort, setSort] = useState<TraceSort>(DEFAULT_TRACE_SORT);
  const sessions = useMemo(() => t ? visibleTraceSessions(t.sessions, sort) : [], [t, sort]);
  const activateSort = (key: TraceSortKey) => setSort((current) => current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: firstTraceSortDirection(key) });
  useEffect(() => {
    let alive = true;
    for (const p of PROVS) {
      api.getUsage(p.id)
        .then((r) => { if (alive) setProv((m) => ({ ...m, [p.id]: r.providers[p.id] || {} })); })
        .catch(() => { if (alive) setProv((m) => ({ ...m, [p.id]: null })); });
    }
    api.getTraces().then((r) => { if (alive) setT(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div className="usage">
      {PROVS.map((p) => {
        const d = prov[p.id];
        const q = d?.quota;
        return (
          <div key={p.id} className="usage-card">
            <div className="usage-head">
              <span className="status" style={{ background: p.color }} />
              <b>{p.label}</b>
            </div>
            {d === undefined ? (
              <>
                <div className="usage-stats">
                  <div><span className="s-muted">Today</span><span className="skel" style={{ width: 64, height: 12, marginTop: 4 }} /></div>
                  <div><span className="s-muted">This week</span><span className="skel" style={{ width: 64, height: 12, marginTop: 4 }} /></div>
                </div>
                <div className="usage-quota"><span className="skel" style={{ width: '78%' }} /></div>
              </>
            ) : d === null ? (
              <div className="s-help">unavailable — is ccusage installed?</div>
            ) : (
              <>
                <div className="usage-stats">
                  <div>
                    <span className="s-muted">Today</span>
                    <b>{d.tokensToday == null ? '—' : `${fmtTok(d.tokensToday)} tok`}</b>
                    {d.costToday != null && <span className="s-muted">{fmtCost(d.costToday)} est.</span>}
                  </div>
                  <div>
                    <span className="s-muted">This week</span>
                    <b>{d.tokensWeek == null ? '—' : `${fmtTok(d.tokensWeek)} tok`}</b>
                    {d.costWeek != null && <span className="s-muted">{fmtCost(d.costWeek)} est.</span>}
                  </div>
                </div>
                {q ? (
                  <div className="usage-quota">
                    <Bar label="5-hour" q={q.fiveHour} />
                    <Bar label="Weekly" q={q.weekly} />
                    {!q.fiveHour && !q.weekly && <div className="s-help">No quota yet — run a session to populate.</div>}
                  </div>
                ) : p.id === 'gemini' ? (
                  <div className="s-help">No quota (consumer tier deprecated — uses an API key).</div>
                ) : ['opencode', 'hermes', 'openclaw'].includes(p.id) ? (
                  <div className="s-help">No single quota — cost depends on the model provider used by each session.</div>
                ) : (
                  <div className="s-help">No quota yet — run a session to populate.</div>
                )}
              </>
            )}
          </div>
        );
      })}

      <h3>Traces</h3>
      <div className="s-help">
        Parsed from every agent transcript stored on this Space (Claude, Codex, opencode, Hermes, OpenClaw) —
        hover the tools count for the breakdown, tokens-in for the cache share. Zero-token session rows are hidden;
        the total still counts traces of deleted agents and all other parsed activity.
      </div>
      <div className="table-scroll">
        <table className="traces-table">
          <thead>
            <tr>
              {TRACE_COLUMNS.map((column) => (
                <TraceSortHeader key={column.key} column={column} sort={sort} onSort={activateSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {!t ? (
              [0, 1, 2].map((i) => (
                <tr key={i}><td colSpan={8}><span className="skel" style={{ width: `${86 - i * 14}%` }} /></td></tr>
              ))
            ) : (
              <>
                {sessions.length === 0 && (
                  <tr className="tr-empty"><td colSpan={8}>No sessions with recorded tokens</td></tr>
                )}
                {sessions.map((s) => <TraceRow key={s.id} label={s.name} cli={s.cli} path={s.path} st={s} />)}
                <TraceRow label={`total (${t.totals.files} files)`} st={t.totals} strong />
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="s-help">
        Token counts and quota are read from each agent's local logs on the Space. They reflect the state as of that agent's <em>last model call here</em> — running a session updates them; activity outside the Space won't.
      </div>
    </div>
  );
}
