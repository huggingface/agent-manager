import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as api from '../api';
import type { MetaSession, TraceTurn } from '../api';
import type { Cli, OverviewFilter, Session, SessionState, Tree } from '../types';
import { isPassive } from '../types';
import { renderMarkdown } from '../lib/markdown';
import Logo from './Logo';
import { SendGlyph } from './icons';
import ExchangeView from './conversation/Exchange';
import { writePaneMode } from '../lib/paneMode';
import { splitExchanges } from './conversation/exchanges';

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
const eligible = (s: Session) => s.cli !== 'shell' && !isPassive(s.cli);
const bucket = (state: SessionState): OverviewFilter =>
  state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : 'quiet';

/** How much of the conversation the card reads. Cheap: one page, from the end. */
const CARD_TAIL = 120;
const CARD_TURNS = 5;   // past this the card is the wrong tool, and says so
const POLL_MS = 3_000;
const MISSING_MS = 30_000;  // a session with no trace: check back, but rarely

/**
 * The tail of a session's conversation (docs/conversation-view.md §5).
 *
 * The digest cannot answer "what happened in the middle": `turnsLog` holds only
 * assistant TEXT from the current request — no tool calls, no thinking, nothing
 * before the last prompt. So the card reads the trace itself, and falls back to
 * the digest when there is no transcript yet (a session that never started, an
 * unsupported harness).
 *
 * `on` is false for the card inline in the list: a summary does not need the
 * middle, and one trace read per visible agent — every three seconds for the
 * working ones — is a lot to spend on something nobody asked to see.
 */
function useConversationTail(id: string, on: boolean, live: boolean) {
  const [turns, setTurns] = useState<TraceTurn[] | null>(null);
  // No transcript for this session: back off hard rather than 404 on a loop.
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    try {
      const page = await api.getTracePage(id, -CARD_TAIL, CARD_TAIL);
      setTurns(page.turns);
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [id]);
  useEffect(() => {
    setTurns(null);
    setMissing(false);
    if (on) load();
  }, [load, on]);
  // While the agent works the transcript is still being written.
  useEffect(() => {
    if (!on || !live) return undefined;
    const h = window.setInterval(load, missing ? MISSING_MS : POLL_MS);
    return () => window.clearInterval(h);
  }, [on, live, missing, load]);
  return { turns, missing };
}

/** Opening the pane on this session, in RENDER mode (§3.3 keeps it per session). */
const openRendered = (id: string, onOpen: (sid: string) => void) => {
  writePaneMode(id, 'render');   // reaches a pane that is already open, too
  onOpen(id);
};

const Caret = () => (
  <svg className="ov-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.8 3.2h6.4L5 7.4z" fill="currentColor" /></svg>
);

/**
 * One exchange plus a reply box (docs/conversation-view.md §3.2).
 *
 * Collapsed it reads as it always did — your prompt, the answer, the reply line.
 * What is new is the middle: `▸ 14 steps · 9 tools` unfolds the work between the
 * two, and history grows one turn at a time instead of a stepper that replaced
 * the answer with an older one.
 */
