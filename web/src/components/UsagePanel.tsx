import { useEffect, useState } from 'react';
import * as api from '../api';
import type { Usage, QuotaWindow } from '../api';

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

export default function UsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { api.getUsage().then(setU).catch(() => setErr(true)); }, []);

  if (err) return <div className="placeholder"><p>Usage data unavailable (is <span className="mono">ccusage</span> installed?).</p></div>;
  if (!u) return <div className="placeholder"><p>Loading…</p></div>;

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
      <div className="s-help">
        Token counts and quota are read from each agent's local logs on the Space. They reflect the state as of that agent's <em>last model call here</em> — running a session updates them; activity outside the Space won't.
      </div>
    </div>
  );
}
