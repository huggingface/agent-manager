import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { FileEntry, FileKind, FilePreview } from '../api';
import Logo from './Logo';
import { renderMarkdown } from '../lib/markdown';
import {
  FolderGlyph, FileGlyph, CloseGlyph, UpGlyph, UploadGlyph, BackGlyph, DownloadGlyph,
  RefreshGlyph, ImageGlyph, CodeGlyph, DocGlyph, GlobeGlyph,
} from './icons';

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

// Compact age for a column only a few characters wide; the exact stamp lives in
// the row's title attribute.
const fmtWhen = (ms: number) => {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  const d = new Date(ms);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : ` ${String(d.getFullYear()).slice(2)}`;
  return `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}${y}`;
};
const fmtStamp = (ms: number) => (ms ? new Date(ms).toLocaleString() : 'unknown');

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
// Resolve a relative reference (from markdown) against a folder.
const joinRel = (dir: string, rel: string) => {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
};
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

type SortKey = 'name' | 'size' | 'time';
type Sort = { key: SortKey; desc: boolean };
const DEFAULT_SORT: Sort = { key: 'name', desc: false };

// Folders always lead, whatever the sort — a listing that interleaves them is
// much harder to scan.
const sortEntries = (es: FileEntry[], s: Sort) => {
  const dir = s.desc ? -1 : 1;
  return [...es].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (s.key === 'size') return (a.size - b.size) * dir || a.name.localeCompare(b.name);
    if (s.key === 'time') return ((a.mtime || 0) - (b.mtime || 0)) * dir || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name) * dir;
  });
};

const triggerDownload = (url: string, name: string) => {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
};

const CODE_RE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|cs|php|pl|lua|r|jl|sh|bash|zsh|fish|ps1|css|scss|less|json|jsonl|ya?ml|toml|ini|sql|graphql|vue|svelte|tf)$/i;

// Kind glyphs, one pen: a listing should read as one set, not a sticker album.
const KindGlyph = ({ name, kind, className }: { name: string; kind?: FileKind; className?: string }) => {
  if (kind === 'image') return <ImageGlyph className={className} />;
  if (kind === 'html') return <GlobeGlyph className={className} />;
  if (kind === 'markdown') return <DocGlyph className={className} />;
  if (kind === 'text') return CODE_RE.test(name) ? <CodeGlyph className={className} /> : <DocGlyph className={className} />;
  return <FileGlyph className={className} />;
};

const KIND_LABEL: Record<FileKind, string> = {
  text: 'text', markdown: 'markdown', html: 'html', image: 'image', pdf: 'pdf', binary: 'binary',
};

// ASCII-tree rails: one cell per ancestor (vertical line if that ancestor has
// more siblings below) plus the elbow cell for this row (├ normally, └ if last).
// `prefix[i]` = "draw a continuation line at ancestor column i".
function Rails({ prefix, isLast }: { prefix: boolean[]; isLast: boolean }) {
  return (
    <span className="rails" aria-hidden>
      {prefix.map((cont, i) => <span key={i} className={`rail${cont ? ' v' : ''}`} />)}
      <span className={`rail elbow${isLast ? ' last' : ''}`} />
    </span>
  );
}
const padFor = (prefix: boolean[]) => ({ paddingLeft: `${(prefix.length + 1) * 1.1}em` });

// One directory listing, fetched once. Used by the pane for the current folder
// and by every expanded FolderNode, so each level is loaded exactly once.
function useDir(sessionId: string, path: string, reloadKey: number) {
  const [state, setState] = useState<{ entries: FileEntry[] | null; err: boolean }>({ entries: null, err: false });
  useEffect(() => {
    let alive = true;
    setState({ entries: null, err: false });
    api.listFiles(sessionId, path)
      .then((r) => { if (alive) setState({ entries: r.entries, err: false }); })
      .catch(() => { if (alive) setState({ entries: null, err: true }); });
    return () => { alive = false; };
  }, [sessionId, path, reloadKey]);
  return state;
}

type RowProps = {
  sessionId: string; prefix: boolean[]; sort: Sort; reloadKey: number;
  onOpen: (p: string) => void; onPreview: (p: string) => void; selected: string | null;
};

