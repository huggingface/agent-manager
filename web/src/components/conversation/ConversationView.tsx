import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import type { SubAgentEntry, TraceHit, TraceSearch, TraceTurn } from '../../api';
import { reconcileTrace } from '../../lib/readerModel';
import {
  HISTORY_MAX_EXCHANGES, HISTORY_TARGET_EXCHANGES, useTraceWindows,
  type TraceHeadInfo, type TraceSource,
} from '../../lib/traceWindows';

/** Longest a cold reader will hold its first transcript back (see `preparing`). */
const PREPARE_MAX_MS = 2_000;
/** Exchanges rendered around an old hit. The window the server points at is
 * bounded already; this bounds the DOM as well, and the hit is its last turn. */
const HIT_CONTEXT_EXCHANGES = 30;
import type { Session } from '../../types';
import { isRemote } from '../../types';
import {
  buildPendingPrompt, discardPendingAttachment, discardPendingAttachments,
  pendingAttachmentsFromFiles, revokePendingAttachments, uploadPendingAttachments,
} from '../../lib/attachments';
import type { PendingAttachment, PendingPrompt } from '../../lib/attachments';
import { recallReading, rememberReading } from './readingPosition';
import { useDraft } from './useDraft';
import { splitExchanges } from './exchanges';
import { searchIndex } from './readerSearch';
import { useVirtualRows } from './useVirtualRows';
import { cachedRoster, loadRoster } from '../../lib/subagentRoster';
import ExchangeView, { PendingExchange } from './Exchange';
import Attachments from '../Attachments';
import Composer from './Composer';
import InputRequiredNotice from './InputRequiredNotice';
import { writePaneMode } from '../../lib/paneMode';

/** The reader owns presentation and draft state. The store owns the transcript;
 * the virtual list owns measurement. Neither requires a terminal attachment. */
