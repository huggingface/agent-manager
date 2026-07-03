import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { marked } from 'marked';
import * as api from '../api';
import type { MetaSession } from '../api';
import type { Cli, Session, Tree } from '../types';
import { STATE_LABEL } from '../types';
import Logo from './Logo';

const fmtAgo = (ts: number) => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const base = (p: string) => p.split('/').pop() || p;
const eligible = (s: Session) => s.cli !== 'shell' && s.cli !== 'files';

function Card({ s, color, onOpen }: { s: MetaSession; color?: string; onOpen: (sid: string) => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const d = s.digest;

  // After you send (or when the transcript shows a prompt newer than the last
  // answer), the old answer is stale — show a working indicator instead.
  const digestCaughtUp = !!d && d.lastPromptTs >= sentAt - 60_000;
  if (sentAt && digestCaughtUp) setSentAt(0);
  const awaiting = (sentAt && !digestCaughtUp) || (!!d && !!d.lastPromptText && d.lastPromptTs > d.lastAssistantTs);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await api.sendInput(s.id, text);
      setDraft('');
      setSentAt(Date.now());
      setNote(r.started ? 'agent started' : '');
    } catch {
      setNote('failed to reach the agent');
    }
    setBusy(false);
    setTimeout(() => setNote(''), 4000);
  };

  const digestLine = d && (d.sinceTurns || d.sinceToolCalls)
    ? `${d.sinceTurns} turn${d.sinceTurns === 1 ? '' : 's'} · ${d.sinceToolCalls} tool call${d.sinceToolCalls === 1 ? '' : 's'}${d.sinceFiles.length ? ` · ${d.sinceFiles.map(base).join(', ')}` : ''}`
    : null;
  const hasAnswer = !!d && !!d.lastAssistantText && !awaiting;

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
          <span className="ov-you-text" title={d.lastPromptText}>{d.lastPromptText}</span>
          <span className="ov-ago">{fmtAgo(d.lastPromptTs)}</span>
        </div>
      ) : (
        <div className="ov-none">{d ? 'no prompt yet' : 'no trace yet'}</div>
      )}
      {digestLine && !awaiting && <div className="ov-digest mono">{digestLine}</div>}

      {awaiting && (
        <div className="ov-working mono">working<span className="et-cursor" /></div>
      )}
      {hasAnswer && (
        <div className="ov-last">
          <span className="ov-lbl">last</span>
          <div className="ov-last-body">
            {expanded ? (
              <div className="markdown ov-md" dangerouslySetInnerHTML={{ __html: marked.parse(d!.lastAssistantMd || d!.lastAssistantText) as string }} />
            ) : (
              <div className="ov-last-text">{d!.lastAssistantText}</div>
            )}
            <button className="ov-more" onClick={() => setExpanded((e) => !e)}>{expanded ? 'collapse' : 'expand'}</button>
          </div>
        </div>
      )}

      <div className="ov-reply">
        <input
          value={draft}
          placeholder={s.running ? 'reply…' : 'prompt (wakes the agent)…'}
          disabled={busy}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button className="btn-ghost" disabled={busy || !draft.trim()} onClick={send}>{busy ? '…' : 'send'}</button>
      </div>
      {note && <div className="ov-note">{note}</div>}
    </div>
  );
}

/** Mission control: agents arranged like the sidebar (groups collapsible),
 *  each card showing state, the since-your-last-prompt digest, and a reply box. */
export default function Overview({ clis, tree, onOpen }: { clis: Cli[]; tree: Tree; onOpen: (sid: string) => void }) {
  const [meta, setMeta] = useState<Record<string, MetaSession> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const load = () => api.getMeta()
      .then((r) => { if (alive) setMeta(Object.fromEntries(r.sessions.map((s) => [s.id, s]))); })
      .catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const colorOf = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c.color])), [clis]);
  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);
  const dataFor = (s: Session): MetaSession => meta?.[s.id] ?? { ...s, digest: null };

  if (!meta) return <div className="ov-wrap"><div className="usage-msg mono">reading traces…<span className="et-cursor" /></div></div>;

  // Follow the sidebar's order: groups as collapsible sections, loose agents inline.
  const blocks: ReactNode[] = [];
  let loose: Session[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    blocks.push(
      <div key={`loose-${blocks.length}`} className="ov-grid">
        {loose.map((s) => <Card key={s.id} s={dataFor(s)} color={colorOf[s.cli]} onOpen={onOpen} />)}
      </div>,
    );
    loose = [];
  };
  for (const ref of tree.order) {
    if (ref.startsWith('s:')) {
      const s = sessById[ref.slice(2)];
      if (s && eligible(s)) loose.push(s);
    } else {
      const g = groupById[ref.slice(2)];
      if (!g) continue;
      const members = g.sessionIds.map((id) => sessById[id]).filter(Boolean).filter(eligible) as Session[];
      if (!members.length) continue;
      flushLoose();
      const open = !collapsed.has(g.id);
      blocks.push(
        <div key={g.id} className="ov-sec">
          <button
            className="ov-sec-head"
            onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n; })}
          >
            <span className="caret">{open ? '▾' : '▸'}</span>
            <span className="ov-sec-title">{g.name}</span>
            <span className="ov-sec-count">{members.length}</span>
          </button>
          {open && (
            <div className="ov-grid">
              {members.map((s) => <Card key={s.id} s={dataFor(s)} color={colorOf[s.cli]} onOpen={onOpen} />)}
            </div>
          )}
        </div>,
      );
    }
  }
  flushLoose();

  return (
    <div className="ov-wrap">
      {blocks.length === 0 && <div className="usage-msg mono">no agents yet — shells and file panes don't appear here.</div>}
      {blocks}
    </div>
  );
}