// Rows for one already-loaded listing; folders recurse through FolderNode.
function DirRows({ entries, path, sessionId, prefix, sort, reloadKey, onOpen, onPreview, selected }: RowProps & {
  entries: FileEntry[]; path: string;
}) {
  const arr = sortEntries(entries, sort);
  return (
    <>
      {arr.map((e, i) => {
        const isLast = i === arr.length - 1;
        const p = join(path, e.name);
        if (e.dir) {
          return (
            <FolderNode
              key={e.name} sessionId={sessionId} path={p} name={e.name} mtime={e.mtime}
              prefix={prefix} isLast={isLast} sort={sort} reloadKey={reloadKey}
              onOpen={onOpen} onPreview={onPreview} selected={selected}
            />
          );
        }
        const kindNote = e.kind && e.kind !== 'binary' ? `${KIND_LABEL[e.kind]} · ` : '';
        return (
          <div
            key={e.name}
            className={`tree-row file${selected === p ? ' selected' : ''}`}
            style={padFor(prefix)}
            onClick={() => onPreview(p)}
            title={`${e.name} — ${kindNote}${fmtSize(e.size)} · ${fmtStamp(e.mtime)}`}
          >
            <Rails prefix={prefix} isLast={isLast} />
            <KindGlyph name={e.name} kind={e.kind} className="tw-ico" />
            <span className="tw-name">{e.name}</span>
            <span className="tw-size">{fmtSize(e.size)}</span>
            <span className="tw-time">{fmtWhen(e.mtime)}</span>
            <button
              className="tw-act" title="Download"
              onClick={(ev) => { ev.stopPropagation(); triggerDownload(api.downloadUrl(sessionId, p), e.name); }}
            >
              <DownloadGlyph />
            </button>
          </div>
        );
      })}
    </>
  );
}

// Lazily-loaded contents of one expanded directory.
function DirContents({ path, sessionId, prefix, ...rest }: RowProps & { path: string }) {
  const { entries, err } = useDir(sessionId, path, rest.reloadKey);
  if (err) return <div className="tree-msg" style={padFor(prefix)}>can't read folder</div>;
  if (!entries) return <div className="tree-msg" style={padFor(prefix)}>…</div>;
  if (entries.length === 0) return <div className="tree-msg" style={padFor(prefix)}>empty</div>;
  return <DirRows entries={entries} path={path} sessionId={sessionId} prefix={prefix} {...rest} />;
}

// A folder row: single click toggles inline expand, double click opens it as the
// new tree root. A short timer disambiguates the two.
function FolderNode({ path, name, mtime, isLast, ...rest }: RowProps & {
  path: string; name: string; mtime: number; isLast: boolean;
}) {
  const { prefix, onOpen } = rest;
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; setOpen((o) => !o); }, 200);
  };
  const onDoubleClick = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    onOpen(path);
  };
  return (
    <>
      <div
        className="tree-row folder" style={padFor(prefix)} onClick={onClick} onDoubleClick={onDoubleClick}
        title={`${name} — folder · ${fmtStamp(mtime)}\nClick to expand · double-click to open`}
      >
        <Rails prefix={prefix} isLast={isLast} />
        <FolderGlyph className="tw-ico dir" open={open} />
        <span className="tw-name">{name}</span>
        <span className="tw-size" />
        <span className="tw-time">{fmtWhen(mtime)}</span>
        <span className="tw-act" />
      </div>
      {open && <DirContents path={path} {...rest} prefix={[...prefix, !isLast]} />}
    </>
  );
}

// Column header — and the sort control, which is the honest place for it: the
// three things a row shows are the three things you can sort by.
function Cols({ sort, onSort }: { sort: Sort; onSort: (k: SortKey) => void }) {
  const cell = (key: SortKey, label: string, cls: string) => (
    <button
      className={`fc-btn ${cls}${sort.key === key ? ' on' : ''}`}
      onClick={() => onSort(key)} title={`Sort by ${label.toLowerCase()}`}
    >
      {label}<span className="fc-arrow">{sort.key === key ? (sort.desc ? '↓' : '↑') : ''}</span>
    </button>
  );
  return (
    <div className="files-cols">
      {cell('name', 'Name', 'tw-name')}
      {cell('size', 'Size', 'tw-size')}
      {cell('time', 'Modified', 'tw-time')}
      <span className="tw-act" />
    </div>
  );
}

