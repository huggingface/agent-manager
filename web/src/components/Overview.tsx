import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { marked } from 'marked';
import * as api from '../api';
import type { MetaSession } from '../api';
import type { Cli, OverviewFilter, Session, SessionState, Tree } from '../types';
import Logo from './Logo';

const fmtAgo = (ts: number) => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};
const fmtTok = (n = 0) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const base = (p: string) => p.split('/').pop() || p;
const eligible = (s: Session) => s.cli !== 'shell' && s.cli !== 'files';
const bucket = (state: SessionState): OverviewFilter =>
  state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : 'quiet';

const Caret = () => (
  <svg className="ov-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.8 3.2h6.4L5 7.4z" fill="currentColor" /></svg>
);

function Card({ s, color, onOpen }: {
  s: MetaSession;
  color?: string;
  onOpen: (sid: string) => void;
}) {
  const d = s.digest;
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (live) inputRef.current?.focus(); }, [live]);

  // After you send (or when the transcript shows a prompt newer than the last
  // answer), the old answer is stale — a spinner takes its place.
  const digestCaughtUp = !!d && d.lastPromptTs >= sentAt - 60_000;
  if (sentAt && digestCaughtUp) setSentAt(0);
  const awaiting = (sentAt && !digestCaughtUp) || (!!d && !!d.lastPromptText && d.lastPromptTs > d.lastAssistantTs);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await api.sendInput(s.id, text);
      setDraft('');
      setSentAt(Date.now());
      setLive(false);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 4000);
    }
    setSending(false);
  };

  const ago = fmtAgo(Math.max(d?.lastAssistantTs || 0, d?.lastPromptTs || 0) || Date.parse(s.createdAt) || 0);
  const metaBits: string[] = [];
  if (d && (d.sinceTurns || d.sinceToolCalls)) {
    metaBits.push(`${d.sinceTurns} turn${d.sinceTurns === 1 ? '' : 's'}`, `${d.sinceToolCalls} tool${d.sinceToolCalls === 1 ? '' : 's'}`);
    if (d.sinceFiles.length) metaBits.push(d.sinceFiles.map(base).join(', '));
    if (d.sinceTokens > 0) metaBits.push(`${fmtTok(d.sinceTokens)} tok`);
  }
  // One reply line for every state — same words, same accent voice.
  const ghostLabel = 'waiting for your input…';

  return (
    <div className="ov-card">
      <div className="ov-id" onClick={() => onOpen(s.id)} title="Open pane">
        <span className={`status ${s.state}`} />
        <Logo cli={s.cli} size={12} tint={color} />
        <span className="ov-name mono">{s.name}</span>
        {ago && <span className="ov-ago">· {ago}</span>}
        <span className="spacer" />
        <span className="ov-go">open ↗</span>
      </div>

      {d && d.lastPromptText ? (
        <div className="ov-prompt mono" title={d.lastPromptText}>{d.lastPromptText}</div>
      ) : (
        <div className="ov-prompt ov-prompt-none mono">no prompt yet</div>
      )}
      {metaBits.length > 0 && <div className="ov-meta mono">{metaBits.join(' · ')}</div>}

      {awaiting ? (
        <div className="ov-busy mono">working</div>
      ) : d && d.lastAssistantText ? (
        <div className="ov-answer-wrap">
          {expanded ? (
            <div className="markdown ov-md" dangerouslySetInnerHTML={{ __html: marked.parse(d.lastAssistantMd || d.lastAssistantText) as string }} />
          ) : (
            <div className="ov-answer">{d.lastAssistantText}</div>
          )}
          <button className="ov-more" onClick={() => setExpanded((e) => !e)}>{expanded ? 'less' : 'more'}</button>
        </div>
      ) : null}

      {live ? (
        <div className="ov-live">
          <span className="ov-p mono">❯</span>
          <input
            ref={inputRef}
            value={draft}
            disabled={sending}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            onChange={(e) => setDraft(e.target.value)}
            // iOS doesn't resize the layout for the keyboard — scroll the
            // input into view once the keyboard has animated in.
            onFocus={(e) => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); }}
            onBlur={() => { if (!draft.trim()) setLive(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
              if (e.key === 'Escape') { setDraft(''); setLive(false); }
            }}
          />
          <span className="ov-hint">{sending ? 'sending…' : '↵ send'}</span>
        </div>
      ) : (
        <button className="ov-ghost attn" onClick={() => setLive(true)}>{ghostLabel}</button>
      )}
      {failed && <div className="ov-note">failed to reach the agent</div>}
    </div>
  );
}

