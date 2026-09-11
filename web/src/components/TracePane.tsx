// web/src/components/TracePane.tsx
//
// Read-only view of one agent session. Modelled on FilesPane (passive, plain
// fetch through api.ts, no state library) and on the Hub's trace viewer
// (moon-landing server/views/components/TraceViewer/) for the *rendering*
// model: role rows, a model chip, `491↓ 520↑ (1,408 cached)` token counts,
// collapsed thinking with a one-line preview, and consecutive tool calls
// folded into one `3 tool calls (Bash, Read)` summary.
//
// Where we deliberately differ from the Hub viewer: it renders an ever-growing
// window of the whole array (INITIAL 50 + 50 per sentinel hit) and holds every
// message in the DOM, which is exactly why it dies on a 2.13 MB row. Here the
// list is windowed by measured height and the data is read from the END of the
// transcript one byte-window at a time, so a 19 MB session costs one 95 KB
// request and ~30 DOM rows to open.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { TraceBlock, TraceTurn } from '../api';
import { useTraceWindows, type TraceHeadInfo, type TraceSource } from '../lib/traceWindows';
import { renderMarkdown } from '../lib/markdown';
import FileLinkContent, { FileLinkScope } from './FileLinkContent';
import Logo from './Logo';
import { CloseGlyph, ShareGlyph, HandoverGlyph } from './icons';

const ROW_EST = 44;        // unmeasured row height, collapsed
const OVERSCAN_PX = 600;
const NEAR_TOP_PX = 400;   // start fetching older turns before the reader arrives
const STICK_PX = 24;       // "at the bottom" tolerance for following a live trace

const fmtTs = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : '');
const fmtNum = (n: number) => n.toLocaleString();

// Same convention as the Hub viewer's formatTokenUsage.
function fmtUsage(u?: { in: number; out: number; cacheRead?: number }) {
  if (!u) return '';
  const parts = [`${fmtNum(u.in)}↓`, `${fmtNum(u.out)}↑`];
  if (u.cacheRead) parts.push(`(${fmtNum(u.cacheRead)} cached)`);
  return parts.join(' ');
}

const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
// Harness context blobs announce themselves: <app-context>, <recommended_plugins>,
// <environment_context>. Use that as the fold label so a collapsed row still says
// what it is.
const sysLabel = (text: string) => {
  const tag = text.trimStart().match(/^<([a-zA-Z][\w -]{1,40})>/);
  return tag ? tag[1].trim() : 'harness context';
};
const moreLabel = (more?: number) => (more ? ` +${more > 1024 ? `${Math.round(more / 1024)} KB` : `${more} chars`} not retained` : '');

// ---------- blocks ----------

function Collapsible({ label, preview, children, tone }: {
  label: string; preview?: string; tone?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false); // spec §8: everything collapsed by default
  return (
    <div className={`tv-fold${open ? ' open' : ''}${tone ? ` ${tone}` : ''}`}>
      <button className="tv-fold-head" onClick={() => setOpen((o) => !o)}>
        <span className="tv-caret">{open ? '▾' : '▸'}</span>
        <span className="tv-fold-label">{label}</span>
        {!open && preview && <span className="tv-fold-preview">{preview}</span>}
      </button>
      {open && <div className="tv-fold-body">{children}</div>}
    </div>
  );
}

function TextBlock({ text, more, markdown }: { text: string; more?: number; markdown: boolean }) {
  const html = useMemo(() => (markdown ? renderMarkdown(text) : ''), [markdown, text]);
  if (!markdown) return <pre className="tv-pre">{text}{more ? `\n…${moreLabel(more)}` : ''}</pre>;
  // Rendered markdown must still admit what it doesn't have — a silently
  // truncated answer reads as a complete one.
  return (
    <>
      <FileLinkContent className="tv-md" html={html} />
      {!!more && <div className="tv-msg">…{moreLabel(more)}</div>}
    </>
  );
}