// Rendered markdown shares the document with the app, so its references have to
// be repointed: a relative <img> means a sibling file in the workspace, and a
// relative <a> must not navigate the app away.
function resolveMarkdown(html: string, sessionId: string, filePath: string) {
  const base = dirOf(filePath);
  const host = document.createElement('div');
  host.innerHTML = html; // already sanitized by renderMarkdown
  const external = (u: string) => /^([a-z]+:|\/\/|\/)/i.test(u);
  host.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !external(src)) img.setAttribute('src', api.rawUrl(sessionId, joinRel(base, src)));
  });
  host.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return; // in-page anchors stay in-page
    if (!external(href)) a.setAttribute('href', api.rawUrl(sessionId, joinRel(base, href)));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return host.innerHTML;
}

// Line-numbered plain text. The gutter is sticky so it survives horizontal
// scrolling of a long line.
function TextView({ text }: { text: string }) {
  const gutter = useMemo(
    () => Array.from({ length: text.split('\n').length }, (_, i) => i + 1).join('\n'),
    [text],
  );
  return (
    <div className="fv-code">
      <pre className="fv-gutter" aria-hidden>{gutter}</pre>
      <pre className="fv-text">{text}</pre>
    </div>
  );
}

type ViewInfo = { meta: FilePreview | null; extra: string[] };

// The viewer for one file. Kinds it can't render fall back to an honest
// "download it instead" card rather than an empty box. The view mode (`raw`,
// `scripts`) belongs to the pane, which draws the toggles in its info strip.
function FileView({ sessionId, path, zoom, raw, scripts, onInfo }: {
  sessionId: string; path: string; zoom: number; raw: boolean; scripts: boolean;
  onInfo: (info: ViewInfo) => void;
}) {
  const [meta, setMeta] = useState<FilePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [dims, setDims] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setMeta(null); setErr(null); setSource(null); setDims(null);
    api.previewFile(sessionId, path)
      .then((m) => { if (alive) setMeta(m); })
      .catch((e) => { if (alive) setErr(String(e?.message || e)); });
    return () => { alive = false; };
  }, [sessionId, path]);

  // html source isn't in the preview payload (the iframe reads the bytes
  // itself) — fetch it only if the source view is asked for.
  useEffect(() => {
    if (!raw || meta?.kind !== 'html' || source !== null) return;
    let alive = true;
    fetch(api.rawUrl(sessionId, path)).then((r) => r.text())
      .then((t) => { if (alive) setSource(t.slice(0, 512 * 1024)); })
      .catch(() => { if (alive) setSource('(could not read source)'); });
    return () => { alive = false; };
  }, [raw, meta?.kind, sessionId, path, source]);

  const kind = meta?.kind;
  const md = useMemo(
    () => (kind === 'markdown' && meta?.text != null && !raw
      ? resolveMarkdown(renderMarkdown(meta.text), sessionId, path) : ''),
    [kind, meta?.text, raw, sessionId, path],
  );

  // Facts about the open file are reported up to the pane's info strip, so the
  // viewer body stays one uninterrupted surface.
  const extra = useMemo(() => {
    const out: string[] = [];
    if (meta?.text != null) out.push(`${meta.text.split('\n').length.toLocaleString()} lines`);
    if (dims) out.push(dims);
    if (meta?.truncated) out.push('truncated');
    return out;
  }, [meta?.text, meta?.truncated, dims]);

  useEffect(() => { onInfo({ meta, extra }); }, [meta, extra, onInfo]);

  if (err) return <div className="fv-empty">Could not open this file.<div className="fv-sub">{err}</div></div>;
  if (!meta) return <div className="fv-empty">Loading…</div>;

  const rawSrc = api.rawUrl(sessionId, path);
  const body = () => {
    if (meta.kind === 'markdown') {
      return raw
        ? <TextView text={meta.text ?? ''} />
        : <div className="markdown fv-md" dangerouslySetInnerHTML={{ __html: md }} />;
    }
    if (meta.kind === 'text') return <TextView text={meta.text ?? ''} />;
    if (meta.kind === 'image') {
      return (
        <div className="fv-image">
          <img
            src={rawSrc} alt={meta.name}
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
          />
        </div>
      );
    }
    if (meta.kind === 'html') {
      if (raw) return source === null ? <div className="fv-empty">Loading source…</div> : <TextView text={source} />;
      return (
        <iframe
          // The key forces a fresh frame when the scripts toggle flips: sandbox
          // flags are only applied at load time, so mutating the attribute on a
          // live frame changes nothing.
          key={scripts ? 'scripts' : 'no-scripts'}
          className="fv-frame" src={rawSrc} title={meta.name}
          // Never allow-same-origin: the frame keeps an opaque origin, so a page
          // an agent wrote can't reach this app's API or storage.
          sandbox={scripts ? 'allow-scripts allow-popups allow-forms allow-modals' : ''}
        />
      );
    }
    // PDFs render in the browser's own viewer, which some browsers (and every
    // headless one) simply don't have — so always offer the way out.
    if (meta.kind === 'pdf') {
      return (
        <>
          <iframe className="fv-frame" src={rawSrc} title={meta.name} />
          <div className="fv-foot">
            Nothing shown? <a href={rawSrc} target="_blank" rel="noopener noreferrer">open it in a new tab</a>
          </div>
        </>
      );
    }
    return (
      <div className="fv-empty">
        No preview for this kind of file.
        <div className="fv-sub">{meta.reason || `${fmtSize(meta.size)} · ${meta.mime}`}</div>
        <button className="mini-btn" onClick={() => triggerDownload(api.downloadUrl(sessionId, path), meta.name)}>
          <DownloadGlyph /> Download
        </button>
      </div>
    );
  };

  // Only the code viewer follows the shared zoom; rendered markdown, images and
  // framed pages carry their own typography.
  const code = meta.kind === 'text' || (raw && (meta.kind === 'markdown' || meta.kind === 'html'));
  return (
    <div className="fv-body" style={code ? { fontSize: `${(12.5 * zoom) / 100}px` } : undefined}>
      {body()}
    </div>
  );
}

