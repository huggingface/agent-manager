import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as api from '../api';
import type { MetaSession, TraceTurn } from '../api';
import type { Cli, OverviewChip, OverviewFilter, OverviewSort, Session, SessionState, Tree } from '../types';
import { chipBuckets, isPassive, isRemote } from '../types';
import { renderMarkdown } from '../lib/markdown';
import { rankSessions, sortLabel } from '../lib/overviewSort';
import { hiddenSessionIds } from '../lib/overviewHidden';
import type { Rankable } from '../lib/overviewSort';
import {
  defaultAttachmentPrompt, pendingAttachmentsFromFiles, revokePendingAttachments, uploadPendingAttachments,
} from '../lib/attachments';
import type { PendingAttachment } from '../lib/attachments';
import Attachments from './Attachments';
import Logo from './Logo';
import Composer from './conversation/Composer';
import ExchangeView, { PendingExchange } from './conversation/Exchange';
import { useDraft } from './conversation/useDraft';
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

/**
 * Is this agent at work right now — the one fact the card's "running" line and
 * the sorted feed's pinned block both stand on.
 *
 * `state === 'working'` is the terminal-derived signal: the screen changed in
 * the last few seconds. `digest.running` is the agent's own task lifecycle
 * (codex `task_started` with no `task_complete`), which catches an agent that is
 * thinking without printing. Two guards on the second one, and both matter:
 *
 *  · NOT for a remote agent, whose digest sets `running` when the machine is
 *    merely *connected* (`server/src/remote.js` — `isListening && !paused`).
 *    That is presence, not work; on that rule every laptop with the bridge open
 *    would sit pinned at the top of the feed forever. Its state is the honest
 *    signal there — `working` means it was handed a message it hasn't answered
 *    (see REMOTE_STATE_LABEL in types.ts).
 *  · NOT for a stopped session. `task_complete` is what clears `running`, so a
 *    codex that died mid-task (Ctrl-C, a restart, an OOM) leaves a transcript
 *    that says "running" for as long as it exists. Without this the corpse
 *    holds the top row of the feed forever, under a heading that says `running
 *    now`, next to its own grey `stopped` dot. A live agent thinking quietly is
 *    `waiting`, not `stopped`, so the case this is for still works.
 */
const atWork = (m: MetaSession) =>
  m.state === 'working'
  || (!isRemote(m.cli) && m.state !== 'stopped' && !!m.digest?.running);

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