// A run of tool calls (each optionally followed by its result) collapses into
// one row — the stitcher on the server guarantees a result sits next to its own
// call even when parallel tools finish out of order.
function ToolGroup({ blocks }: { blocks: TraceBlock[] }) {
  const names: string[] = [];
  let calls = 0;
  for (const b of blocks) {
    if (b.type === 'tool_use') { calls++; if (!names.includes(b.name)) names.push(b.name); }
  }
  const failed = blocks.some((b) => b.type === 'tool_result' && b.failed);
  const label = `${calls} tool call${calls === 1 ? '' : 's'} (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})`;
  return (
    <Collapsible label={label} tone={failed ? 'failed' : undefined} preview={oneLine(firstArgs(blocks))}>
      {blocks.map((b, i) =>
        b.type === 'tool_use' ? (
          <div key={i} className="tv-tool">
            <div className="tv-tool-name">{b.name}</div>
            <pre className="tv-pre small">{b.text}{moreLabel(b.more)}</pre>
          </div>
        ) : b.type === 'tool_result' ? (
          <div key={i} className={`tv-tool-res${b.failed ? ' failed' : ''}`}>
            <pre className="tv-pre small">{b.text}{moreLabel(b.more)}</pre>
          </div>
        ) : null,
      )}
    </Collapsible>
  );
}
const firstArgs = (blocks: TraceBlock[]) => {
  const first = blocks.find((b) => b.type === 'tool_use') as Extract<TraceBlock, { type: 'tool_use' }> | undefined;
  return first ? first.text : '';
};

function Blocks({ turn }: { turn: TraceTurn }) {
  const out: ReactNode[] = [];
  const bs = turn.blocks;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.type === 'tool_use') {
      // swallow the whole consecutive run of calls + results
      let j = i;
      const run: TraceBlock[] = [];
      while (j < bs.length && (bs[j].type === 'tool_use' || bs[j].type === 'tool_result')) run.push(bs[j++]);
      out.push(<ToolGroup key={i} blocks={run} />);
      i = j - 1;
      continue;
    }
    if (b.type === 'tool_result') {
      out.push(<Collapsible key={i} label="tool result" tone={b.failed ? 'failed' : undefined} preview={oneLine(b.text)}>
        <pre className="tv-pre small">{b.text}{moreLabel(b.more)}</pre>
      </Collapsible>);
    } else if (b.type === 'thinking') {
      out.push(<Collapsible key={i} label="Thinking" tone="think" preview={oneLine(b.text)}>
        <TextBlock text={b.text} more={b.more} markdown={false} />
      </Collapsible>);
    } else if (b.type === 'compaction') {
      out.push(<Collapsible key={i} label="Context compacted" tone="think" preview={oneLine(b.text)}>
        <TextBlock text={b.text} more={undefined} markdown={false} />
      </Collapsible>);
    } else if (b.type === 'shell') {
      out.push(<Collapsible key={i} label={`$ ${oneLine(b.command, 60)}`} preview={oneLine(b.stdout || b.stderr || '')}>
        <pre className="tv-pre small">{b.stdout}{b.stderr}</pre>
      </Collapsible>);
    } else if (b.type === 'image') {
      out.push(<img key={i} className="tv-img" src={b.src} alt="" />);
    } else if (b.type === 'text') {
      // System rows are the harness talking to the model — instructions, skills,
      // environment. One of them here is 27 KB, so expanded they bury the
      // conversation before it starts. Collapsed, and never as markdown.
      if (turn.role === 'system') {
        out.push(
          <Collapsible key={i} label={sysLabel(b.text)} preview={oneLine(b.text)}>
            <TextBlock text={b.text} more={b.more} markdown={false} />
          </Collapsible>,
        );
      } else {
        out.push(<TextBlock key={i} text={b.text} more={b.more} markdown />);
      }
    }
  }
  return <>{out}</>;
}