export default function FilesPane({
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
  const [root, setRoot] = useState('');
  const [rootLabel, setRootLabel] = useState('workspace');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [viewing, setViewing] = useState<string | null>(null);
  const [info, setInfo] = useState<ViewInfo>({ meta: null, extra: [] });
  const [raw, setRaw] = useState(false);          // markdown/html: show the source
  const [scripts, setScripts] = useState(false);  // html: run the page's own JS
  const paneRef = useRef<HTMLDivElement | null>(null);

  const dir = useDir(session.id, root, reloadKey);

  useEffect(() => { api.listFiles(session.id, '').then((r) => setRootLabel(r.root)).catch(() => {}); }, [session.id]);
  // Entering a preview focuses the pane, so Esc walks back out without a
  // window-wide key handler stealing keys from the other panes. Every file opens
  // in its default view — rendered, scripts off.
  useEffect(() => {
    setInfo({ meta: null, extra: [] });
    setRaw(false);
    setScripts(false);
    if (viewing) paneRef.current?.focus({ preventScroll: true });
  }, [viewing]);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    for (const f of Array.from(files)) {
      try { await api.uploadFile(session.id, root, f); } catch { /* skip */ }
    }
    setBusy(false);
    setReloadKey((k) => k + 1);
  };

  const up = () => setRoot(root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '');
  const openDir = (p: string) => { setViewing(null); setRoot(p); };
  const crumbs = ['', ...root.split('/').filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join('/'))];

  // Folder summary: the numbers that used to be nowhere on screen.
  const stats = useMemo(() => {
    const es = dir.entries ?? [];
    const files = es.filter((e) => !e.dir);
    return {
      folders: es.length - files.length,
      files: files.length,
      bytes: files.reduce((n, e) => n + e.size, 0),
      newest: es.reduce((m, e) => Math.max(m, e.mtime || 0), 0),
    };
  }, [dir.entries]);

  const meta = info.meta;
  const name = viewing ? viewing.split('/').pop()! : '';

  return (
    <div
      className={`slot${focused ? ' focused' : ''}`} ref={paneRef} tabIndex={-1}
      onMouseDown={onFocus}
      // Esc anywhere in the pane leaves the preview — the handler sits on the
      // pane, not on the viewer, so it still fires after a click on a toggle in
      // the info strip moved focus out of the body.
      onKeyDown={viewing ? (e) => { if (e.key === 'Escape') { e.preventDefault(); setViewing(null); } } : undefined}
    >
      {/* One compact bar: logo, navigation (or back), actions, close. */}
      <div
        className={`pane-head files-head${dragId ? ' draggable' : ''}`}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
      >
        <Logo cli="files" size={16} tint="#d99a2b" />
        {viewing ? (
          <>
            <button className="mini-btn" title="Back to files (Esc)" onClick={() => setViewing(null)}><BackGlyph /></button>
            <span className="fv-title" title={viewing}>
              <KindGlyph name={name} kind={meta?.kind} className="tw-ico" />
              <span className="fv-name">{name}</span>
            </span>
            <span className="spacer" />
            <button className="mini-btn" title="Download" onClick={() => triggerDownload(api.downloadUrl(session.id, viewing), name)}>
              <DownloadGlyph />
            </button>
          </>
        ) : (
          <>
            <button className="mini-btn" title="Up" disabled={!root} onClick={up}><UpGlyph /></button>
            <div className="crumbs">
              {crumbs.map((c, i) => (
                <span key={c || 'root'}>
                  {i > 0 && <span className="sep">/</span>}
                  <button className="crumb" onClick={() => setRoot(c)}>{i === 0 ? rootLabel : c.split('/').pop()}</button>
                </span>
              ))}
            </div>
            <span className="spacer" />
            <button className="mini-btn" title="Refresh" onClick={() => setReloadKey((k) => k + 1)}><RefreshGlyph /></button>
            <label className="mini-btn upload-btn" title="Upload files">
              <UploadGlyph /> Upload
              <input type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
            </label>
          </>
        )}
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
      </div>

      {/* Info strip: where you are, or what you're looking at. */}
      <div className="files-info">
        {viewing ? (
          <>
            <span className="fi-where">{meta ? KIND_LABEL[meta.kind] : '…'}</span>
            {meta && <span className="fi-stat">{fmtSize(meta.size)}</span>}
            {meta && <span className="fi-stat fi-extra" title={fmtStamp(meta.mtime)}>{fmtWhen(meta.mtime)}</span>}
            {info.extra.map((x) => <span key={x} className="fi-stat fi-extra">{x}</span>)}
            <span className="spacer" />
            {(meta?.kind === 'markdown' || meta?.kind === 'html') && (
              <span className="fv-toggles">
                <span className="seg">
                  <button className={raw ? '' : 'on'} onClick={() => setRaw(false)}>{meta.kind === 'html' ? 'Page' : 'Rendered'}</button>
                  <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>Source</button>
                </span>
                {meta.kind === 'html' && !raw && (
                  <label className="fv-check" title="Workspace HTML is written by agents. Its scripts run in an isolated origin — they can never reach this app.">
                    <input type="checkbox" checked={scripts} onChange={(e) => setScripts(e.target.checked)} /> scripts
                  </label>
                )}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="fi-where" title={root || rootLabel}>{root ? `${rootLabel}/${root}` : rootLabel}</span>
            <span className="spacer" />
            {dir.entries && (
              <>
                <span className="fi-stat">{stats.folders} folder{stats.folders === 1 ? '' : 's'}</span>
                <span className="fi-stat">{stats.files} file{stats.files === 1 ? '' : 's'}</span>
                <span className="fi-stat fi-extra">{fmtSize(stats.bytes)}</span>
                <span className="fi-stat fi-extra" title={fmtStamp(stats.newest)}>updated {fmtWhen(stats.newest)}</span>
              </>
            )}
          </>
        )}
      </div>

      {/* The tree stays mounted while a preview is open, so going back lands on
          the same expanded folders and the same scroll position. */}
      <div className="files-stack" hidden={!!viewing} style={{ fontSize: `${(13 * zoom) / 100}px` }}>
        <Cols
          sort={sort}
          onSort={(k) => setSort((s) => (s.key === k ? { key: k, desc: !s.desc } : { key: k, desc: k !== 'name' }))}
        />
        <div
          className={`files-body tree${dragOver ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
        >
          {dir.err && <div className="tree-msg">can't read folder</div>}
          {!dir.err && !dir.entries && <div className="tree-msg">…</div>}
          {dir.entries?.length === 0 && <div className="tree-msg">empty</div>}
          {dir.entries && dir.entries.length > 0 && (
            <DirRows
              entries={dir.entries} path={root} sessionId={session.id} prefix={[]} sort={sort}
              reloadKey={reloadKey} onOpen={openDir} onPreview={setViewing} selected={viewing}
            />
          )}
          {busy && <div className="tree-msg">Uploading…</div>}
        </div>
      </div>

      {viewing && (
        <div className="files-view">
          <FileView sessionId={session.id} path={viewing} zoom={zoom} raw={raw} scripts={scripts} onInfo={setInfo} />
        </div>
      )}

      <div className="files-hint">
        {viewing
          ? 'Esc goes back to the files'
          : 'Click a file to preview · click a folder to expand · double-click a folder to open it'}
      </div>
    </div>
  );
}
