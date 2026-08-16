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
import { isRemote } from '../../types';
import {
  defaultAttachmentPrompt, pendingAttachmentsFromFiles, revokePendingAttachments, uploadPendingAttachments,
} from '../../lib/attachments';
import type { PendingAttachment } from '../../lib/attachments';
import { recallReading, rememberReading } from './readingPosition';
import { useDraft } from './useDraft';
import { fmtTok, splitExchanges } from './exchanges';
import ExchangeView, { PendingExchange } from './Exchange';
import Attachments from '../Attachments';
import Composer from './Composer';
import { DownloadGlyph, ShareGlyph } from '../icons';

const NEAR_TOP_PX = 300;   // start fetching older turns before the reader arrives

const fmtNum = (n: number) => n.toLocaleString();
const fmtUsage = (u?: { in: number; out: number } | null) =>
  (u ? `${fmtTok(u.in)}↓ ${fmtTok(u.out)}↑` : '');
/** The day a conversation started: "14 Aug", and the year too when it is not
 *  this one. Turn times are clock-only, so this is the only place a reader can
 *  learn which day — it has to be readable, not hidden behind a hover. */
const fmtStarted = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
};

export default function ConversationView({ session, paused, isMobile, readOnly, onHandover, onShare, onReady, readyKey }: {
  session: Session;
  /** The pane is off-screen: stop asking the server for a trace nobody sees. */
  paused?: boolean;
  isMobile?: boolean;
  /** A trace with no agent behind it — a shared file, an import. Read-only. */
  readOnly?: boolean;
  onHandover?: () => void;
  /** Publish this session (the share dialog). Absent when there is nothing to
   *  publish — an imported trace is already someone else's share. */
  onShare?: () => void;
  /** Called after the first tail page (or its terminal error) has painted. */
  onReady?: () => void;
  /** The visible batch this paint should release. */
  readyKey?: string;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(0);
  const [hit, setHit] = useState(0);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  // Follow the work while it arrives — but only while the reader is already at
  // the bottom. Scrolling up to read something is a decision, and yanking the
  // view back down on the next tool call would undo it.
  const stick = useRef(true);
  // Reading a conversation and answering it are the same act — the card has
  // always known that. Only a trace with no agent behind it is read-only.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A half-typed reply outlives this component. On a phone, leaving the reader
  // and coming back is usually a cold mount — the tab was evicted, or the Hub
  // rebuilt the iframe — and plain state loses the text. drafts.ts.
  const [draft, setDraft] = useDraft(session.id, inputRef);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<{ text: string; at: number } | null>(null);
  const allowAttachments = !isRemote(session.cli);

  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => revokePendingAttachments(attachmentsRef.current), []);

  const addAttachments = (files: File[]) => {
    if (!allowAttachments || sending || !files.length) return;
    const next = pendingAttachmentsFromFiles(files, attachmentsRef.current.length);
    const merged = [...attachmentsRef.current, ...next.attachments];
    attachmentsRef.current = merged;
    setAttachments(merged);
    setAttachmentError(next.error);
  };
  const removeAttachment = (key: string) => {
    if (sending) return;
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.key === key);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const next = current.filter((attachment) => attachment.key !== key);
      attachmentsRef.current = next;
      return next;
    });
    setAttachmentError(null);
  };
  const updateAttachment = (key: string, patch: Partial<PendingAttachment>) => {
    setAttachments((current) => {
      const next = current.map((attachment) => attachment.key === key ? { ...attachment, ...patch } : attachment);
      attachmentsRef.current = next;
      return next;
    });
  };

  const live = session.state === 'working' && !paused;

  const src = useMemo<TraceSource>(() => ({
    window: (req, bytes, min, signal) => api.getTraceWindow(session.id, req, bytes, min, signal),
    summary: (signal) => api.getTraceSummary(session.id, signal),
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

  // Group reader mode gives the focused pane the critical path. Its siblings
  // wait for this signal before mounting their own readers, so one click cannot
  // turn twelve retained panes into twelve competing tail reads. useEffect runs
  // after the head/error render commits: this is a paint barrier, not a timer.
  const readySentFor = useRef('');
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    const key = `${session.id}:${readyKey || ''}`;
    if (readySentFor.current === key || (!head && !error)) return;
    readySentFor.current = key;
    ready.current?.();
  }, [head, error, readyKey, session.id]);

  // The optimistic echo stands until the transcript catches up: a CLI writes it,
  // the reader picks it up, the poll lands — seconds, during which a card that
  // showed nothing would read as "did that get lost?".
  const promptOf = (x?: typeof last) =>
    (x?.prompt?.blocks || []).filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('').trim();
  if (sent && (last?.startTs || 0) >= sent.at - 60_000 && promptOf(last).startsWith(sent.text)) setSent(null);

  const send = async () => {
    const text = draft.trim();
    const batch = attachmentsRef.current;
    if ((!text && !batch.length) || sending) return;
    const optimisticText = text || defaultAttachmentPrompt(batch.length);
    setSending(true); setFailed(null);
    setDraft(''); setSent({ text: optimisticText, at: Date.now() });
    if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.blur(); }
    stick.current = true;
    try {
      const uploaded = await uploadPendingAttachments(session.id, batch, updateAttachment);
      await api.sendInput(session.id, text, uploaded.map((attachment) => attachment.id));
      revokePendingAttachments(batch);
      attachmentsRef.current = [];
      setAttachments([]);
      setAttachmentError(null);
      loadNewer();
    } catch (error) {
      setSent(null); setDraft(text);
      setFailed(error instanceof Error ? error.message : 'failed to reach the agent');
      window.setTimeout(() => setFailed(null), 5000);
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
  const nav = (dir: -1 | 1) => { moved(); return q && hits ? stepHit(dir) : goTurn(dir); };

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
    if (paused || !el || !head || atStart || blocked) return;
    if (el.scrollHeight > el.clientHeight) { fills.current = 0; return; }
    if (fills.current >= 2) return;
    fills.current += 1;
    loadOlder();
  }, [version, head, atStart, blocked, loadOlder, paused]);

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

  // ---- where you had got to -----------------------------------------------
  // Opening on the end is right for a conversation you have not read; it is not
  // right for one you were half-way up. See readingPosition.ts for why the anchor
  // is a turn timestamp and not a key, an index or a pixel.

  /** Distance from the reading area's top edge to a row, in scroll coordinates. */
  const rowTop = (el: HTMLElement, node: HTMLElement) =>
    node.getBoundingClientRect().top - (el.getBoundingClientRect().top - el.scrollTop);

  // Nothing is remembered until you have actually moved the view. `stick` starts
  // true as an ASSUMPTION (follow the work), not an observation, so recording on
  // it would file "you were at the end" for every session you merely glanced at.
  // And the evidence is a GESTURE, not a `scroll` event: a scroll fires for
  // reasons that are not you — the reader re-anchoring as older windows arrive,
  // above all — and gating on that still filed phantom positions.
  const touched = useRef(false);
  const moved = () => { touched.current = true; };

  const shownRef = useRef(shown);
  shownRef.current = shown;

  const capture = useCallback(() => {
    const el = scroller.current;
    if (!el || !touched.current) return;
    if (stick.current) { rememberReading(session.id, { ts: 0, off: 0, end: true }); return; }
    const list = shownRef.current;
    const hit = [...rows.current.entries()]
      .sort((a, b) => a[0] - b[0])
      // The first row still showing at the top edge is the turn you are reading —
      // skipping any whose prompt is in a window we have not read yet, because a
      // fragment has no timestamp of its own to come back to.
      .find(([i, node]) => rowTop(el, node) + node.offsetHeight > el.scrollTop + 4
        && (list[i]?.startTs ?? 0) > 0);
    if (!hit) return;
    const [i, node] = hit;
    rememberReading(session.id, {
      ts: list[i].startTs, off: el.scrollTop - rowTop(el, node), end: false,
    });
  }, [session.id]);

  // Scroll fires in bursts; one write per quiet moment is plenty.
  const settle = useRef<number>(0);
  const onScrolled = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(capture, 150);
  };
  // Flush on the way out. Through a ref, because an effect that depended on
  // `capture` would run its cleanup on every dependency change, and this has to
  // mean unmount rather than "something moved".
  const flush = useRef(capture);
  flush.current = capture;
  useEffect(() => () => { window.clearTimeout(settle.current); flush.current(); }, []);

  /**
   * Looking for the remembered turn, paging backwards until it shows up. Bounded:
   * the reader holds one window and the turn may be several behind it, but a
   * remembered position is not worth walking a 19 MB transcript for, so past this
   * we give up and stay on the end — which is where the reader would have been
   * anyway.
   */
  const MAX_HOPS = 6;
  const seeking = useRef<{ ts: number; off: number; hops: number } | null>(null);

  /** One attempt to land on the remembered turn, or one window back towards it. */
  const trySeek = useCallback(() => {
    const st = seeking.current;
    const el = scroller.current;
    if (!st || !el) return;
    const list = shownRef.current;
    const idx = list.findIndex((x) => x.startTs === st.ts);
    const node = idx >= 0 ? rows.current.get(idx) : undefined;
    if (node) {
      el.scrollTop = Math.max(0, rowTop(el, node) + st.off);
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      seeking.current = null;
      return;
    }
    // Not in what we hold. Either walk back a window, or stop pretending: the end
    // is where the reader would have been anyway.
    if (atStart || blocked || st.hops >= MAX_HOPS) {
      seeking.current = null;
      stick.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    st.hops += 1;
    loadOlder();
  }, [atStart, blocked, loadOlder]);

  const wantRestore = useRef(true);
  // Restore on mount, and again on coming back into view: a pane can stay mounted
  // while its tile is hidden, so a browser that drops the scroll offset of a
  // `display: none` scroller would otherwise leave no re-mount to hook.
  useEffect(() => { if (!paused) wantRestore.current = true; }, [paused]);
  useEffect(() => {
    if (!wantRestore.current || !head) return;
    wantRestore.current = false;
    const want = recallReading(session.id);
    // No memory, or you were at the end: leave the landing to whoever owns it,
    // which is the open-on-the-end rule above.
    if (!want || want.end || !want.ts) return;
    seeking.current = { ts: want.ts, off: want.off, hops: 0 };
    stick.current = false;  // do not follow the end while we look for the place
    // Start here rather than waiting for the effect below. Passive effects run
    // AFTER layout effects, so arming the seek on this commit and leaving the
    // landing to a layout effect meant nothing tried until the next render — and
    // a quiet trace does not have one.
    trySeek();
  }, [head, paused, session.id, trySeek]);

  // Every window that arrives is another chance to land. After the hook's own
  // anchor effect, so this has the last word on scrollTop.
  useLayoutEffect(() => { trySeek(); }, [version, trySeek]);

  // The info panel closes the way a menu is expected to: Escape, or a press
  // anywhere else. `pointerdown` rather than `click` so a press that starts on
  // the reader below dismisses it before that press scrolls anything.
  useEffect(() => {
    if (!infoOpen) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!infoRef.current?.contains(e.target as Node)) setInfoOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInfoOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [infoOpen]);

  if (!head) return <div className="cxv-empty mono">{error || 'reading the trace…'}</div>;

  return (
    <div className="cxv">
      {/* The reader's own controls, on their own row: on a phone the pane
          header above has no spare width. */}
      <div className="cxv-bar mono">
        {/* Every conversation-level fact now lives behind this one button: model,
            turn and message counts, tokens, and the day the conversation started.
            They were a row of chips that pushed search to the edge on a phone.
            The panel is opened by TAP, not hover — the facts that used to be
            title attributes (the full timestamp, cached tokens) are plain text
            inside it, so a touch device can read them for the first time. */}
        <div className="cxv-info-wrap" ref={infoRef}>
          <button
            type="button"
            className={`cxv-info-btn${infoOpen ? ' on' : ''}`}
            aria-expanded={infoOpen}
            aria-haspopup="dialog"
            aria-label="About this conversation"
            title="About this conversation"
            onClick={() => setInfoOpen((open) => !open)}
          >i</button>
          {infoOpen && (
            <div className="cxv-info" role="dialog" aria-label="About this conversation">
              <dl className="cxv-info-facts">
                {head.model && (<><dt>Model</dt><dd>{head.model}</dd></>)}
                <dt>Turns</dt>
                <dd>
                  {fmtNum(exchanges.length)} turn{exchanges.length === 1 ? '' : 's'}
                  {head.total != null
                    ? ` · ${fmtNum(head.total)} message${head.total === 1 ? '' : 's'}`
                    : ` · ${fmtNum(head.loaded)} message${head.loaded === 1 ? '' : 's'} loaded`}
                </dd>
                {head.usage && (
                  <>
                    <dt>Tokens</dt>
                    <dd>
                      {fmtUsage(head.usage)}
                      {head.usage.cacheRead ? ` · ${fmtTok(head.usage.cacheRead)} cached` : ''}
                    </dd>
                  </>
                )}
                {head.firstTs != null && (
                  <>
                    <dt>Started</dt>
                    <dd>
                      <span className="cxv-when">{fmtStarted(head.firstTs)}</span>
                      {' · '}{new Date(head.firstTs).toLocaleString()}
                    </dd>
                  </>
                )}
              </dl>
              {/* The transcript, as a file. A session's own trace lives in its
                  harness's directory, outside the workspace, so the Files pane
                  cannot open it — this is the only way to hold the bytes. */}
              <div className="cxv-info-actions">
                {/* "Download" rather than "Download trace": the pair has to
                    read as one size, and the panel is already about this
                    conversation. The longer phrase is on the aria-label, which
                    costs a screen reader nothing and adds no hover dependency —
                    there is still not one `title` inside this panel. */}
                <a
                  className="btn-ghost"
                  href={api.traceDownloadUrl(session.id)}
                  download
                  aria-label="Download this conversation's transcript"
                  onClick={() => setInfoOpen(false)}
                ><DownloadGlyph /> Download</a>
                {onShare && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => { setInfoOpen(false); onShare(); }}
                  ><ShareGlyph /> Share…</button>
                )}
              </div>
            </div>
          )}
        </div>
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
        onWheel={moved}
        onTouchStart={moved}
        onPointerDown={moved}
        onKeyDown={moved}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          // Reading back into the conversation: fetch the stretch in front of
          // what we hold before the reader arrives at it.
          if (el.scrollTop < NEAR_TOP_PX) loadOlder();
          onScrolled();
        }}>
        <div className="cxv-col">
          {error && <div className="cxv-msg bad mono">{error} · showing the last read</div>}
          <button
            type="button"
            className="cxv-msg mono cxv-top"
            disabled={atStart || blocked}
            onClick={() => { moved(); loadOlder(); }}
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
                // One working line in the reader, and it is the last thing on
                // the page. While an echo is pending it owns that spot — the
                // agent is one process working on one thing, and two `working`
                // lines stacked (the live turn's and the echo's) is what read
                // as the widget being "sometimes below and above". The card has
                // had this guard since it grew an echo; the reader had not.
                running={live && x === exchanges[exchanges.length - 1] && !sent}
              />
            </div>
          ))}
          {sent && <PendingExchange text={sent.text} />}
          {!exchanges.length && !sent && <div className="cxv-msg mono">nothing in this trace yet</div>}
        </div>
      </div>

      {!readOnly && (
        <Composer
          className="cxv-live"
          containerClassName="cxv-composer"
          draft={draft}
          sending={sending}
          isMobile={isMobile}
          inputRef={inputRef}
          canSend={!!draft.trim() || attachments.length > 0}
          above={<Attachments
            attachments={attachments}
            disabled={sending || !allowAttachments}
            disabledReason={!allowAttachments ? 'Files are not available for remote agents yet — that agent cannot read files stored on this Space.' : undefined}
            onFiles={addAttachments}
            onRemove={removeAttachment}
          />}
          onChange={setDraft}
          onSend={send}
          onPasteFiles={allowAttachments ? addAttachments : undefined}
        />
      )}
      {(attachmentError || failed) && <div className="ov-note cxv-note" role="alert">{attachmentError || failed}</div>}

      {/* Below the composer, only an action earns the space. What used to live
          here — the workspace's absolute path and the date the conversation
          started — was reference material printed under a reply box: the path
          is in the pane header a few centimetres above (and in the Files pane),
          and the date now rides on the turn-count's tooltip. A reader that ends
          in a strip of grey path is a reader that ends in nothing to do. */}
      {onHandover && (
        <div className="cxv-foot mono">
          <span className="spacer" />
          <button className="cxv-mini" onClick={onHandover} title="Start a new agent from this conversation">
            continue in a new agent ↗
          </button>
        </div>
      )}
    </div>
  );
}