export default function ConversationView({
  session, paused, isMobile, readOnly, onHandover, searchOpen, onCloseSearch, onAttachPicker, onHead,
}: {
  session: Session;
  paused?: boolean;
  isMobile?: boolean;
  readOnly?: boolean;
  onHandover?: () => void;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  onAttachPicker?: (picker: { open: () => void; disabled: boolean; reason?: string } | null) => void;
  onHead?: (head: TraceHeadInfo | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const touched = useRef(false);
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());
  const [hit, setHit] = useState(0);
  const searchBox = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useDraft(session.id, inputRef);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<(PendingPrompt & { at: number }) | null>(null);
  const allowAttachments = !isRemote(session.cli);
  const [openWork, setOpenWork] = useState(new Map<string, boolean>());
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  /**
   * Whole-conversation search, and the old part of the conversation a result
   * opens. Both are deliberately separate from the reader's live history: the
   * scan is an explicit action that reads the transcript, and a result opens an
   * explicit historical window rather than paging the live store back to it.
   */
  const [scan, setScan] = useState<{
    q: string; state: 'searching' | 'done' | 'failed'; hits: TraceHit[];
    next: string | null; complete: boolean; clipped: boolean; error?: string;
  } | null>(null);
  const [historic, setHistoric] = useState<{
    hit: TraceHit; turns: TraceTurn[]; loading: boolean; error?: string } | null>(null);
  const beforeHit = useRef<{ end: boolean; key?: string; offset?: number } | null>(null);
  const scanRun = useRef(0);
  const scanAbort = useRef<AbortController | null>(null);
  const hitAbort = useRef<AbortController | null>(null);

  const src = useMemo<TraceSource>(() => ({
    window: (req, bytes, min, signal) => api.getTraceWindow(session.id, req, bytes, min, signal),
    summary: (signal) => api.getTraceSummary(session.id, signal),
  }), [session.id]);
  const onReset = useCallback(() => { following.current = true; setAtLatest(true); }, []);
  // The main reader asks for a useful amount of recent conversation up front.
  // Child transcripts and previews deliberately do not (see the hook).
  const reader = useTraceWindows(src, `session:${session.id}`, { paused, onReset, history: HISTORY_TARGET_EXCHANGES });
  const { head, error, phase, loading, notice, version, atStart, blocked, loadOlder, loadNewer, reload } = reader;
  const loadingEarlier = loading === 'tail' || loading === 'before';
  const turns = reader.turns.current;
  const exchanges = useMemo(() => splitExchanges(turns), [turns]);
  const index = useMemo(() => searchIndex(exchanges), [exchanges]);
  const shown = useMemo(() => exchanges.map((x, n) => ({ x, n })).filter(({ n }) => !q || index[n].includes(q)), [exchanges, index, q]);
  const keys = useMemo(() => shown.map(({ x }) => x.key), [shown]);
  const virtual = useVirtualRows(keys, scroller, following);
  const keysRef = useRef(keys); keysRef.current = keys;
  /**
   * A cold reader holds the first transcript back until it is worth showing.
   *
   * The first window is 128 KiB, which on a tool-heavy trace is two exchanges.
   * Bottom-anchoring stops the pages that follow from pushing that text down,
   * but it does not make two messages and a screen of empty space an acceptable
   * first page — the reader is supposed to open on a page of conversation.
   * Rows are laid out and measured throughout, so this is a paint delay and not
   * a fetch delay, and it is bounded four ways: coverage, the start of the
   * conversation, an unusable source, and a deadline. The composer is never
   * part of it, and a warm store starts revealed because its text is already
   * readable.
   */
  const [preparing, setPreparing] = useState(() => !reader.turns.current.length);
  // A terminal redraw is not evidence of work. Only transcript lifecycle
  // events light the working line; connection/recovery is separate chrome.
  const live = !!session.running && reader.activityConfirmed && head?.activity === 'working' && !session.inputRequired;
  const [roster, setRoster] = useState<SubAgentEntry[] | null>(() => cachedRoster(session.id));
  useEffect(() => {
    if (paused) return;
    let alive = true;
    const tick = () => loadRoster(session.id, true).then((agents) => { if (alive) setRoster(agents); }).catch(() => {});
    void tick();
    const timer = session.running ? window.setInterval(tick, 15_000) : undefined;
    return () => { alive = false; window.clearInterval(timer); };
  }, [session.id, session.running, paused]);

  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => discardPendingAttachments(session.id, attachmentsRef.current), [session.id]);
  const updateAttachment = (key: string, patch: Partial<PendingAttachment>) => {
    setAttachments((current) => {
      const next = current.map((item) => item.key === key ? { ...item, ...patch } : item);
      attachmentsRef.current = next; return next;
    });
  };
  const addAttachments = (files: File[]) => {
    if (!allowAttachments || sending || !files.length) return;
    const next = pendingAttachmentsFromFiles(files, attachmentsRef.current.length);
    attachmentsRef.current = [...attachmentsRef.current, ...next.attachments];
    setAttachments(attachmentsRef.current); setAttachmentError(next.error);
    void uploadPendingAttachments(session.id, next.attachments, updateAttachment).catch(() => {});
  };
  const removeAttachment = (key: string) => {
    if (sending) return;
    const removed = attachmentsRef.current.find((item) => item.key === key);
    if (removed) discardPendingAttachment(session.id, removed);
    attachmentsRef.current = attachmentsRef.current.filter((item) => item.key !== key);
    setAttachments(attachmentsRef.current); setAttachmentError(null);
  };
  const retryAttachment = (key: string) => {
    const attachment = attachmentsRef.current.find((item) => item.key === key);
    if (attachment && !sending) void uploadPendingAttachments(session.id, [attachment], updateAttachment).catch(() => {});
  };
  useEffect(() => {
    const last = exchanges[exchanges.length - 1];
    const text = last?.prompt?.blocks.filter((b) => b.type === 'text').map((b) => 'text' in b ? b.text : '').join('').trim();
    if (sent && (last?.startTs || 0) >= sent.at - 60_000 && text?.startsWith(sent.text)) setSent(null);
  }, [exchanges, sent]);
  const latest = () => {
    following.current = true; setAtLatest(true); touched.current = true;
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  const send = async () => {
    const text = draft.trim(), batch = attachmentsRef.current;
    if ((!text && !batch.length) || sending || batch.some((item) => !item.attachment)) return;
    const uploaded = batch.map((item) => item.attachment!);
    const optimistic = buildPendingPrompt(session.cli, text, uploaded);
    setSending(true); setFailed(null); setDraft(''); setSent({ ...optimistic, at: Date.now() });
    if (inputRef.current) inputRef.current.style.height = 'auto';
    latest();
    try {
      await api.sendInput(session.id, text, batch.map((item) => item.attachment!.id));
      revokePendingAttachments(batch); attachmentsRef.current = []; setAttachments([]); setAttachmentError(null);
      void reload();
    } catch (error) {
      setSent(null); setDraft(text);
      setFailed(error instanceof Error ? error.message : 'Failed to reach the agent. Your draft is safe.');
    } finally { setSending(false); }
  };

  // Search navigates matching exchanges in the LOADED history. Only visible
  // matches render markdown, and navigation moves this scroller alone.
  const beforeSearch = useRef<{ key: string; offset: number; end: boolean } | null>(null);
  const changeQuery = (value: string) => {
    // Capture before filtering commits: the virtual list's layout effect will
    // otherwise replace the anchor with a row from the filtered results.
    if (value.trim() && !beforeSearch.current) beforeSearch.current = {
      key: virtual.anchor.current?.key || '', offset: virtual.anchor.current?.offset || 0, end: following.current,
    };
    setQuery(value);
  };
  useEffect(() => {
    if (q) {
      following.current = false; setAtLatest(false); setHit(0); virtual.scrollTo(0);
    } else if (beforeSearch.current) {
      const saved = beforeSearch.current; beforeSearch.current = null;
      if (saved.end) latest(); else virtual.scrollTo(keys.indexOf(saved.key), saved.offset);
    }
  }, [q]); // navigation is intentional only on a changed query
  const nextHit = (direction: number) => {
    if (!shown.length) return;
    const next = (hit + direction + shown.length) % shown.length;
    setHit(next); virtual.scrollTo(next);
  };

  // ---- whole-conversation search -------------------------------------------
  // The instant filter above stays exactly as it was. This is the separate,
  // explicit action for everything older than the loaded stretch: it is started
  // by a button or ⌘/Ctrl+Enter, never by typing, and each request is bounded
  // and continued with a cursor. Results are bound to the query and the run
  // that asked for them, so a late answer to an abandoned query is dropped.
  const stopScan = useCallback(() => {
    scanRun.current++;
    scanAbort.current?.abort(); scanAbort.current = null;
  }, []);
  const runScan = async (more = false) => {
    const text = query.trim();
    if (!text) return;
    stopScan();
    const run = scanRun.current;
    const cursor = more ? scan?.next ?? null : null;
    const controller = new AbortController();
    scanAbort.current = controller;
    setScan((prev) => ({
      q: text, state: 'searching', clipped: prev && more ? prev.clipped : false,
      hits: more && prev && prev.q === text ? prev.hits : [], next: null, complete: false,
    }));
    try {
      const page: TraceSearch = await api.searchTraceHistory(
        session.id, text, cursor, head?.generation, controller.signal);
      if (run !== scanRun.current) return;                  // a newer query won
      setScan((prev) => ({
        q: text, state: 'done',
        hits: [...(more && prev && prev.q === text ? prev.hits : []), ...page.hits],
        next: page.next, complete: page.complete && !page.next,
        clipped: (more && prev ? prev.clipped : false) || page.clipped,
      }));
    } catch (error) {
      if (run !== scanRun.current) return;
      setScan((prev) => ({
        q: text, state: 'failed', hits: prev?.q === text ? prev.hits : [], next: prev?.next ?? null,
        complete: false, clipped: !!prev?.clipped,
        error: error instanceof Error ? error.message : 'The search could not finish.',
      }));
    } finally { if (scanAbort.current === controller) scanAbort.current = null; }
  };
  const openHit = async (target: TraceHit) => {
    // Remember the live reading position explicitly before borrowing the
    // scroller. The virtual list cannot hold it for us: history keeps arriving
    // while the old window is up, and by the time we come back the row may be
    // outside the rendered window, where a measured correction has nothing to
    // measure. `scrollTo` is the same path a remembered position from a
    // previous session is restored through, and it survives re-measurement.
    if (!historic) beforeHit.current = following.current
      ? { end: true }
      : { end: false, key: virtual.anchor.current?.key || '', offset: virtual.anchor.current?.offset || 0 };
    hitAbort.current?.abort();
    const controller = new AbortController();
    hitAbort.current = controller;
    setHistoric({ hit: target, turns: [], loading: true });
    try {
      const page = await api.getTraceWindow(session.id,
        { at: 'before', cursor: target.window.cursor, generation: head?.generation },
        target.window.bytes, target.window.min, controller.signal);
      if (hitAbort.current !== controller) return;
      setHistoric({ hit: target, turns: reconcileTrace(page.turns), loading: false });
    } catch (error) {
      if (hitAbort.current !== controller) return;
      setHistoric({ hit: target, turns: [], loading: false,
        error: error instanceof Error ? error.message : 'That part of the conversation could not be read.' });
    }
  };
  const closeHistoric = () => {
    hitAbort.current?.abort(); hitAbort.current = null;
    setHistoric(null);
    const saved = beforeHit.current; beforeHit.current = null;
    if (!saved) return;
    // After the live rows are mounted again, not during this event.
    queueMicrotask(() => {
      if (saved.end) { latest(); return; }
      const index = keysRef.current.indexOf(saved.key);
      if (index >= 0) { virtual.scrollTo(index, saved.offset); setAtLatest(false); }
      else latest();
    });
  };
  // A historical window is read-only and detached: it never advances the live
  // cursor, and leaving it puts the reader back where it was.
  const historicExchanges = useMemo(
    () => (historic ? splitExchanges(historic.turns).slice(-HIT_CONTEXT_EXCHANGES) : []),
    [historic],
  );
  useEffect(() => {
    if (searchOpen) searchBox.current?.focus();
    else { setQuery(''); stopScan(); setScan(null); setHistoric(null); }
  }, [searchOpen, stopScan]);
  useEffect(() => () => { stopScan(); hitAbort.current?.abort(); }, [stopScan]);
  useEffect(() => { stopScan(); setScan(null); setHistoric(null); }, [session.id, stopScan]);
  useLayoutEffect(() => {
    // The hit is the last turn of its window, so the bottom of the list is it.
    if (historic && !historic.loading && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [historic]);

  const position = useRef<ReturnType<typeof recallReading>>(null);
  const restore = useRef({ done: false, hops: 0 });
  useEffect(() => {
    if (paused || !head || restore.current.done || q) return;
    const saved = recallReading(session.id);
    if (!saved || saved.end) { restore.current.done = true; return; }
    const found = shown.findIndex(({ x }) => x.startTs === saved.ts);
    if (found >= 0) { virtual.scrollTo(found, saved.off); setAtLatest(false); restore.current.done = true; return; }
    if (loading) return;
    if (atStart || blocked || error || restore.current.hops >= 6) {
      restore.current.done = true;
      setRestoreNotice('Your previous place is outside the loaded history. Load earlier turns to find it.');
      return;
    }
    restore.current.hops++; void loadOlder();
  }, [head, version, loading, paused, q, atStart, blocked, error, shown, session.id, loadOlder, virtual.scrollTo]);
  const capture = () => {
    if (!touched.current || q || historic) return;
    const at = virtual.anchor.current;
    const exchange = at && shown.find(({ x }) => x.key === at.key)?.x;
    if (following.current) position.current = { ts: 0, off: 0, end: true };
    else if (exchange?.startTs) position.current = { ts: exchange.startTs, off: at!.offset, end: false };
  };
  /**
   * A page of conversation, not a page of estimates.
   *
   * The exchange target is about how much HISTORY is available; this is about
   * whether the first thing shown fills the reader. They are different
   * questions — twenty one-line exchanges do not cover a tall window, and one
   * long answer covers it without giving any history — so both run, and each
   * stops on its own terms. Bounded by HISTORY_MAX_EXCHANGES, so short rows
   * cannot walk the whole transcript, and by `atStart`, so a genuinely short
   * conversation settles immediately.
   */
  const covered = () => {
    const el = scroller.current;
    return !!el && el.clientHeight > 0 && virtual.measuredHeight() >= el.clientHeight;
  };
  useLayoutEffect(() => {
    if (paused || atStart || blocked || error || !exchanges.length || covered()) return;
    reader.wantHistory(Math.min(HISTORY_MAX_EXCHANGES, exchanges.length + 8));
  }, [virtual.offsets, virtual.measuredHeight, exchanges.length, atStart, blocked, error, paused, reader.wantHistory]);
  useLayoutEffect(() => {
    if (!preparing) return;
    // Anything that means more history is not coming, or is not needed.
    if (atStart || blocked || error || phase === 'empty' || reader.fill === 'limited' || covered()) setPreparing(false);
  }, [preparing, atStart, blocked, error, phase, reader.fill, virtual.offsets, exchanges.length]);
  useEffect(() => {
    if (!preparing) return;
    // The safety bound. Preparation is meant to be brief; if the source is slow
    // enough that it is not, an honestly partial page beats a spinner.
    const timer = setTimeout(() => setPreparing(false), PREPARE_MAX_MS);
    return () => clearTimeout(timer);
  }, [preparing]);

  const settle = useRef<ReturnType<typeof setTimeout>>();
  const interact = () => { touched.current = true; virtual.cancelTarget(); };
  useEffect(() => () => { clearTimeout(settle.current); if (position.current) rememberReading(session.id, position.current); }, [session.id]);
  useLayoutEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [sent, live, session.inputRequired]);

  useEffect(() => {
    onAttachPicker?.({ open: () => filePicker.current?.click(), disabled: sending || !allowAttachments,
      reason: !allowAttachments ? 'Files are not available for remote agents yet.' : sending ? 'Wait for this message to send' : 'Attach files' });
    return () => onAttachPicker?.(null);
  }, [onAttachPicker, sending, allowAttachments]);
  const reportHead = useRef(onHead); reportHead.current = onHead;
  useEffect(() => { reportHead.current?.(head); }, [head]);
  useEffect(() => () => reportHead.current?.(null), []);

  return <div className="cxv">
    <div className="cxv-bar cxv-status mono">
      <span>{head ? `${exchanges.length.toLocaleString()} turns loaded` : phase === 'loading' ? 'Reading transcript…' : 'Conversation'}</span>
      <span className="spacer" />
      {head && !atStart && <button className="cxv-mini" disabled={loadingEarlier || blocked} onClick={() => { following.current = false; void loadOlder(); }}>Earlier</button>}
      <button className="cxv-mini" onClick={() => { if (q) { setQuery(''); beforeSearch.current = null; } latest(); void loadNewer(); }} title="Follow the latest messages">{atLatest && !q ? 'At latest' : '↓ Latest'}</button>
      <button className="cxv-mini" onClick={() => void reload()} aria-label="Refresh transcript" title="Refresh transcript">↻</button>
    </div>
    {searchOpen && <div className="cxv-bar mono">
      <input ref={searchBox} className="cxv-search" aria-label="Search the conversation" placeholder="Search loaded conversation…" value={query}
        onChange={(event) => changeQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Escape') { if (historic) closeHistoric(); else onCloseSearch?.(); return; }
          if (event.key !== 'Enter') return;
          // Enter walks the loaded matches, as it always has. Starting a scan of
          // the whole transcript is a different, deliberate keystroke, so an
          // edited query cannot start one by accident or start two at once.
          if (event.metaKey || event.ctrlKey) void runScan();
          else nextHit(event.shiftKey ? -1 : 1);
        }} />
      {q && <span className="cxv-hits">{shown.length ? `${Math.min(hit + 1, shown.length)}/${shown.length} turns` : 'No matches'}</span>}
      <button className="cxv-mini" disabled={!q || !shown.length} onClick={() => nextHit(-1)} aria-label="Previous matching turn">↑</button>
      <button className="cxv-mini" disabled={!q || !shown.length} onClick={() => nextHit(1)} aria-label="Next matching turn">↓</button>
      <button className="cxv-mini" disabled={!q || scan?.state === 'searching'} onClick={() => void runScan()}
        title="Search every message in this conversation, including history that is not loaded (⌘/Ctrl+Enter)">
        {scan?.state === 'searching' ? 'Searching all…' : 'Search all history'}</button>
      {scan?.state === 'searching' && <button className="cxv-mini" onClick={stopScan} aria-label="Cancel the whole-history search">Cancel</button>}
    </div>}
    <input ref={filePicker} className="image-file-input" type="file" multiple disabled={sending || !allowAttachments}
      onChange={(event) => { addAttachments(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />
    <div className="cxv-body cxv-windowed" ref={scroller} tabIndex={0} aria-label="Conversation transcript"
      onWheel={interact} onTouchStart={interact} onPointerDown={interact} onKeyDown={interact}
      onScroll={(event) => {
        const el = event.currentTarget;
        // A historical window borrows the scroller but is not the live
        // conversation: reading follow intent, an anchor or a saved position
        // out of its geometry would answer questions about the wrong content,
        // and leaving it would then land somewhere nobody asked for.
        if (historic) return;
        following.current = !q && el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        setAtLatest(following.current); virtual.onScroll(); capture();
        clearTimeout(settle.current); settle.current = setTimeout(() => { if (position.current) rememberReading(session.id, position.current); }, 150);
        if (touched.current && !q && el.scrollTop < 250 && !loadingEarlier) void loadOlder();
      }}>
      <div className="cxv-col">
        {error && <div className="cxv-msg bad mono" role="status">{error}{head ? ' · Your last read is still here.' : ''} <button className="cxv-mini" onClick={() => void reload()}>Retry now</button></div>}
        {(notice || restoreNotice) && <div className="cxv-msg mono" role="status">{notice || restoreNotice} <button className="cxv-mini" onClick={() => { reader.dismissNotice(); setRestoreNotice(null); }}>Dismiss</button></div>}
        {head && <button className="cxv-msg mono cxv-top" disabled={atStart || blocked || loadingEarlier} onClick={() => { following.current = false; void loadOlder(); }}>
          {blocked ? 'Earlier history contains a record too large to display' : atStart ? 'Beginning of the conversation' : loading === 'before' ? 'Loading earlier turns…' : 'Load earlier turns'}
        </button>}
        {head?.note && <div className="cxv-msg mono">{head.note}</div>}
        {q && <div className="cxv-msg mono">{shown.length} of {exchanges.length} loaded turns match{atStart ? '' : ' · Earlier history has not been searched'}</div>}
        {preparing && <div className="cxv-msg mono" role="status">Opening the conversation…</div>}
        {scan && <div className="cxv-scan mono">
          <div className="cxv-msg" role="status">
            {scan.state === 'searching' ? `Searching the whole conversation for “${scan.q}”…`
              : scan.state === 'failed' ? scan.error
              : scan.hits.length ? `${scan.hits.length}${scan.next ? '+' : ''} message${scan.hits.length === 1 ? '' : 's'} match “${scan.q}”`
              : scan.complete ? `No message in this conversation contains “${scan.q}”`
              : `No matches yet in the part searched so far`}
            {scan.clipped && ' · some very long messages were searched only as far as the reader displays them'}
            {!scan.complete && scan.state === 'done' && ' · not the whole conversation yet'}
            {' '}
            {scan.next && scan.state !== 'searching'
              && <button className="cxv-mini" onClick={() => void runScan(true)}>Keep searching earlier</button>}
            {scan.state === 'failed' && <button className="cxv-mini" onClick={() => void runScan()}>Try again</button>}
            <button className="cxv-mini" onClick={() => { stopScan(); setScan(null); closeHistoric(); }}>Clear</button>
          </div>
          {scan.hits.map((h, i) => <button key={`${h.window.cursor}:${h.id ?? i}:${h.ts ?? i}`}
            className={`cxv-hitrow${historic?.hit === h ? ' on' : ''}`} onClick={() => void openHit(h)}>
            <span className="cxv-hitwho">{h.role === 'user' ? 'you' : h.role === 'assistant' ? 'agent' : h.role}</span>
            <span className="cxv-hittext">
              {h.snippet.text.slice(0, h.snippet.at)}
              <mark>{h.snippet.text.slice(h.snippet.at, h.snippet.at + h.snippet.length)}</mark>
              {h.snippet.text.slice(h.snippet.at + h.snippet.length)}
            </span>
            {h.occurrences > 1 && <span className="cxv-hitwho">×{h.occurrences}</span>}
          </button>)}
        </div>}
        {historic && <div className="cxv-msg mono" role="status">
          Showing an older part of the conversation. The latest messages are not below this.
          {' '}<button className="cxv-mini" onClick={closeHistoric}>Back to the current view</button>
        </div>}
        {historic && <div className="cxv-rows">
          {historic.loading && <div className="cxv-msg mono" role="status">Reading that part of the conversation…</div>}
          {historic.error && <div className="cxv-msg bad mono" role="status">{historic.error}</div>}
          {historic.hit.clipped && !historic.loading && !historic.error && <div className="cxv-msg mono">
            This message is longer than the reader displays; the match may be in the part not shown.
          </div>}
          {historicExchanges.map((x, n) => <div key={`h:${x.key}`} data-x={x.key} data-historic="1">
            <ExchangeView x={x} n={n + 1} total={historicExchanges.length} q={scan?.q.toLowerCase() || undefined}
              baseModel={head?.model || undefined} open={false} onToggle={() => {}}
              turns={historic.turns} sessionId={session.id} live={false} roster={roster} />
          </div>)}
        </div>}
        <div hidden={!!historic}
          className={`${exchanges.length ? 'cxv-rows' : ''}${preparing ? ' cxv-preparing' : ''}`.trim() || undefined}
          ref={virtual.container}>
          <div aria-hidden="true" style={{ height: virtual.before }} />
          {shown.slice(virtual.start, virtual.end).map(({ x, n }) => <div key={x.key} data-x={x.key} data-row-key={x.key} ref={(node) => virtual.measure(x.key, node)}>
            <ExchangeView x={x} n={n + 1} total={exchanges.length} q={q || undefined} baseModel={head?.model || undefined}
              open={q ? undefined : openWork.get(x.key) || false} onToggle={() => setOpenWork((map) => new Map(map).set(x.key, !map.get(x.key)))}
              running={live && n === exchanges.length - 1 && !sent} turns={turns} sessionId={session.id} live={!!session.running && !paused} roster={roster} />
          </div>)}
          <div aria-hidden="true" style={{ height: virtual.after }} />
        </div>
        {sent && <PendingExchange text={sent.displayText} />}
        {!exchanges.length && !sent && <div className="cxv-welcome">
          <div>{phase === 'loading' ? 'Opening the conversation…' : error ? 'The transcript is temporarily unavailable.' : head && !atStart ? 'No messages in this stretch. Load earlier turns to continue reading.' : readOnly ? 'Nothing recorded yet.' : 'Start the conversation.'}</div>
          <p>{readOnly ? 'New messages will appear here when the trace updates.' : 'Send a prompt below. You don’t need to open the terminal first.'}</p>
        </div>}
        {!readOnly && session.inputRequired && <InputRequiredNotice input={session.inputRequired} onOpenTerminal={() => writePaneMode('terminal')} />}
      </div>
    </div>
    {!readOnly && <Composer className="cxv-live" containerClassName="cxv-composer" draft={draft} sending={sending} isMobile={isMobile} inputRef={inputRef}
      canSend={(!!draft.trim() || attachments.length > 0) && attachments.every((item) => !!item.attachment)}
      above={<Attachments showPicker={false} attachments={attachments} disabled={sending || !allowAttachments}
        disabledReason={!allowAttachments ? 'Files are not available for remote agents yet.' : undefined} onFiles={addAttachments} onRemove={removeAttachment} onRetry={retryAttachment} />}
      onChange={setDraft} onSend={send} onPasteFiles={allowAttachments ? addAttachments : undefined} />}
    {(attachmentError || failed) && <div className="ov-note cxv-note" role="alert">{attachmentError || failed}</div>}
    {onHandover && <div className="cxv-foot mono"><span className="spacer" /><button className="cxv-mini" onClick={onHandover}>Continue in a new agent ↗</button></div>}
  </div>;
}