/** Mission control: one reading column — group capsules with their agents as
 *  slabs, loose agents as standalone panels. */
export default function Overview({ clis, tree, filter, onOpen }: {
  clis: Cli[];
  tree: Tree;
  filter: OverviewFilter; // controlled by the bottom bar in App
  onOpen: (sid: string) => void;
}) {
  const [meta, setMeta] = useState<Record<string, MetaSession> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [durs, setDurs] = useState<Record<string, number>>({});

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

  if (!meta) return <div className="ov-wrap"><div className="ov-feed"><div className="usage-msg mono">reading traces…<span className="et-cursor" /></div></div></div>;

  const visible = (s: MetaSession) => filter === 'all' || bucket(s.state) === filter;

  // Collapse at constant velocity: duration follows the group's height.
  const toggleGroup = (gid: string, el: HTMLElement) => {
    const inner = el.closest('.ov-sec')?.querySelector('.ov-drawer-in') as HTMLElement | null;
    const h = inner?.scrollHeight || 180;
    setDurs((prev) => ({ ...prev, [gid]: Math.min(460, Math.max(170, Math.round(h * 1.4))) }));
    setCollapsed((c) => { const n = new Set(c); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  };

  const renderItem = (s: Session) => {
    const m = dataFor(s);
    if (!visible(m)) return null;
    return (
      <div key={s.id} className="ov-panel">
        <Card s={m} color={colorOf[s.cli]} onOpen={onOpen} />
      </div>
    );
  };

  const blocks: ReactNode[] = [];
  for (const ref of tree.order) {
    if (ref.startsWith('s:')) {
      const s = sessById[ref.slice(2)];
      if (s && eligible(s)) {
        const el = renderItem(s);
        if (el) blocks.push(el);
      }
    } else {
      const g = groupById[ref.slice(2)];
      if (!g) continue;
      const members = g.sessionIds.map((id) => sessById[id]).filter(Boolean).filter(eligible) as Session[];
      const shown = members.map((s) => ({ s, el: renderItem(s) })).filter((x) => x.el);
      if (!shown.length) continue;
      const open = !collapsed.has(g.id);
      blocks.push(
        <div key={g.id} className={`ov-sec${open ? '' : ' closed'}`} style={{ '--dur': `${durs[g.id] ?? 360}ms` } as CSSProperties}>
          <button className="ov-sechead" onClick={(e) => toggleGroup(g.id, e.currentTarget)}>
            <Caret />
            <span className="ov-sectitle">{g.name}</span>
            <span className="ov-secn mono">{shown.length}</span>
            <span className="ov-peek">
              {shown.map(({ s }) => <span key={s.id} className={`status ${dataFor(s).state}`} />)}
            </span>
          </button>
          <div className="ov-drawer"><div className="ov-drawer-in">
            <div className="ov-secbody">{shown.map(({ el }) => el)}</div>
          </div></div>
          <div className="ov-foot" />
        </div>,
      );
    }
  }

  return (
    <div className="ov-wrap">
      <div className="ov-feed">
        {blocks.length === 0 && <div className="usage-msg mono">{filter === 'all' ? 'no agents yet — shells and file panes don’t appear here.' : 'nothing in this state.'}</div>}
        {blocks}
      </div>
    </div>
  );
}
