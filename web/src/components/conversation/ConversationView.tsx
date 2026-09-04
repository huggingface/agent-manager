import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import type { SubAgentEntry } from '../../api';
import { useTraceWindows, type TraceHeadInfo, type TraceSource } from '../../lib/traceWindows';
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

  const src = useMemo<TraceSource>(() => ({
    window: (req, bytes, min, signal) => api.getTraceWindow(session.id, req, bytes, min, signal),
    summary: (signal) => api.getTraceSummary(session.id, signal),
  }), [session.id]);
  const onReset = useCallback(() => { following.current = true; setAtLatest(true); }, []);
  const reader = useTraceWindows(src, `session:${session.id}`, { paused, onReset });
  const { head, error, phase, loading, notice, version, atStart, blocked, loadOlder, loadNewer, reload } = reader;
  const turns = reader.turns.current;
  const exchanges = useMemo(() => splitExchanges(turns), [turns]);
  const index = useMemo(() => searchIndex(exchanges), [exchanges]);
  const shown = useMemo(() => exchanges.map((x, n) => ({ x, n })).filter(({ n }) => !q || index[n].includes(q)), [exchanges, index, q]);
  const keys = useMemo(() => shown.map(({ x }) => x.key), [shown]);
  const virtual = useVirtualRows(keys, scroller, following);
  // A terminal redraw is not evidence of work. Only transcript lifecycle
  // events light the working line; connection/recovery is separate chrome.
  const live = !!session.running && head?.activity === 'working' && !session.inputRequired;
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
  useEffect(() => {
    if (searchOpen) searchBox.current?.focus(); else setQuery('');
  }, [searchOpen]);
  useEffect(() => {
    if (q) {
      if (!beforeSearch.current) beforeSearch.current = { key: virtual.anchor.current?.key || '', offset: virtual.anchor.current?.offset || 0, end: following.current };
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
    if (!touched.current || q) return;
    const at = virtual.anchor.current;
    const exchange = at && shown.find(({ x }) => x.key === at.key)?.x;
    if (following.current) position.current = { ts: 0, off: 0, end: true };
    else if (exchange?.startTs) position.current = { ts: exchange.startTs, off: at!.offset, end: false };
  };
  const settle = useRef<ReturnType<typeof setTimeout>>();
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
      {head && !atStart && <button className="cxv-mini" disabled={!!loading || blocked} onClick={() => { following.current = false; void loadOlder(); }}>Earlier</button>}
      <button className="cxv-mini" onClick={() => { if (q) { setQuery(''); beforeSearch.current = null; } latest(); void loadNewer(); }} title="Follow the latest messages">{atLatest && !q ? 'At latest' : '↓ Latest'}</button>
      <button className="cxv-mini" onClick={() => void reload()} aria-label="Refresh transcript" title="Refresh transcript">↻</button>
    </div>
    {searchOpen && <div className="cxv-bar mono">
      <input ref={searchBox} className="cxv-search" aria-label="Search loaded conversation" placeholder="Search loaded conversation…" value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onCloseSearch?.(); if (event.key === 'Enter') nextHit(event.shiftKey ? -1 : 1); }} />
      {q && <span className="cxv-hits">{shown.length ? `${Math.min(hit + 1, shown.length)}/${shown.length} turns` : 'No matches'}</span>}
      <button className="cxv-mini" disabled={!q || !shown.length} onClick={() => nextHit(-1)} aria-label="Previous matching turn">↑</button>
      <button className="cxv-mini" disabled={!q || !shown.length} onClick={() => nextHit(1)} aria-label="Next matching turn">↓</button>
    </div>}
    <input ref={filePicker} className="image-file-input" type="file" multiple disabled={sending || !allowAttachments}
      onChange={(event) => { addAttachments(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />
    <div className="cxv-body cxv-windowed" ref={scroller} tabIndex={0} aria-label="Conversation transcript"
      onWheel={() => { touched.current = true; }} onTouchStart={() => { touched.current = true; }} onPointerDown={() => { touched.current = true; }} onKeyDown={() => { touched.current = true; }}
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = !q && el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        setAtLatest(following.current); virtual.onScroll(); capture();
        clearTimeout(settle.current); settle.current = setTimeout(() => { if (position.current) rememberReading(session.id, position.current); }, 150);
        if (touched.current && !q && el.scrollTop < 250 && !loading) void loadOlder();
      }}>
      <div className="cxv-col">
        {error && <div className="cxv-msg bad mono" role="status">{error}{head ? ' · Your last read is still here.' : ''} <button className="cxv-mini" onClick={() => void reload()}>Retry now</button></div>}
        {(notice || restoreNotice) && <div className="cxv-msg mono" role="status">{notice || restoreNotice} <button className="cxv-mini" onClick={() => { reader.dismissNotice(); setRestoreNotice(null); }}>Dismiss</button></div>}
        {head && <button className="cxv-msg mono cxv-top" disabled={atStart || blocked || !!loading} onClick={() => { following.current = false; void loadOlder(); }}>
          {blocked ? 'Earlier history contains a record too large to display' : atStart ? 'Beginning of the conversation' : loading === 'before' ? 'Loading earlier turns…' : 'Load earlier turns'}
        </button>}
        {head?.note && <div className="cxv-msg mono">{head.note}</div>}
        {q && <div className="cxv-msg mono">{shown.length} of {exchanges.length} loaded turns match{atStart ? '' : ' · Earlier history has not been searched'}</div>}
        <div ref={virtual.container}>
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
