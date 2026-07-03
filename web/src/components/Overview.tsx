import { useEffect, useState } from 'react';
import * as api from '../api';
import type { MetaSession } from '../api';
import type { Cli, SessionState } from '../types';
import { STATE_LABEL } from '../types';
import Logo from './Logo';

const RANK: Record<SessionState, number> = { working: 0, waiting: 1, idle: 2, stopped: 3 };
const fmtAgo = (ts: number) => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const base = (p: string) => p.split('/').pop() || p;

function Card({ s, color, onOpen }: { s: MetaSession; color?: string; onOpen: (sid: string) => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const d = s.digest;
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await api.sendInput(s.id, text);
      setDraft('');
      setNote(r.started ? 'started + sent' : 'sent');
    } catch {
      setNote('failed — is the agent running?');
    }
    setBusy(false);
    setTimeout(() => setNote(''), 4000);
  };
  const digestLine = d && (d.sinceTurns || d.sinceToolCalls)
    ? `${d.sinceTurns} turn${d.sinceTurns === 1 ? '' : 's'} · ${d.sinceToolCalls} tool call${d.sinceToolCalls === 1 ? '' : 's'}${d.sinceFiles.length ? ` · ${d.sinceFiles.map(base).join(', ')}` : ''}`
    : null;

  return (
    <div className="ov-card">
      <div className="ov-head">
        <Logo cli={s.cli} size={13} tint={color} />
        <span className="ov-name mono">{s.name}</span>
        {s.path && <span className="ov-path mono">{s.path}</span>}
        <span className="spacer" />
        <span className={`status ${s.state}`} />
        <span className="ov-state">{STATE_LABEL[s.state]}</span>
        <button className="mini-btn" title="Open pane" onClick={() => onOpen(s.id)}>open</button>
      </div>

      {d && d.lastPromptText ? (
        <div className="ov-you">
          <span className="ov-lbl">you</span>
          <span className="ov-you-text">{d.lastPromptText}</span>
          <span className="ov-ago">{fmtAgo(d.lastPromptTs)}</span>
        </div>
      ) : (
        <div className="ov-none">{d ? 'no prompt yet' : 'no trace digest for this CLI'}</div>
      )}
      {digestLine && <div className="ov-digest mono">{digestLine}</div>}
      {d && d.lastAssistantText && (
        <div className="ov-last">
          <span className="ov-lbl">last</span>
          <span className="ov-last-text">{d.lastAssistantText}</span>
        </div>
      )}

      <div className="ov-reply">
        <input
          value={draft}
          placeholder={s.running ? 'reply…' : 'prompt (wakes the agent)…'}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button className="btn-ghost" disabled={busy || !draft.trim()} onClick={send}>{busy ? '…' : 'send'}</button>
      </div>
      {note && <div className="ov-note">{note}</div>}
    </div>
  );
}

/** Mission control: one card per agent — state, what happened since your last
 *  prompt, and a reply box that reaches the terminal directly. */
export default function Overview({ clis, onOpen }: { clis: Cli[]; onOpen: (sid: string) => void }) {
  const [sessions, setSessions] = useState<MetaSession[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.getMeta().then((r) => { if (alive) setSessions(r.sessions); }).catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const colorOf = Object.fromEntries(clis.map((c) => [c.id, c.color]));

  if (!sessions) return <div className="ov-wrap"><div className="usage-msg mono">reading traces…<span className="et-cursor" /></div></div>;
  const ordered = [...sessions].sort((a, b) =>
    RANK[a.state] - RANK[b.state] || (b.digest?.lastAssistantTs || 0) - (a.digest?.lastAssistantTs || 0));

  return (
    <div className="ov-wrap">
      {ordered.length === 0 && <div className="usage-msg mono">no agents yet.</div>}
      <div className="ov-grid">
        {ordered.map((s) => <Card key={s.id} s={s} color={colorOf[s.cli]} onOpen={onOpen} />)}
      </div>
    </div>
  );
}