export function Card({ s, color, pending, isMobile, onOpen, onClose }: {
  s: MetaSession;
  color?: string;
  pending?: boolean; // digest still loading — show a shimmer instead of "no prompt yet"
  isMobile?: boolean;
  onOpen: (sid: string) => void;
  onClose?: () => void; // present when the card lives in the conversation window
}) {
  const d = s.digest;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Optimistic echo: the sent text becomes the prompt line the moment the
  // send succeeds — the digest round-trip (CLI writes transcript → rebuild →
  // poll) can take seconds, and a frozen card reads as "did that get lost?".
  const [sent, setSent] = useState<{ text: string; at: number } | null>(null);
  const [histIdx, setHistIdx] = useState(0); // digest fallback only: n-th answer back
  const [back, setBack] = useState(0);       // how many earlier turns are shown
  const [openWork, setOpenWork] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  // The window is the only place the card can grow; inline in the list it stays
  // a summary, so the answer is clamped and history stays behind the pane.
  const windowed = !!onClose;

  // After you send (or when the transcript shows a prompt newer than the last
  // answer), the old answer is stale — a spinner takes its place.
  const digestCaughtUp = !!d && !!sent && d.lastPromptTs >= sent.at - 60_000;
  if (sent && digestCaughtUp) setSent(null);
  // Running: the agent's own task lifecycle when the transcript provides one
  // (codex task_started/complete), else the terminal-derived state.
  const running = !!d?.running || s.state === 'working';
  const awaiting = (!!sent && !digestCaughtUp) || (!!d && !!d.lastPromptText && d.lastPromptTs > d.lastAssistantTs && running);

  const hist = d?.turnsLog ?? [];
  const idx = Math.min(histIdx, hist.length);
  const entry = idx > 0 ? hist[idx - 1] : null;

  const { turns } = useConversationTail(s.id, windowed, running || awaiting);
  const exchanges = useMemo(() => (turns ? splitExchanges(turns) : []), [turns]);
  const cap = windowed ? CARD_TURNS : 1;
  const shownX = exchanges.slice(Math.max(0, exchanges.length - 1 - back));
  const latestX = shownX[shownX.length - 1];
  const earlierX = shownX.slice(0, -1);
  const remainingX = exchanges.length - shownX.length;
  const atCap = back + 1 >= cap;

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await api.sendInput(s.id, text);
      setDraft('');
      setSent({ text, at: Date.now() });
      setHistIdx(0);
      if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.blur(); }
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 4000);
    }
    setSending(false);
  };

  // Where the body sits after a change:
  //  · asked for the previous turn → the top, at the turn you asked for
  //  · working → the tail, where the newest line is
  //  · otherwise → the latest turn's prompt, reading downward from there
  const wasBack = useRef(back);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !latestX) return;
    const prepended = back > wasBack.current;
    wasBack.current = back;
    if (prepended) { el.scrollTop = 0; return; }
    if (running) { el.scrollTop = el.scrollHeight; return; }
    const tgt = latestRef.current;
    if (tgt) el.scrollTop += tgt.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, [back, sent, running, latestX]);

  const ago = fmtAgo(Math.max(d?.lastAssistantTs || 0, d?.lastPromptTs || 0) || Date.parse(s.createdAt) || 0);
  const promptText = sent ? sent.text : d?.lastPromptText || '';
  const answerText = entry ? entry.answer : d?.lastAssistantText || '';
  const answerMd = entry ? entry.answerMd : d?.lastAssistantMd || '';
  // Chronological position: hist is newest-first, live text is the newest turn.
  const totalTurns = hist.length + (d?.lastAssistantText ? 1 : 0);
  const metaBits: string[] = [];
  if (d && (d.sinceTurns || d.sinceToolCalls)) {
    metaBits.push(`${d.sinceTurns} turn${d.sinceTurns === 1 ? '' : 's'}`, `${d.sinceToolCalls} tool${d.sinceToolCalls === 1 ? '' : 's'}`);
    if (d.sinceFiles.length) metaBits.push(d.sinceFiles.map(base).join(', '));
    if (d.sinceTokens > 0) metaBits.push(`${fmtTok(d.sinceTokens)} tok`);
  }
  const showLiveProgress = !entry && (running || awaiting);

  // Latest answer as markdown, live or final. While running we only show it
  // once there's a partial answer NEWER than the current prompt — so a stale
  // previous answer doesn't sit under a just-sent prompt.
  const justSent = !!sent && !digestCaughtUp;
  const answerFresh = !!d && d.lastAssistantTs >= d.lastPromptTs && !justSent;
  const showAnswer = entry ? !!answerText : (!!answerText && (answerFresh || !running));
  const answerHtml = showAnswer ? renderMarkdown(answerMd || answerText) : '';

  return (
    <div className={`ov-card${windowed ? '' : ' ov-compact'}`}>
      <div className="ov-id" onClick={() => onOpen(s.id)} title="Open pane">
        <span className={`status ${s.state}`} />
        <Logo cli={s.cli} size={12} tint={color} />
        <span className="ov-name mono">{s.name}</span>
        {ago && <span className="ov-ago">· {ago}</span>}
        <span className="spacer" />
        <span className="ov-go">open ↗</span>
        {onClose && <button className="ov-x" onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close">✕</button>}
      </div>

      {/* the card body is the ONLY scroll region (window mode); input stays put */}
      <div className="ov-body" ref={bodyRef}>
        {latestX ? (
          <>
            {/* History grows upward, one turn per click — never a transcript dump. */}
            {windowed && (remainingX > 0 || back > 0) && (
              <div className="cx-earlier mono">
                {remainingX > 0 && !atCap && (
                  <button className="cx-earlier-btn" onClick={() => setBack((b) => b + 1)}>
                    ↑ show previous turn
                  </button>
                )}
                {(atCap || back > 0) && (
                  <button className="cx-earlier-btn" onClick={() => openRendered(s.id, onOpen)}>
                    full history ↗
                  </button>
                )}
                {atCap && <span className="cx-earlier-note">card holds {cap} turns</span>}
              </div>
            )}
            {earlierX.map((x) => <ExchangeView key={x.key} x={x} dim />)}
            <div ref={latestRef}>
              <ExchangeView
                x={latestX}
                open={openWork}
                onToggle={() => setOpenWork((o) => !o)}
                running={running && !justSent}
              />
            </div>
            {/* Optimistic echo: the digest round-trip can take seconds, and a
                frozen card reads as "did that get lost?". */}
            {justSent && sent && (
              <>
                <div className="cx-prompt">{sent.text}</div>
                <div className="cx-running mono">working</div>
              </>
            )}
          </>
        ) : (
          /* No transcript to read yet (never started, or a harness with no
             trace): the digest still knows the last prompt and answer. */
          <>
            {promptText ? (
              <div className="ov-prompt">{sent ? sent.text : (d?.lastPromptRaw || promptText)}</div>
            ) : pending ? (
              <div className="ov-prompt-skel"><span className="skel" style={{ width: '70%' }} /></div>
            ) : (
              <div className="ov-prompt ov-prompt-none">no prompt yet</div>
            )}
            {(metaBits.length > 0 || hist.length > 0) && (
              <div className="ov-meta mono">
                <span className="ov-meta-bits">{metaBits.join(' · ')}</span>
                <span className="spacer" />
                {hist.length > 0 && (
                  <span className="ov-nav">
                    {idx > 0 && <span className="ov-nav-pos">turn {totalTurns - idx}/{totalTurns}</span>}
                    <button
                      className="ov-nav-btn" title="Earlier turn" disabled={idx >= hist.length}
                      onClick={() => setHistIdx(Math.min(idx + 1, hist.length))}
                    >↑</button>
                    <button
                      className="ov-nav-btn" title="Later turn" disabled={idx === 0}
                      onClick={() => setHistIdx(Math.max(idx - 1, 0))}
                    >↓</button>
                  </span>
                )}
              </div>
            )}
            {answerHtml && (
              <div className="ov-answer-wrap">
                <div className="markdown ov-md" dangerouslySetInnerHTML={{ __html: answerHtml }} />
              </div>
            )}
            {showLiveProgress && <div className="ov-busy mono">running</div>}
          </>
        )}
      </div>

      <div className="ov-live">
        <span className="ov-p mono">❯</span>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={sending}
          placeholder={sending ? 'sending…' : 'reply…'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`; }}
          // iOS doesn't resize the layout for the keyboard — scroll the
          // input into view once the keyboard has animated in.
          onFocus={(e) => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); }}
          onKeyDown={(e) => {
            // Desktop: Enter sends, Shift+Enter newlines. Mobile keyboards can't
            // do Shift+Enter, so Enter always newlines there and the button sends.
            if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); send(); }
            if (e.key === 'Escape') { setDraft(''); inputRef.current?.blur(); }
          }}
        />
        {draft.trim() && <button className="ov-send" title="Send" onClick={send} disabled={sending}><SendGlyph /></button>}
      </div>
      {failed && <div className="ov-note">failed to reach the agent</div>}
    </div>
  );
}

/** Compact tile: status + prompt + state; click opens the conversation window. */
function Tile({ s, color, dim, pending, onOpen }: { s: MetaSession; color?: string; dim?: boolean; pending?: boolean; onOpen: () => void }) {
  const d = s.digest;
  const running = !!d?.running || s.state === 'working';
  const last = Math.max(d?.lastAssistantTs || 0, d?.lastPromptTs || 0) || Date.parse(s.createdAt) || 0;
  // ring = waiting on you AND recent — a fleet where everything is "waiting
  // since last week" shouldn't glow everywhere
  const fresh = s.state === 'waiting' && Date.now() - last < 24 * 3600e3;
  return (
    <div className={`ovt-tile${fresh ? ' attn' : ''}${dim ? ' archived' : ''}`} onClick={onOpen}>
      <div className="ovt-head">
        <span className={`status ${s.state}`} />
        <Logo cli={s.cli} size={12} tint={color} />
        <span className="ovt-name mono">{s.name}</span>
        <span className="ovt-ago">{pending ? '' : fmtAgo(last)}</span>
      </div>
      {pending ? (
        <>
          <span className="skel" style={{ width: '82%' }} />
          <span className="skel" style={{ width: '38%', height: 7 }} />
        </>
      ) : (
        <>
          {d?.lastPromptText
            ? <div className="ovt-prompt" title={d.lastPromptText}>{d.lastPromptText}</div>
            : <div className="ovt-prompt none">no prompt yet</div>}
          {running
            ? <div className="ovt-state running mono">running</div>
            : s.state === 'stopped'
              ? <div className="ovt-state stopped mono">stopped</div>
              : d?.lastAssistantText
                ? <div className="ovt-state done mono">✓ done</div>
                : <div className="ovt-state idle mono">idle</div>}
        </>
      )}
    </div>
  );
}

/** Mission control: one reading column — group capsules with their agents as
 *  slabs, loose agents as standalone panels. */
export default function Overview({ clis, tree, filter, view, archived, showArchived, meta, metaReady, isMobile, onOpen }: {
  clis: Cli[];
  tree: Tree;
  filter: OverviewFilter; // controlled by the bottom bar in App
  view: 'tiles' | 'list'; // controlled by the bottom bar in App
  archived: Set<string>;
  showArchived: boolean;
  meta: Record<string, MetaSession>; // continuously polled in App; instant on open
  metaReady: boolean;                // false until the first poll lands
  isMobile: boolean;
  onOpen: (sid: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [durs, setDurs] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null); // conversation window
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);

  const colorOf = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c.color])), [clis]);
  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);
  const dataFor = (s: Session): MetaSession => meta[s.id] ?? { ...s, digest: null };
  // A tile shimmers only until the first background poll lands; after that the
  // session is in `meta` (or genuinely has no digest).
  const pending = (id: string) => !metaReady && !meta[id];

  const visible = (s: MetaSession) =>
    (filter === 'all' || bucket(s.state) === filter) && (showArchived || !archived.has(s.id));

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
        <Card s={m} color={colorOf[s.cli]} pending={pending(s.id)} isMobile={isMobile} onOpen={onOpen} />
      </div>
    );
  };

  // ---- tile view: loose sessions pack into grids, groups get a fine outline ----
  const tileFor = (s: Session) => {
    const m = dataFor(s);
    if (!visible(m)) return null;
    return <Tile key={s.id} s={m} color={colorOf[s.cli]} dim={archived.has(s.id)} pending={pending(s.id)} onOpen={() => setOpenId(s.id)} />;
  };
  const tileBlocks: ReactNode[] = [];
  let looseTiles: ReactNode[] = [];
  const flushLoose = () => {
    if (looseTiles.length) tileBlocks.push(<div className="ovt-grid" key={`loose-${tileBlocks.length}`}>{looseTiles}</div>);
    looseTiles = [];
  };
  for (const ref of tree.order) {
    if (ref.startsWith('s:')) {
      const s = sessById[ref.slice(2)];
      if (s && eligible(s)) { const t = tileFor(s); if (t) looseTiles.push(t); }
    } else {
      const g = groupById[ref.slice(2)];
      if (!g) continue;
      const members = g.sessionIds.map((id) => sessById[id]).filter(Boolean).filter(eligible) as Session[];
      const shown = members.map(tileFor).filter(Boolean);
      if (!shown.length) continue;
      flushLoose();
      tileBlocks.push(
        <div key={g.id} className="ovt-group">
          <span className="ovt-glabel mono">{g.name}<span className="ovt-gn"> {shown.length}</span></span>
          <div className="ovt-grid">{shown}</div>
        </div>,
      );
    }
  }
  flushLoose();

  const openSess = openId ? sessById[openId] : null;
  const windowEl = openSess && (
    <div className="ovw-backdrop" onClick={() => setOpenId(null)}>
      <div className="ovw-win" onClick={(e) => e.stopPropagation()}>
        <Card s={dataFor(openSess)} color={colorOf[openSess.cli]} pending={pending(openSess.id)} isMobile={isMobile} onOpen={onOpen} onClose={() => setOpenId(null)} />
      </div>
    </div>
  );

  if (view === 'tiles') {
    return (
      <div className="ov-wrap">
        <div className="ov-feed ovt-feed">
          {tileBlocks.length === 0 && <div className="usage-msg mono">{filter === 'all' ? 'no agents yet — shells and file panes don’t appear here.' : 'nothing in this state.'}</div>}
          {tileBlocks}
        </div>
        {windowEl}
      </div>
    );
  }

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