/** Opening this session's pane in reader mode rather than on the TTY. */
const openRendered = (id: string, onOpen: (sid: string) => void) => {
  writePaneMode('reader');   // app-wide, and it reaches open panes too
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
export function Card({ s, color, group, pending, isMobile, onOpen, onClose }: {
  s: MetaSession;
  color?: string;
  // The group this agent belongs to, when the feed is not already drawing one
  // around it (a sorted feed is flat). Same `[Group] name` a pane header uses.
  group?: string | null;
  pending?: boolean; // digest still loading — show a shimmer instead of "no prompt yet"
  isMobile?: boolean;
  onOpen: (sid: string) => void;
  onClose?: () => void; // present when the card lives in the conversation window
}) {
  const d = s.digest;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // One unsent reply per agent, shared with reader mode: it is the same act on
  // the same session, so the text you started in the card is the text the reader
  // hands back. See drafts.ts for what it survives.
  const [draft, setDraft] = useDraft(s.id, inputRef);
  const [images, setImages] = useState<PendingAttachment[]>([]);
  const imagesRef = useRef<PendingAttachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Optimistic echo: the sent text becomes the prompt line the moment the
  // send succeeds — the digest round-trip (CLI writes transcript → rebuild →
  // poll) can take seconds, and a frozen card reads as "did that get lost?".
  const [sent, setSent] = useState<{ text: string; at: number } | null>(null);
  const [histIdx, setHistIdx] = useState(0); // digest fallback only: n-th answer back
  const [back, setBack] = useState(0);       // how many earlier turns are shown
  const [openWork, setOpenWork] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  // The window is the only place the card can grow; inline in the list it stays
  // a summary, so the answer is clamped and history stays behind the pane.
  const windowed = !!onClose;
  const allowAttachments = !isRemote(s.cli);

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => revokePendingAttachments(imagesRef.current), []);

  const addImages = (files: File[]) => {
    if (!allowAttachments || sending || !files.length) return;
    const next = pendingAttachmentsFromFiles(files, imagesRef.current.length);
    const merged = [...imagesRef.current, ...next.attachments];
    imagesRef.current = merged;
    setImages(merged);
    setImageError(next.error);
  };
  const removeImage = (key: string) => {
    if (sending) return;
    setImages((current) => {
      const removed = current.find((image) => image.key === key);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const next = current.filter((image) => image.key !== key);
      imagesRef.current = next;
      return next;
    });
    setImageError(null);
  };
  const updateImage = (key: string, patch: Partial<PendingAttachment>) => {
    setImages((current) => {
      const next = current.map((image) => image.key === key ? { ...image, ...patch } : image);
      imagesRef.current = next;
      return next;
    });
  };

  // After you send (or when the transcript shows a prompt newer than the last
  // answer), the old answer is stale — a spinner takes its place.
  const digestCaughtUp = !!d && !!sent && d.lastPromptTs >= sent.at - 60_000;
  if (sent && digestCaughtUp) setSent(null);
  // Running: one definition, shared with the tile and with the sorted feed's
  // pinned block — see atWork(). It used to be spelled out here, which is how a
  // connected-but-idle remote agent came to say "running" on its own card while
  // the block that claims to hold the running ones left it out.
  const running = atWork(s);
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
    const batch = imagesRef.current;
    if ((!text && !batch.length) || sending) return;
    const optimisticText = text || defaultAttachmentPrompt(batch.length);
    setSending(true);
    setFailed(null);
    setDraft('');
    setSent({ text: optimisticText, at: Date.now() });
    setHistIdx(0);
    if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.blur(); }
    try {
      const attachments = await uploadPendingAttachments(s.id, batch, updateImage);
      await api.sendInput(s.id, text, attachments.map((image) => image.id));
      revokePendingAttachments(batch);
      imagesRef.current = [];
      setImages([]);
      setImageError(null);
    } catch (error) {
      setSent(null);
      setDraft(text);
      setFailed(error instanceof Error ? error.message : 'failed to reach the agent');
      setTimeout(() => setFailed(null), 5000);
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
        {group && <span className="ov-gtag mono">[{group}]</span>}
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
            {justSent && sent && <PendingExchange text={sent.text} />}
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

      <Composer
        draft={draft}
        sending={sending}
        isMobile={isMobile}
        inputRef={inputRef}
        canSend={!!draft.trim() || images.length > 0}
        above={<Attachments
          attachments={images}
          disabled={sending || !allowAttachments}
          disabledReason={!allowAttachments ? 'Files are not available for remote agents yet — that agent cannot read files stored on this Space.' : undefined}
          onFiles={addImages}
          onRemove={removeImage}
        />}
        onChange={setDraft}
        onSend={send}
        onPasteFiles={allowAttachments ? addImages : undefined}
      />
      {(imageError || failed) && <div className="ov-note" role="alert">{imageError || failed}</div>}
    </div>
  );
}