function Row({ turn, index }: { turn: TraceTurn; index: number }) {
  const muted = turn.role === 'system' || turn.kind === 'update';
  return (
    <div className={`tv-row ${turn.role}${turn.kind ? ` ${turn.kind}` : ''}${muted ? ' muted' : ''}`} data-i={index}>
      <div className="tv-meta">
        <span className={`tv-badge ${turn.role}`}>{turn.role}</span>
        {turn.model && <span className="tv-chip">{turn.model}</span>}
        {turn.usage && <span className="tv-tokens">{fmtUsage(turn.usage)}</span>}
        <span className="tv-spacer" />
        <span className="tv-ts">{fmtTs(turn.ts)}</span>
      </div>
      <div className="tv-body"><Blocks turn={turn} /></div>
    </div>
  );
}

// ---------- the pane ----------

// The viewer itself: windows, measurement, search, prompt jumps. It takes a
// source rather than a session, so the same reader serves the Trace pane and a
// transcript opened in the Files pane. Its chrome lives in whichever pane hosts
// it — `onHead` hands up what the toolbar needs to say, `onNav` hands up the
// prompt jump for the host's buttons.
//
// It opens on the END of the conversation. A transcript here reaches tens of MB
// and thousands of turns, and the exchange a reader wants first is always the
// last one — so the first request is a single window of the tail, and older
// turns arrive one window at a time as you scroll back into them. The only read
// that touches the whole trace is the summary, which buys the header an honest
// turn count and is asked for after the first paint.
// The source and the head shape now live with the paging itself, so reader mode
// can use the same ones — see lib/traceWindows.ts.
export type { TraceSource, TraceHeadInfo } from '../lib/traceWindows';

