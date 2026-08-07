// Conversation mode: a session's trace, as a stack of exchanges.
// (docs/conversation-view.md §3.3)
//
// The pane header above this belongs to the session; everything here is the
// reader's own: a line of session facts, search, turn navigation, and the same
// ExchangeView the Overview card shows one of.
//
// Draft scope: this reads the tail of the trace in one request and renders every
// turn in it. Windowing by exchange (§10.7) is the next step — a collapsed turn
// is 2–3 rows, so the DOM stays small, but the measured-height machinery in
// TraceView is what makes it survive a 5,000-turn session.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as api from '../../api';
import type { TracePage, TraceTurn } from '../../api';
import type { Session } from '../../types';
import { fmtTok, splitExchanges } from './exchanges';
import ExchangeView from './Exchange';
import Composer from './Composer';

/** How much of the tail RENDER mode reads. The server caps a page at 500. */
export const RENDER_TAIL = 400;
const POLL_MS = 3_000;

const fmtNum = (n: number) => n.toLocaleString();
const fmtUsage = (u?: { in: number; out: number } | null) =>
  (u ? `${fmtTok(u.in)}↓ ${fmtTok(u.out)}↑` : '');

export default function ConversationView({ session, paused, isMobile, readOnly, zoom = 100, onHandover }: {
  session: Session;
  /** The pane is off-screen: stop asking the server for a trace nobody sees. */
  paused?: boolean;
  isMobile?: boolean;
  /** A trace with no agent behind it — a shared file, an import. Read-only. */
  readOnly?: boolean;
  /** The app zoom. The terminal underneath obeys it, so the reader must too. */
  zoom?: number;
  onHandover?: () => void;
}) {
  const [page, setPage] = useState<TracePage | null>(null);
  const [error, setError] = useState<string>('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(0);
  const [hit, setHit] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  // Follow the work while it arrives — but only while the reader is already at
  // the bottom. Scrolling up to read something is a decision, and yanking the
  // view back down on the next tool call would undo it.
  const stick = useRef(true);
  // Reading a conversation and answering it are the same act — the card has
  // always known that. Only a trace with no agent behind it is read-only.
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState<{ text: string; at: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const live = session.state === 'working' && !paused;

  const load = useCallback(async () => {
    try {
      // A negative offset reads from the end (server/src/traces.js pageOf).
      const p = await api.getTracePage(session.id, -RENDER_TAIL, RENDER_TAIL);
      setPage(p);
      setError('');
    } catch (e) {
      // A failed REFRESH must not throw away the conversation on screen: this
      // mount answers EIO now and then, and blanking mid-read is worse than
      // going stale for three seconds.
      setError(e instanceof Error ? e.message : 'could not read this trace');
    }
  }, [session.id]);

  useEffect(() => { setPage(null); setError(''); load(); }, [load]);
  // While the agent works, the trace is still being written.
  useEffect(() => {
    if (!live) return undefined;
    const h = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(h);
  }, [live, load]);
  // Coming back into view, catch up at once rather than waiting for a tick.
  useEffect(() => { if (!paused && page) load(); }, [paused]);  // eslint-disable-line react-hooks/exhaustive-deps

  const turns: TraceTurn[] = useMemo(() => page?.turns || [], [page]);
  const exchanges = useMemo(() => splitExchanges(turns), [turns]);
  const last = exchanges[exchanges.length - 1];

  // The optimistic echo stands until the transcript catches up: a CLI writes it,
  // the reader picks it up, the poll lands — seconds, during which a card that
  // showed nothing would read as "did that get lost?".
  const promptOf = (x?: typeof last) =>
    (x?.prompt?.blocks || []).filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('').trim();
  if (sent && promptOf(last) === sent.text) setSent(null);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    // Optimistic, and it has to be: the prompt belongs on screen the moment you
    // send it, not when the POST comes back. Waiting for the round trip left a
    // beat where the box was still full and nothing had happened. If the send
    // fails, the echo is withdrawn and the text goes back in the box.
    setSending(true); setFailed(false);
    setDraft(''); setSent({ text, at: Date.now() });
    if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.blur(); }
    stick.current = true;
    try {
      await api.sendInput(session.id, text);
      load();
    } catch {
      setSent(null); setDraft(text); setFailed(true);
      window.setTimeout(() => setFailed(false), 4000);
    }
    setSending(false);
  };
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return exchanges;
    return exchanges.filter((x) =>
      [x.prompt, ...x.answer, ...x.steps].some((t) =>
        t && t.blocks.some((b) => JSON.stringify(b).toLowerCase().includes(q))));
  }, [exchanges, q]);

  // Highlighting happens inside ExchangeView; finding the marks is this
  // component's job, so it counts them and walks them in document order.
  const marks = () => [...(scroller.current?.querySelectorAll('mark.cx-hit') || [])] as HTMLElement[];
  const goMark = (found: HTMLElement[], i: number) => {
    found.forEach((m) => m.classList.remove('on'));
    const el = found[i];
    if (!el) return;
    el.classList.add('on');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  // Recount after every render that can change the marks — but a poll landing
  // must not throw you back to the first hit while you are walking them, so only
  // a NEW query jumps.
  const lastQuery = useRef(q);
  useEffect(() => {
    const found = marks();
    const fresh = lastQuery.current !== q;
    lastQuery.current = q;
    setHits(found.length);
    if (!found.length) { setHit(0); return; }
    const i = fresh ? 0 : Math.min(hit, found.length - 1);
    setHit(i);
    if (fresh) goMark(found, i);
    else found[i]?.classList.add('on');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, shown]);

  const stepHit = (dir: -1 | 1) => {
    const found = marks();
    if (!found.length) return;
    const i = (hit + dir + found.length) % found.length;
    setHit(i);
    goMark(found, i);
  };

  /**
   * Put the next turn's top at the top of the reading area. offsetTop is wrong
   * here — it is measured against the nearest positioned ancestor, not the
   * scroller — so this measures both rects and moves by the difference.
   */
  const goTurn = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const tops = [...rows.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, node]) => node.getBoundingClientRect().top - base);
    const cur = el.scrollTop;
    const next = dir < 0
      ? tops.filter((t) => t < cur - 8).pop()
      : tops.find((t) => t > cur + 8);
    if (next != null) el.scrollTo({ top: Math.max(0, next - 4), behavior: 'smooth' });
  };
  const nav = (dir: -1 | 1) => (q && hits ? stepHit(dir) : goTurn(dir));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, live]);

  // Open on the newest turn, working or not. Reader mode mounts when you flip
  // the switch, so landing at the top of a 400-turn window meant scrolling
  // through a month of work to reach the thing you flipped it to read. The
  // second pass catches tables and code blocks that lay themselves out late.
  const landed = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || landed.current || !turns.length) return;
    landed.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
  }, [turns]);

  if (!page) return <div className="cxv-empty mono">{error || 'reading the trace…'}</div>;

  return (
    <div className="cxv" style={{ '--cx-zoom': zoom / 100 } as CSSProperties}>
      {/* The reader's own controls, on their own row: on a phone the pane
          header above has no spare width. */}
      <div className="cxv-bar mono">
        {page.model && <span className="cxv-chip">{page.model}</span>}
        <span className="cxv-count" title={`${fmtNum(page.total)} messages`}>
          {fmtNum(exchanges.length)} turn{exchanges.length === 1 ? '' : 's'}
        </span>
        {page.usage && (
          <span className="cxv-tok" title={page.usage.cacheRead ? `${fmtNum(page.usage.cacheRead)} cached` : undefined}>
            {fmtUsage(page.usage)}
          </span>
        )}
        <span className="spacer" />
        <span className="cxv-nav">
          <button className="cxv-mini" onClick={() => nav(-1)} title={q && hits ? 'Previous match' : 'Previous turn'}>▲</button>
          <button className="cxv-mini" onClick={() => nav(1)} title={q && hits ? 'Next match' : 'Next turn'}>▼</button>
        </span>
        <input className="cxv-search" placeholder="Search…" value={query}
          onChange={(e) => setQuery(e.target.value)} />
        {q && <span className="cxv-hits">{hits ? `${hit + 1}/${hits}` : '0'}</span>}
      </div>

      <div className="cxv-body" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}>
        <div className="cxv-col">
          {error && <div className="cxv-msg bad mono">{error} · showing the last read</div>}
          {(page.truncated || page.offset > 0) && (
            <div className="cxv-msg mono">
              {page.offset > 0 ? `${fmtNum(page.offset)} earlier messages are not shown` : 'earlier turns are not shown'}
            </div>
          )}
          {page.note && <div className="cxv-msg mono">{page.note}</div>}
          {q && (
            <div className="cxv-msg mono">
              {shown.length} of {exchanges.length} turns match “{query}”
              {hits ? ` · ${hits} highlighted, ▲▼ walks them` : ''}
            </div>
          )}
          {shown.map((x, i) => (
            <div key={x.key} ref={(el) => { if (el) rows.current.set(i, el); else rows.current.delete(i); }}>
              <ExchangeView
                x={x}
                n={exchanges.indexOf(x) + 1}
                total={exchanges.length}
                q={q || undefined}
                baseModel={page.model || undefined}
                running={live && x === exchanges[exchanges.length - 1]}
              />
            </div>
          ))}
          {sent && (
            <>
              <div className="cx-prompt">{sent.text}</div>
              <div className="cx-running mono">working</div>
            </>
          )}
          {!exchanges.length && !sent && <div className="cxv-msg mono">nothing in this trace yet</div>}
        </div>
      </div>

      {!readOnly && (
        <Composer
          className="cxv-live"
          draft={draft}
          sending={sending}
          isMobile={isMobile}
          inputRef={inputRef}
          onChange={setDraft}
          onSend={send}
        />
      )}
      {failed && <div className="ov-note cxv-note">failed to reach the agent</div>}

      <div className="cxv-foot mono">
        <span className="cxv-path" title={page.cwd || undefined}>
          {page.cwd}
          {page.firstTs ? ` · ${new Date(page.firstTs).toLocaleDateString()}` : ''}
        </span>
        <span className="spacer" />
        {onHandover && (
          <button className="cxv-mini" onClick={onHandover} title="Start a new agent from this conversation">
            continue in a new agent ↗
          </button>
        )}
      </div>
    </div>
  );
}