/** Compact tile: status + prompt + state; click opens the conversation window. */
function Tile({ s, color, group, dim, pending, onOpen }: { s: MetaSession; color?: string; group?: string | null; dim?: boolean; pending?: boolean; onOpen: () => void }) {
  const d = s.digest;
  const running = atWork(s);   // same definition as the card and the pinned block
  const last = Math.max(d?.lastAssistantTs || 0, d?.lastPromptTs || 0) || Date.parse(s.createdAt) || 0;
  // ring = waiting on you AND recent — a fleet where everything is "waiting
  // since last week" shouldn't glow everywhere
  const fresh = s.state === 'waiting' && Date.now() - last < 24 * 3600e3;
  return (
    <div className={`ovt-tile${fresh ? ' attn' : ''}${dim ? ' archived' : ''}`} onClick={onOpen}>
      {/* A tile is ~225px: a group prefix INSIDE the name row would ellipsise,
          and so would the name, leaving "[Age… trace reader pa…" — two clipped
          strings and no legible fact. It gets its own line, where the full
          width is available (the list card is wide enough to keep it inline). */}
      {group && <div className="ovt-gline mono">[{group}]</div>}
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
 *  slabs, loose agents as standalone panels. Unless a sort is on, in which case
 *  it is one flat ranked column instead (see §"sorted feed" below). */
export default function Overview({ clis, tree, chip, sort, view, archived, showArchived, showHidden, meta, metaReady, isMobile, onOpen }: {
  clis: Cli[];
  tree: Tree;
  chip: OverviewChip;     // controlled by the bottom bar in App
  sort: OverviewSort;     // ditto, and independent of the filter
  view: 'tiles' | 'list'; // controlled by the bottom bar in App
  archived: Set<string>;
  showArchived: boolean;
  // Reveal what `tree.hidden` hides, for as long as you are looking. Transient by
  // design — a persisted "show hidden" would be a mode you forget you are in, and
  // hiding would then look broken.
  showHidden: boolean;
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

  // Hidden refs resolved down to session ids: a hidden GROUP hides its members,
  // and `s:<id>` hides one agent wherever it sits. Doing it once here is what
  // makes hiding hold in all three renderings and under every sort — including
  // the ranked feed's pinned `running now` block, which is the case that matters:
  // hide a group and its working agent must not float back to the top.
  const hiddenIds = useMemo(() => hiddenSessionIds(tree), [tree]);

  // One chip can stand for several buckets ('started' is waiting AND working), so
  // this is set membership, not equality.
  const buckets = chipBuckets(chip);
  const visible = (s: MetaSession) =>
    buckets.includes(bucket(s.state))
    && (showArchived || !archived.has(s.id))
    && (showHidden || !hiddenIds.has(s.id));

  // Which group each agent is in, by name. Only the sorted feed needs it: the
  // manual feed draws the group as a frame around its members and would be
  // saying it twice (the same rule the sidebar and pane headers follow —
  // web/src/lib/sessionTitle.ts).
  const groupNameOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of tree.groups) for (const id of g.sessionIds) m[id] = g.name;
    return m;
  }, [tree.groups]);

  // ---- sorted feed: flat, ranked, groups become a prefix ----
  //
  // Sorting FLATTENS the grouping rather than ordering inside each capsule.
  // "Where did I last type something" is a question about the whole fleet; an
  // answer split across five capsules still has to be scanned capsule by
  // capsule, and the first card of the feed — the one place the eye lands —
  // would only be the newest agent *of whichever group happens to be first in
  // the sidebar*. Which group an agent is in is not lost, it moves onto the
  // card as `[Group] name`, exactly as a pane header spells it.
  const sorted = sort !== 'manual';
  const sections = useMemo(() => {
    if (!sorted) return null;
    // Walk the tree so ties (and the whole undated tail) come out in the order
    // you arranged them in the sidebar.
    const items: (Rankable & { m: MetaSession })[] = [];
    for (const ref of tree.order) {
      const ids = ref.startsWith('s:') ? [ref.slice(2)] : groupById[ref.slice(2)]?.sessionIds ?? [];
      for (const id of ids) {
        const s = sessById[id];
        if (!s || !eligible(s)) continue;
        const m = dataFor(s);
        if (!visible(m)) continue;
        items.push({
          id,
          m,
          lastPromptTs: m.digest?.lastPromptTs || 0,
          lastAssistantTs: m.digest?.lastAssistantTs || 0,
          // Don't pin when the chip has already kept ONLY working sessions
          // (`running`): `visible()` has kept nothing else, so pinning them all
          // would empty the sorted block and make the sort a no-op that still
          // looks selected. Asked as a question about the BUCKET SET rather than
          // about the chip's name, so a chip that merely includes working —
          // `started`, `all` — still pins, and the working agents float to the top
          // of the wider set instead of being lost in it.
          running: !(buckets.length === 1 && buckets[0] === 'working') && atWork(m),
        });
      }
    }
    // Until the first /api/meta lands every digest is null, which would file the
    // whole fleet under "nothing sent yet" — a labelled claim about agents we
    // know nothing about yet. One unlabelled block until we do.
    if (!metaReady) return { running: [], dated: items, undated: [] };
    return rankSessions(items, sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, sort, tree.order, sessById, groupById, meta, metaReady, chip, archived, showArchived, hiddenIds, showHidden]);

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
    // Revealed-but-hidden reads the same as archived: present, and visibly not
    // part of what you normally look at.
    return <Tile key={s.id} s={m} color={colorOf[s.cli]} dim={archived.has(s.id) || hiddenIds.has(s.id)} pending={pending(s.id)} onOpen={() => setOpenId(s.id)} />;
  };
  const tileBlocks: ReactNode[] = [];
  let looseTiles: ReactNode[] = [];
  const flushLoose = () => {
    if (looseTiles.length) tileBlocks.push(<div className="ovt-grid" key={`loose-${tileBlocks.length}`}>{looseTiles}</div>);
    looseTiles = [];
  };
  if (!sorted) {
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
  }

  /**
   * The ranked feed: at most three labelled blocks, in this order.
   *
   *  · running now — pinned, because a working agent's last message is whatever
   *    it said BEFORE it started, and ranking it by that buries the one agent
   *    that is doing something under a wall of finished ones.
   *  · the sort itself — what you asked for, newest first.
   *  · the tail — an agent with no such message at all (never started, no
   *    transcript, a harness that writes none). Last, and labelled, so a 0
   *    timestamp cannot pass itself off as "oldest".
   *
   * Every block is the same card or tile the manual feed draws; only the order
   * and the `[Group]` prefix change.
   */
  const rankedBlocks = (): ReactNode[] => {
    if (!sections) return [];
    type Row = { id: string; m: MetaSession };
    const blocks = [
      { key: 'running', label: 'running now', rows: sections.running },
      // No label before the first poll answers: `sections` is unranked then.
      { key: 'dated', label: metaReady ? sortLabel(sort) : '', rows: sections.dated },
      { key: 'undated', label: sort === 'prompt' ? 'nothing sent yet' : 'no reply yet', rows: sections.undated },
    ].filter((b) => b.rows.length > 0);
    if (!blocks.length) return [];

    // ONE parent for every card, with the labels as siblings between them —
    // never a wrapper per block. A card whose section changes (it finishes, you
    // send to it, its first prompt lands, you switch sort) would otherwise get a
    // new PARENT, and React remounts on a changed parent no matter how stable
    // the key is: the reply box's draft, the unfolded work, the scroll position
    // and the optimistic echo all live in `Card` state and would be destroyed
    // mid-sentence by a background poll.
    const out: ReactNode[] = [];
    for (const b of blocks) {
      if (b.label) out.push(
        <div className="ov-sortlbl mono" key={`lbl:${b.key}`}>
          <span>{b.label}</span><span className="ov-sortrule" /><span className="ov-sortn">{b.rows.length}</span>
        </div>,
      );
      for (const { m } of b.rows as Row[]) {
        out.push(view === 'tiles'
          ? <Tile key={m.id} s={m} color={colorOf[m.cli]} group={groupNameOf[m.id]} dim={archived.has(m.id) || hiddenIds.has(m.id)}
              pending={pending(m.id)} onOpen={() => setOpenId(m.id)} />
          : <div key={m.id} className="ov-panel">
              <Card s={m} color={colorOf[m.cli]} group={groupNameOf[m.id]} pending={pending(m.id)} isMobile={isMobile} onOpen={onOpen} />
            </div>);
      }
    }
    // Tiles need the grid as that single parent; the labels span its full width.
    return view === 'tiles' ? [<div className="ovt-grid" key="ranked">{out}</div>] : out;
  };

  const openSess = openId ? sessById[openId] : null;
  const windowEl = openSess && (
    <div className="ovw-backdrop" onClick={() => setOpenId(null)}>
      <div className="ovw-win" onClick={(e) => e.stopPropagation()}>
        {/* The window shows ONE agent on its own — no capsule around it, sorted
            or not — so it names its group the way a pane header does. */}
        <Card s={dataFor(openSess)} color={colorOf[openSess.cli]} group={groupNameOf[openSess.id]}
          pending={pending(openSess.id)} isMobile={isMobile} onOpen={onOpen} onClose={() => setOpenId(null)} />
      </div>
    </div>
  );

  // An empty feed has more than one cause now, and guessing wrong is worse than
  // saying nothing: "no agents yet" while a hidden group sits there working would
  // be a lie the operator cannot see through. So hiding is named first, and
  // counted, whenever it is what emptied the feed.
  const hiddenCount = hiddenIds.size;
  const empty = (
    <div className="usage-msg mono">
      {!showHidden && hiddenCount > 0
        ? `nothing to show — ${hiddenCount} hidden. reveal them from the bar below.`
        : chip === 'all' ? 'no agents yet — shells and file panes don’t appear here.'
        : chip === 'started' ? 'nothing started — no agent is running or waiting on you.'
        : 'nothing in this state.'}
    </div>
  );

  if (view === 'tiles') {
    const content = sorted ? rankedBlocks() : tileBlocks;
    return (
      <div className="ov-wrap">
        <div className="ov-feed ovt-feed">
          {content.length === 0 && empty}
          {content}
        </div>
        {windowEl}
      </div>
    );
  }

  const blocks: ReactNode[] = sorted ? rankedBlocks() : [];
  if (!sorted) for (const ref of tree.order) {
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
        {blocks.length === 0 && empty}
        {blocks}
      </div>
    </div>
  );
}
