// Conversation mode: a session's trace, as a stack of exchanges.
// (docs/conversation-view.md §3.3)
//
// The pane header above this belongs to the session; everything here is the
// reader's own: a line of session facts, search, turn navigation, and the same
// ExchangeView the Overview card shows one of.
//
// It opens on the END of the conversation and pages backwards: one window of the
// transcript to start, another when you scroll to the top, anchored so the text
// you are reading does not move under you. Before that it read the last 400
// turns in a single request and stopped there — 702 KB on a 19 MB session, with
// "1,020 earlier messages are not shown" and no way to reach them — and it
// re-fetched all 400 every three seconds while the agent worked, each one a full
// re-parse of the transcript on the server. The paging itself lives in
// lib/traceWindows.ts, shared with the Trace pane.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import type { TraceTurn } from '../../api';
import { useTraceWindows, type TraceSource } from '../../lib/traceWindows';
import type { Session } from '../../types';
import { fmtTok, splitExchanges } from './exchanges';
import ExchangeView from './Exchange';
import { SendGlyph } from '../icons';

const NEAR_TOP_PX = 300;   // start fetching older turns before the reader arrives

const fmtNum = (n: number) => n.toLocaleString();
const fmtUsage = (u?: { in: number; out: number } | null) =>
  (u ? `${fmtTok(u.in)}↓ ${fmtTok(u.out)}↑` : '');