export function TraceView({ src, srcKey, zoom = 100, query = '', live, onHead, onNav }: {
  src: TraceSource;
  /** Changing this resets the loaded turns — a different session or file. */
  srcKey: string;
  zoom?: number;
  query?: string;
  /** The agent behind this trace is running. `false` means it is not, and a
   *  trace that has also been quiet is then not polled at all. */
  live?: boolean;
  onHead?: (head: TraceHeadInfo | null) => void;
  onNav?: (go: (dir: -1 | 1) => void) => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const heights = useRef<number[]>([]);
  // Bumped whenever a row is measured: the values live in a ref (so the
  // observer can write them without re-rendering), and this counter is what
  // invalidates the prefix sums.
  const [heightsVersion, setHeightsVersion] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 40 });

  // Follow the newest turn while the agent writes — but only while the reader is
  // already down there. Scrolling up to read something is a decision.
  const stick = useRef(true);
  // What must not move across a re-layout: the row at the top of the viewport,
  // and how far into it we are. Prepending older turns changes every offset in
  // the list, and a row that measures itself after it renders changes the ones
  // above the viewport — without an anchor, the paragraph under the reader's
  // eyes jumps away mid-sentence.
  //
  // `top` is that row's real position in the scroller, and it is what the
  // restore uses when the row is still rendered: the estimated-height model is
  // only ever approximately right, and on rows far taller than ROW_EST (a codex
  // rollout's tool groups) restoring from it left the text a few hundred pixels
  // off. `delta` is the model-based fallback for a row that has scrolled out of
  // the rendered window and has no geometry to read.
  const anchor = useRef<{ i: number; delta: number; top: number | null } | null>(null);
  // React keys for the rows. Indices move every time older turns are prepended,
  // and a key that moves unmounts and remounts the row — which throws away every
  // fold the reader had opened (`Collapsible` holds `open` in state) and every
  // memoized markdown body, at exactly the moment they were reading a tool call
  // and scrolled up for the context that produced it. Keys are therefore
  // `keyBase + index`, with the base decremented by each prepend, so a given
  // turn keeps the same key for the life of the pane.
  const keyBase = useRef(0);
  // False until the turns we hold have been MEASURED and the scroller put where
  // it belongs. Until then `scrollTop` says nothing about where the reader is:
  // before the first layout it is 0 because nothing has been placed, and before
  // the first measurement the whole list is 44 px per row, so a window of 19
  // dense turns looks 800 px tall when it is really 3,600 — near enough to the
  // top to fetch a window of older turns nobody asked for.
  const positioned = useRef(false);
  const measured = useRef(false);
  const wanted = useRef<number | null>(null);
  const tries = useRef(0);
  // Rendered rows, by index — the ResizeObserver measures through these, and the
  // anchor reads its geometry from them.
  const rowRefs = useRef(new Map<number, HTMLElement>());

  /** First row whose bottom edge is past `top`. */
  const rowAt = (acc: Float64Array, top: number) => {
    let lo = 0;
    let hi = Math.max(0, acc.length - 1);
    while (lo < hi) { const mid = (lo + hi) >> 1; if (acc[mid + 1] <= top) lo = mid + 1; else hi = mid; }
    return lo;
  };

  /**
   * Remember the row at the top of the viewport so the layout effect can put it
   * back there. `shift` is how far this row is about to move down the list
   * (the number of turns being prepended). Returns false when there is nothing
   * to anchor to yet.
   */
  const captureAnchor = (shift: number) => {
    const el = scroller.current;
    if (!el || !turns.current.length) return false;
    const i = rowAt(offsetsRef.current, el.scrollTop);
    const node = rowRefs.current.get(i);
    anchor.current = {
      i: i + shift,
      delta: el.scrollTop - (offsetsRef.current[i] || 0),
      top: node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
    };
    return true;
  };

  // Everything that names a row BY INDEX moves with a prepend: the keys, a
  // pending jump, and the anchor (which captureAnchor is given the shift for).
  const onPrepend = useCallback((count: number) => {
    // Everything that names a row BY INDEX moves with the prepend: the heights,
    // the keys, the rendered window, and a pending jump. (The anchor is given
    // the shift by captureAnchor rather than moved afterwards — shifting it
    // twice throws the view a whole window forward.)
    heights.current = [...new Array(count), ...heights.current];
    keyBase.current -= count;
    if (wanted.current != null) wanted.current += count;
    if (captureAnchor(count)) stick.current = false;
    setRange((r) => ({ start: r.start + count, end: r.end + count }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onAppend = useCallback((count: number) => {
    heights.current = [...heights.current, ...new Array(count)];
  }, []);

  const onReset = useCallback(() => {
    heights.current = [];
    anchor.current = null;
    stick.current = true;
    positioned.current = false;
    measured.current = false;
    setRange({ start: 0, end: 40 });
  }, []);

  const { turns, head, error, phase, reload, version: tick, atStart, blocked, loadOlder } =
    useTraceWindows(src, srcKey, { onPrepend, onAppend, onReset, live });

  // Prefix sums over measured (or estimated) row heights. n is bounded by what
  // the reader has actually loaded, so a full recompute is cheap and happens
  // only when a row is measured, turns arrive, or the window moves.
  const offsets = useMemo(() => {
    const n = turns.current.length;
    const acc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) acc[i + 1] = acc[i] + (heights.current[i] || ROW_EST);
    return acc;
  }, [range, tick, heightsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // The loaders need the offsets as they are NOW, not as they were when the
  // callback was made.
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;


  const recompute = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const n = turns.current.length;
    const top = Math.max(0, el.scrollTop - OVERSCAN_PX);
    const bottom = el.scrollTop + el.clientHeight + OVERSCAN_PX;
    const lo = rowAt(offsets, top);
    let end = lo;
    while (end < n && offsets[end] < bottom) end++;
    if (lo !== range.start || end !== range.end) setRange({ start: lo, end: Math.max(end, lo + 1) });
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    // Reading back into the trace: fetch the stretch in front of what we hold,
    // before the reader arrives at it. Also covers a tail window too short to
    // fill the pane — there is no scrolling to do, so nothing else would ask.
    // Not while a jump is settling: goPrompt does its own fetching, and letting
    // this fire too turned one ▲ into several windows.
    if (positioned.current && wanted.current == null && el.scrollTop < NEAR_TOP_PX) loadOlder();
  }, [offsets, range.start, range.end, loadOlder]);

  useEffect(() => { recompute(); }, [recompute, head]);

  // ---- keeping the view still ----
  // Every layout change lands here: a jump to a prompt, a prepended window, a
  // row that just measured itself, a new turn while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Landing exactly on a row is a two-step problem: offsets are estimates
    // until a row has been measured, so the first scroll is approximate and the
    // real position is known only once the target has rendered. Re-apply it as
    // heights settle, giving up after a few passes so a row that keeps resizing
    // can't hold the scroll position hostage.
    if (wanted.current != null) {
      const target = offsets[wanted.current] || 0;
      if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = target;
      // An anchor captured on the way here describes a position the jump is
      // deliberately leaving; keeping it would re-apply it a layout pass later.
      anchor.current = null;
      if (++tries.current > 8) wanted.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
      anchor.current = null;
    } else if (anchor.current) {
      const a = anchor.current;
      const node = rowRefs.current.get(a.i);
      if (node && a.top != null) {
        // Where that row actually is now, against where it was: exact, and free
        // of whatever the height model still gets wrong about rows it has never
        // measured.
        const now = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += now - a.top;
      } else {
        el.scrollTop = (offsets[a.i] || 0) + a.delta;
      }
      anchor.current = null;
    }
    // The turns we hold are measured, on screen, and the view is where it should
    // be: `scrollTop` now means what the reader is doing.
    if (measured.current && (offsets[turns.current.length] || 0) > 0) positioned.current = true;
  }, [offsets]);

  const firstVisible = useCallback(() => {
    const el = scroller.current;
    if (!el || !turns.current.length) return 0;
    return rowAt(offsets, el.scrollTop + 1);
  }, [offsets]);

  const goToTurn = useCallback((i: number) => {
    const el = scroller.current;
    if (!el) return;
    wanted.current = i;
    tries.current = 0;
    stick.current = false;
    el.scrollTop = offsets[i] || 0;
    recompute();
  }, [offsets, recompute]);

  // ---- jump between prompts ----
  // The operator's own turns, among those loaded. Reaching past the oldest one
  // loads the window in front of it rather than pretending there are no more.
  const prompts = useMemo(() => {
    const out: number[] = [];
    turns.current.forEach((t, i) => { if (t.role === 'user') out.push(i); });
    return out;
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const goRef = useRef<(dir: -1 | 1) => void>(() => {});
  const goPrompt = async (dir: -1 | 1) => {
    const cur = firstVisible();
    const next = dir < 0 ? prompts.filter((i) => i < cur).pop() : prompts.find((i) => i > cur);
    if (next !== undefined) { goToTurn(next); return; }
    if (dir > 0) {
      // Past the last prompt, the end of the conversation is the destination.
      const el = scroller.current;
      if (el) { wanted.current = null; stick.current = true; el.scrollTop = el.scrollHeight; }
      return;
    }
    // Let the prepend commit before looking again: the recursion would
    // otherwise read the pre-prepend prompt list and fetch another window.
    if (!atStart && await loadOlder()) {
      await new Promise((r) => window.setTimeout(r, 0));
      goRef.current(dir);
      return;
    }
    if (prompts.length) goToTurn(prompts[0]);
  };
  goRef.current = goPrompt;

  // Measure rendered rows (heights change when a fold is expanded).
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        const h = e.contentRect.height;
        if (Number.isFinite(i) && Math.abs((heights.current[i] || 0) - h) > 1) { heights.current[i] = h; changed = true; }
      }
      if (!changed) return;
      measured.current = true;
      // Measuring changes the offsets of everything below — and of everything
      // above, if a row above the viewport grew. Pin the row being read.
      // Not if an anchor is already waiting: a prepend captured that one against
      // the indices it is about to shift, and a measurement landing in between
      // would overwrite it with the OLD indexing — restoring to a row a whole
      // window away from the one the reader was looking at.
      if (!stick.current && wanted.current == null && !anchor.current) captureAnchor(0);
      setHeightsVersion((v) => v + 1);
    });
    for (const el of rowRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
    // `tick` is in here so rows that arrive from a fetch (without the window
    // moving) get measured too — otherwise they keep their 44px estimate and the
    // scroll height stays wrong. NOT heightsVersion: that's what the observer
    // sets, and re-attaching on it would churn on every measurement.
  }, [range, tick, head]);

  const setRowRef = (i: number) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i);
  };

  // ---- search: filters the turns already fetched, and says so ----
  const matches = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    const hits: number[] = [];
    turns.current.forEach((t, i) => {
      if (t && t.blocks.some((b) => JSON.stringify(b).toLowerCase().includes(q))) hits.push(i);
    });
    return hits.slice(0, 200);
  }, [query, tick, heightsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = turns.current.length;
  const rows: ReactNode[] = [];
  for (let i = range.start; i < Math.min(range.end, n); i++) {
    rows.push(
      <div key={keyBase.current + i} ref={setRowRef(i)} data-i={i}>
        <Row turn={turns.current[i]} index={i} />
      </div>,
    );
  }

  // Hand the host what its toolbar needs. goPrompt is rebuilt every render, so
  // the host gets a stable wrapper around the current one.
  // What the pane knows about the trace: whatever this window could tell us,
  // filled in from the summary for everything a window cannot know. That is not
  // only the counts — a window of a codex rollout cannot count the session's
  // encrypted reasoning steps (`note`), and a window of an STS file never sees
  // the `{type:'session'}` first line that carries the title, the harness and
  // the session id. Taking only the numbers left a reader with no idea the
  // model's reasoning had been withheld, which is the one thing §12 of the spec
  // says must never be left implied.
  useEffect(() => { onNav?.((d: -1 | 1) => goRef.current(d)); }, [onNav]);
  useEffect(() => { onHead?.(head); }, [head, onHead]);

  return (
    <>
      <div
        className="trace-body"
        ref={scroller}
        onScroll={recompute}
        // Any deliberate scroll abandons a pending jump, so a row measuring
        // itself a moment later can't yank the view back.
        onWheel={() => { wanted.current = null; }}
        onTouchStart={() => { wanted.current = null; }}
        style={{ fontSize: `${(13 * zoom) / 100}px` }}
      >
        {error && <div className="tv-msg" role="status">{error} <button onClick={() => void reload()}>Retry</button></div>}
        {!error && !head && <div className="tv-msg">{phase === 'empty' ? 'No transcript yet.' : 'reading…'}</div>}

        {head && matches && (
          <div className="tv-matches">
            <div className="tv-msg">
              {matches.length} match{matches.length === 1 ? '' : 'es'} in the {fmtNum(n)} turns
              loaded so far{atStart ? '' : ' — scroll up to load more'}
            </div>
            {matches.map((i) => <Row key={keyBase.current + i} turn={turns.current[i]} index={i} />)}
          </div>
        )}

        {head && !matches && (
          <>
            {/* Fixed height whether it is loading, done, or at the beginning:
                this line sits above every offset in the list, so changing its
                size would move the whole conversation under the reader. */}
            <div className="tv-msg tv-top">
              {blocked
                ? 'earlier turns can’t be read — one line here is larger than the reader’s window'
                : atStart
                  ? 'beginning of the conversation'
                  : 'earlier turns load as you scroll up…'}
            </div>
            {/* State the gaps up front: a reader who can't see the model's
                reasoning should know it was withheld, not that there was none. */}
            {head?.note && <div className="tv-msg">{head.note}</div>}
            <div style={{ height: offsets[range.start] || 0 }} />
            {rows}
            <div style={{ height: Math.max(0, (offsets[n] || 0) - (offsets[Math.min(range.end, n)] || 0)) }} />
          </>
        )}
      </div>

      {head && (head.source || head.cwd) && (
        <div className="trace-hint">
          {head.source?.repo && (
            <>
              {head.sharedBy ? `shared by ${head.sharedBy} · ` : ''}
              <a href={head.source.url || `https://huggingface.co/datasets/${head.source.repo}`} target="_blank" rel="noreferrer">{head.source.repo}</a>
              {' · '}
            </>
          )}
          {head.cwd}
          {head?.firstTs ? ` · ${new Date(head.firstTs).toLocaleString()}` : ''}
        </div>
      )}
    </>
  );
}

