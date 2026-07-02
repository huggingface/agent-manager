import { useEffect, useState } from 'react';
import * as api from '../api';
import type { Usage, QuotaWindow, Traces, TraceStats } from '../api';
import Logo from './Logo';

const PROVS = [
  { id: 'claude', label: 'Claude Code', color: '#d97757' },
  { id: 'codex', label: 'Codex', color: '#5eb6a6' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4796e3' },
];

const fmtTok = (n = 0) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
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

export default function UsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  const [t, setT] = useState<Traces | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api.getUsage().then(setU).catch(() => setErr(true));
    api.getTraces().then(setT).catch(() => {});
  }, []);

  if (err) return <div className="usage-msg mono">usage unavailable — is ccusage installed?</div>;
  if (!u) return <div className="usage-msg mono">reading usage…<span className="et-cursor" /></div>;

  return (
    <div className="usage">
      {PROVS.map((p) => {
        const d = u.providers[p.id] || {};
        const q = d.quota;
        return (
          <div key={p.id} className="usage-card">
            <div className="usage-head">
              <span className="status" style={{ background: p.color, boxShadow: `0 0 6px ${p.color}` }} />
              <b>{p.label}</b>
            </div>
            <div className="usage-stats">
              <div><span className="s-muted">Today</span><b>{fmtTok(d.tokensToday)} tok</b></div>
              <div><span className="s-muted">This week</span><b>{fmtTok(d.tokensWeek)} tok</b></div>
            </div>
            {q ? (
              <div className="usage-quota">
                <Bar label="5-hour" q={q.fiveHour} />
                <Bar label="Weekly" q={q.weekly} />
                {!q.fiveHour && !q.weekly && <div className="s-help">No quota yet — run a session to populate.</div>}
              </div>
            ) : p.id === 'gemini' ? (
              <div className="s-help">No quota (consumer tier deprecated — uses an API key).</div>
            ) : (
              <div className="s-help">No quota yet — run a session to populate.</div>
            )}
          </div>
        );
      })}

      <h3>Traces</h3>
      <div className="s-help">
        Parsed from every Claude Code transcript and Codex rollout stored on this Space —
        hover the tools count for the breakdown, tokens-in for the cache share.
      </div>
      {!t ? (
        <div className="usage-msg mono">analyzing traces…<span className="et-cursor" /></div>
      ) : t.totals.files === 0 ? (
        <div className="usage-msg mono">no traces yet — run a Claude or Codex session.</div>
      ) : (
        <table className="traces-table">
          <thead>
            <tr><th>agent</th><th>turns</th><th>prompts</th><th>tools</th><th>web</th><th>tok in</th><th>tok out</th><th>last active</th></tr>
          </thead>
          <tbody>
            {t.sessions.map((s) => <TraceRow key={s.id} label={s.name} cli={s.cli} path={s.path} st={s} />)}
            {t.other && <TraceRow label={`other traces (${t.other.files} files)`} st={t.other} />}
            <TraceRow label={`total (${t.totals.files} files)`} st={t.totals} strong />
          </tbody>
        </table>
      )}

      <div className="s-help">
        Token counts and quota are read from each agent's local logs on the Space. They reflect the state as of that agent's <em>last model call here</em> — running a session updates them; activity outside the Space won't.
      </div>
    </div>
  );
}