export default function ConversationView({ session, paused, isMobile, readOnly, onHandover }: {
  session: Session;
  /** The pane is off-screen: stop asking the server for a trace nobody sees. */
  paused?: boolean;
  isMobile?: boolean;
  /** A trace with no agent behind it — a shared file, an import. Read-only. */
  readOnly?: boolean;
  onHandover?: () => void;
}) {
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

  const src = useMemo<TraceSource>(() => ({
    window: (req, bytes) => api.getTraceWindow(session.id, req, bytes),
    summary: () => api.getTraceSummary(session.id),
  }), [session.id]);

  // React keys for the exchanges, and the reading position across a prepend.
  // The keys are indices into a list that grows at the FRONT, so without a base
  // that moves with it every exchange remounts when older turns arrive.
  const keyBase = useRef(0);
  // The anchor is the scroll height, not an element. Turns regroup here: an
  // exchange at the top of the list is a fragment whose prompt was in the window
  // we had not read yet, and when that window arrives the two become ONE
  // exchange — so the element the reader was looking at can cease to exist as an
  // element. What does not change is that everything new is added ABOVE, so
  // keeping the distance to the bottom constant keeps the same text under the
  // reader's eyes regardless of how the pieces were regrouped.
  const anchor = useRef<number | null>(null);

  const onPrepend = useCallback((count: number) => {
    keyBase.current -= count;
    const el = scroller.current;
    if (!el) return;
    anchor.current = el.scrollHeight - el.scrollTop;
    stick.current = false;
  }, []);

  const onReset = useCallback(() => { anchor.current = null; stick.current = true; fills.current = 0; }, []);

  const { turns: turnsRef, head, error, version, atStart, blocked, loadOlder, loadNewer } =
    useTraceWindows(src, session.id, { onPrepend, onReset, paused, live });

  const turns: TraceTurn[] = turnsRef.current;
  const exchanges = useMemo(() => splitExchanges(turns), [version, turns]); // eslint-disable-line react-hooks/exhaustive-deps
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
    setSending(true); setFailed(false);
    try {
      await api.sendInput(session.id, text);
      setDraft(''); setSent({ text, at: Date.now() });
      if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.blur(); }
      stick.current = true;
      loadNewer();
    } catch { setFailed(true); window.setTimeout(() => setFailed(false), 4000); }
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

  // Land on the end of the conversation, and stay there until the reader
  // decides otherwise. This is not only for a working agent: switching a pane
  // from terminal to reader (which mounts this component fresh) used to drop you
  // at the top of the last 400 turns — hundreds of rows behind what the agent
  // had just said, and behind what you were watching in the terminal a moment
  // earlier. `stick` goes false the instant you scroll up, so following the end
  // never fights a decision to read further back.
  // A window that does not fill the pane leaves nothing to scroll, and paging is
  // driven by scrolling — so on a tall display the reader would sit on the last
  // few exchanges of a long conversation with no gesture that reaches the rest.
  // (Measured: at a 2200 px viewport the first window was 2007 px and no wheel
  // event could ever fire.)
  //
  // Fetching until it overflows is NOT the fix: this view collapses an agent's
  // steps into one line, so a window of sixty turns can add almost no height,
  // and "keep going until you can scroll" walked back through twelve windows of
  // a conversation nobody had asked to see. So: a couple of attempts to make the
  // pane scrollable, and past that the line at the top becomes the way to ask.
  const fills = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !head || atStart || blocked) return;
    if (el.scrollHeight > el.clientHeight) { fills.current = 0; return; }
    if (fills.current >= 2) return;
    fills.current += 1;
    loadOlder();
  }, [version, head, atStart, blocked, loadOlder]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) { el.scrollTop = el.scrollHeight; anchor.current = null; return; }
    // Older turns just arrived above the reader: restore the distance to the
    // bottom, which is the same text on screen however the exchanges regrouped.
    const a = anchor.current;
    if (a == null) return;
    el.scrollTop = el.scrollHeight - a;
    anchor.current = null;
  }, [version, live, sent]);

  if (!head) return <div className="cxv-empty mono">{error || 'reading the trace…'}</div>;

  return (
    <div className="cxv">
      {/* The reader's own controls, on their own row: on a phone the pane
          header above has no spare width. */}
      <div className="cxv-bar mono">
        {head.model && <span className="cxv-chip">{head.model}</span>}
        <span className="cxv-count" title={head.total != null ? `${fmtNum(head.total)} messages in this conversation` : `${fmtNum(head.loaded)} messages loaded`}>
          {fmtNum(exchanges.length)} turn{exchanges.length === 1 ? '' : 's'}
          {head.total != null && head.loaded < head.total ? ` of ${fmtNum(head.total)} messages` : ''}
        </span>
        {head.usage && (
          <span className="cxv-tok" title={head.usage.cacheRead ? `${fmtNum(head.usage.cacheRead)} cached` : undefined}>
            {fmtUsage(head.usage)}
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
          // Reading back into the conversation: fetch the stretch in front of
          // what we hold before the reader arrives at it.
          if (el.scrollTop < NEAR_TOP_PX) loadOlder();
        }}>
        <div className="cxv-col">
          {error && <div className="cxv-msg bad mono">{error} · showing the last read</div>}
          <button
            type="button"
            className="cxv-msg mono cxv-top"
            disabled={atStart || blocked}
            onClick={() => loadOlder()}
            title={atStart || blocked ? undefined : 'Load the previous stretch of the conversation'}
          >
            {blocked
              ? 'earlier turns can’t be read — one line here is larger than the reader’s window'
              : atStart
                ? 'beginning of the conversation'
                : 'earlier turns load as you scroll up — or click here'}
          </button>
          {head.note && <div className="cxv-msg mono">{head.note}</div>}
          {q && (
            <div className="cxv-msg mono">
              {shown.length} of the {exchanges.length} turn{exchanges.length === 1 ? '' : 's'} loaded
              so far match “{query}”{atStart ? '' : ' — scroll up to load more'}
              {hits ? ` · ${hits} highlighted, ▲▼ walks them` : ''}
            </div>
          )}
          {shown.map((x, i) => (
            <div
              key={keyBase.current + x.at}
              data-x={String(keyBase.current + x.at)}
              ref={(el) => { if (el) rows.current.set(i, el); else rows.current.delete(i); }}
            >
              <ExchangeView
                x={x}
                n={exchanges.indexOf(x) + 1}
                total={exchanges.length}
                q={q || undefined}
                baseModel={head.model || undefined}
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
        <div className="ov-live cxv-live">
          <span className="ov-p mono">❯</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            disabled={sending}
            placeholder={sending ? 'sending…' : 'reply…'}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            onChange={(e) => { setDraft(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`; }}
            onKeyDown={(e) => {
              // Desktop: Enter sends, Shift+Enter newlines. Mobile keyboards
              // cannot do Shift+Enter, so there the button sends.
              if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); send(); }
              if (e.key === 'Escape') { setDraft(''); inputRef.current?.blur(); }
            }}
          />
          {draft.trim() && <button className="ov-send" title="Send" onClick={send} disabled={sending}><SendGlyph /></button>}
        </div>
      )}
      {failed && <div className="ov-note cxv-note">failed to reach the agent</div>}

      <div className="cxv-foot mono">
        <span className="cxv-path" title={head.cwd || undefined}>
          {head.cwd}
          {head.firstTs ? ` · ${new Date(head.firstTs).toLocaleDateString()}` : ''}
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