export default function TracePane({
  session, focused, zoom = 100, dragId, sourceLive, onDragActive, onFocus, onShare, onHandover, onClose,
}: {
  session: Session;
  focused?: boolean;
  /** Is the session this trace came from still running? */
  sourceLive?: boolean;
  zoom?: number;
  dragId?: string;
  onDragActive?: (dragging: boolean) => void;
  onFocus?: () => void;
  /** Publish this trace, and continue from it in a new agent. Both used to be
   *  buttons on the sidebar row; they belong to the trace, so they live on the
   *  pane that shows it. (The reader's `i` panel is ConversationView's, and a
   *  trace pane does not use ConversationView.) */
  onShare?: () => void;
  onHandover?: () => void;
  onClose: () => void;
}) {
  const [head, setHead] = useState<TraceHeadInfo | null>(null);
  const [query, setQuery] = useState('');
  const nav = useRef<((dir: -1 | 1) => void) | null>(null);
  const onNav = useCallback((go: (dir: -1 | 1) => void) => { nav.current = go; }, []);
  const src = useMemo<TraceSource>(() => ({
    window: (req, bytes, min, signal) => api.getTraceWindow(session.id, req, bytes, min, signal),
    summary: (signal) => api.getTraceSummary(session.id, signal),
  }), [session.id]);

  const prompts = head?.userTurns?.length ?? 0;
  const totalTokens = head?.usage ? fmtUsage(head.usage) : '';
  // Until the summary lands, the honest count is what the reader is holding.
  const count = head && (head.total != null
    ? `${fmtNum(head.total)} turns`
    : `${fmtNum(head.loaded)} turn${head.loaded === 1 ? '' : 's'} loaded`);

  return (
    <FileLinkScope session={session.id}>
    <div className={`slot${focused ? ' focused' : ''}`} onMouseDown={onFocus}>
      <div
        className={`pane-head trace-head${dragId ? ' draggable' : ''}`}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
      >
        <Logo cli="trace" size={16} tint="#7c8cf8" />
        {/* A received trace is identified by what it IS, not by which CLI wrote
            it — so the session's own name leads, with the harness as a chip. */}
        <span className="tv-title" title={head?.title || undefined}>{head?.title || head?.harnessLabel || 'trace'}</span>
        {head?.title && head.harnessLabel && <span className="tv-chip">{head.harnessLabel}</span>}
        {head?.model && <span className="tv-chip">{head.model}</span>}
        {count && <span className="tv-count" title={head && head.total != null && head.loaded < head.total ? `${fmtNum(head.loaded)} loaded — scroll up for the rest` : undefined}>{count}</span>}
        {totalTokens && <span className="tv-tokens">{totalTokens}</span>}
        <span className="spacer" />
        {/* Prompt-to-prompt navigation: an agent turn can run for dozens of rows,
            and what you usually want is the next thing YOU said. Walking back
            past the oldest prompt loaded pulls in the window before it. */}
        <span className="tv-nav">
          <button className="mini-btn" disabled={!head} onClick={() => nav.current?.(-1)}
            title={prompts ? `Previous prompt (${prompts} in this session)` : 'Previous prompt'}>▲</button>
          <button className="mini-btn" disabled={!head} onClick={() => nav.current?.(1)}
            title={prompts ? `Next prompt (${prompts} in this session)` : 'Next prompt'}>▼</button>
        </span>
        <input
          className="tv-search"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {onShare && (
          <button className="mini-btn" title="Share this trace"
            onClick={(e) => { e.stopPropagation(); onShare(); }}><ShareGlyph /></button>
        )}
        {onHandover && (
          <button className="mini-btn" title="Continue from this trace in a new agent"
            onClick={(e) => { e.stopPropagation(); onHandover(); }}><HandoverGlyph /></button>
        )}
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
      </div>

      <TraceView src={src} srcKey={`session:${session.id}`} zoom={zoom} query={query} live={sourceLive} onHead={setHead} onNav={onNav} />
    </div>
    </FileLinkScope>
  );
}
