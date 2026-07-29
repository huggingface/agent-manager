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
// list is windowed by measured height and the data is paged from the server, so
// a 6 MB session costs ~30 DOM rows.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { TraceBlock, TracePage, TraceTurn } from '../api';
import { renderMarkdown } from '../lib/markdown';
import Logo from './Logo';
import { CloseGlyph } from './icons';

const PAGE = 200;          // turns per request
const ROW_EST = 44;        // unmeasured row height, collapsed
const OVERSCAN_PX = 600;

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
      <div className="tv-md" dangerouslySetInnerHTML={{ __html: html }} />
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
      out.push(<TextBlock key={i} text={b.text} more={b.more} markdown={turn.role !== 'system'} />);
    }
  }
  return <>{out}</>;
}

function Row({ turn, index }: { turn: TraceTurn; index: number }) {
  const muted = turn.role === 'system' || turn.kind === 'update';
  return (
    <div className={`tv-row ${turn.role}${muted ? ' muted' : ''}`} data-i={index}>
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

export default function TracePane({
  session, focused, zoom = 100, dragId, onDragActive, onFocus, onClose,
}: {
  session: Session;
  focused?: boolean;
  zoom?: number;
  dragId?: string;
  onDragActive?: (dragging: boolean) => void;
  onFocus?: () => void;
  onClose: () => void;
}) {
  const [head, setHead] = useState<Omit<TracePage, 'turns'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const turns = useRef<(TraceTurn | undefined)[]>([]);
  const pending = useRef<Set<number>>(new Set());
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((n) => n + 1), []);

  const scroller = useRef<HTMLDivElement | null>(null);
  const heights = useRef<number[]>([]);
  // Bumped whenever a row is measured: the values live in a ref (so the
  // observer can write them without re-rendering), and this counter is what
  // invalidates the prefix sums.
  const [heightsVersion, setHeightsVersion] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 40 });

  // ---- paging ----
  const loadPage = useCallback(async (pageIndex: number) => {
    if (pending.current.has(pageIndex)) return;
    pending.current.add(pageIndex);
    try {
      const p = await api.getTracePage(session.id, pageIndex * PAGE, PAGE);
      const { turns: got, ...meta } = p;
      if (turns.current.length !== meta.total) {
        turns.current.length = meta.total;
        heights.current.length = meta.total;
      }
      got.forEach((t, i) => { turns.current[meta.offset + i] = t; });
      setHead(meta);
      setError(null);
      bump();
    } catch (e) {
      // The server distinguishes "nothing to show yet" from a real failure and
      // says which — pass its own words through rather than inventing a reason.
      setError(e instanceof api.TraceUnavailable ? e.message : 'could not read the trace');
    } finally {
      pending.current.delete(pageIndex);
    }
  }, [session.id, bump]);

  useEffect(() => {
    turns.current = [];
    heights.current = [];
    setHead(null);
    loadPage(0);
  }, [session.id, loadPage]);

  // ---- windowing ----
  // Prefix sums over measured (or estimated) row heights. n is bounded by the
  // reader's VIEW_MAX_MESSAGES, so a full recompute is cheap and happens only
  // when a row is measured or the window moves.
  const offsets = useMemo(() => {
    const n = turns.current.length;
    const acc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) acc[i + 1] = acc[i] + (heights.current[i] || ROW_EST);
    return acc;
  }, [range, head, heightsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const recompute = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const n = turns.current.length;
    const top = Math.max(0, el.scrollTop - OVERSCAN_PX);
    const bottom = el.scrollTop + el.clientHeight + OVERSCAN_PX;
    // binary search for the first row whose bottom edge is past `top`
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= top) lo = mid + 1; else hi = mid; }
    let end = lo;
    while (end < n && offsets[end] < bottom) end++;
    if (lo !== range.start || end !== range.end) setRange({ start: lo, end: Math.max(end, lo + 1) });

    // fetch whatever page the window needs
    for (let i = lo; i < end; i++) {
      if (!turns.current[i]) loadPage(Math.floor(i / PAGE));
    }
  }, [offsets, range.start, range.end, loadPage]);

  useEffect(() => { recompute(); }, [recompute, head]);

  // Measure rendered rows (heights change when a fold is expanded).
  const rowRefs = useRef(new Map<number, HTMLElement>());
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        const h = e.contentRect.height;
        if (Number.isFinite(i) && Math.abs((heights.current[i] || 0) - h) > 1) { heights.current[i] = h; changed = true; }
      }
      if (changed) setHeightsVersion((v) => v + 1);
    });
    for (const el of rowRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
    // `head` is in here so rows that arrive from a fetch (without the window
    // moving) get measured too — otherwise they keep their 44px estimate and the
    // scroll height stays wrong. NOT heightsVersion: that's what the observer
    // sets, and re-attaching on it would churn on every measurement.
  }, [range, head, bump]);

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
  }, [query, head, range, heightsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = turns.current.length;
  const rows: ReactNode[] = [];
  for (let i = range.start; i < Math.min(range.end, n); i++) {
    const t = turns.current[i];
    rows.push(
      <div key={i} ref={setRowRef(i)} data-i={i}>
        {t ? <Row turn={t} index={i} /> : <div className="tv-row placeholder" style={{ height: ROW_EST }} />}
      </div>,
    );
  }

  const totalTokens = head?.usage ? fmtUsage(head.usage) : '';

  return (
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
        {head && <span className="tv-count">{fmtNum(head.total)} turns</span>}
        {totalTokens && <span className="tv-tokens">{totalTokens}</span>}
        <span className="spacer" />
        <input
          className="tv-search"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
      </div>

      <div
        className="trace-body"
        ref={scroller}
        onScroll={recompute}
        style={{ fontSize: `${(13 * zoom) / 100}px` }}
      >
        {error && <div className="tv-msg">{error}</div>}
        {!error && !head && <div className="tv-msg">reading…</div>}

        {!error && head && matches && (
          <div className="tv-matches">
            <div className="tv-msg">
              {matches.length} match{matches.length === 1 ? '' : 'es'} in the {fmtNum(turns.current.filter(Boolean).length)} turns
              loaded so far{turns.current.filter(Boolean).length < head.total ? ' — scroll to load more' : ''}
            </div>
            {matches.map((i) => <Row key={i} turn={turns.current[i]!} index={i} />)}
          </div>
        )}

        {!error && head && !matches && (
          <>
            <div style={{ height: offsets[range.start] || 0 }} />
            {rows}
            <div style={{ height: Math.max(0, (offsets[n] || 0) - (offsets[Math.min(range.end, n)] || 0)) }} />
            {head.truncated && <div className="tv-msg">session longer than the viewer's cap — earlier turns only</div>}
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
          {head.firstTs ? ` · ${new Date(head.firstTs).toLocaleString()}` : ''}
        </div>
      )}
    </div>
  );
}
