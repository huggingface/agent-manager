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
const fmtCost = (n = 0) => `$${n.toFixed(2)}`;
const resetStr = (s?: number) => {
  if (!s) return '';
  const mins = Math.round((s * 1000 - Date.now()) / 60000);
  if (mins <= 0) return 'resetting';
  if (mins < 60) return `resets in ${mins}m`;
  return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};
const agoStr = (ms?: number) => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
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
  const [busy, setBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const load = () => {
    setBusy(true);
    return api.getUsage()
      .then((d) => { setU(d); setErr(false); setFetchedAt(Date.now()); })
      .catch(() => setErr(true))
      .finally(() => setBusy(false));
  };
  // Refresh on open, on a timer, and when the tab regains focus — the underlying
  // numbers only change when an agent runs, so this just keeps the view current.
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);

  if (err) return <div className="placeholder"><p>Usage data unavailable (is <span className="mono">ccusage</span> installed?).</p></div>;
  if (!u) return <div className="placeholder"><p>Loading…</p></div>;

  return (
    <div className="usage">
      <div className="usage-top">
        <span className="s-muted">
          {fetchedAt ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'Loading…'} · auto every 30s
        </span>
        <span className="spacer" />
        <button className="btn-ghost" onClick={load} disabled={busy}>{busy ? 'Fetching…' : '↻ Refresh'}</button>
      </div>
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
              <div><span className="s-muted">Today</span><b>{fmtTok(d.tokensToday)} tok{d.costToday ? ` · ${fmtCost(d.costToday)}` : ''}</b></div>
              <div><span className="s-muted">This week</span><b>{fmtTok(d.tokensWeek)} tok{d.costWeek ? ` · ${fmtCost(d.costWeek)} est` : ''}</b></div>
            </div>
            {q ? (
              <div className="usage-quota">
                <Bar label="5-hour" q={q.fiveHour} />
                <Bar label="Weekly" q={q.weekly} />
                {!q.fiveHour && !q.weekly && <div className="s-help">No quota snapshot yet — run a session to populate.</div>}
                {q.updatedAt && <div className="s-help">Snapshot {agoStr(q.updatedAt)} — refreshes when {p.label} runs.</div>}
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
        Tokens/cost are read from local logs; cost is an <em>estimated API-equivalent</em> (subscriptions are flat-fee). Quota % is a <em>snapshot</em> captured the last time each agent ran (Claude via its status line, Codex from its logs) — it won't reflect an external reset until you run that agent again.
      </div>
    </div>
  );
}
