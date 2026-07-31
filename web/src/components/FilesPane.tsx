import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { FileEntry, FileKind, FilePreview } from '../api';
import Logo from './Logo';
import { renderMarkdown } from '../lib/markdown';
import CodeView from './CodeView';
import PdfView from './PdfView';
import { TraceView, type TraceSource } from './TracePane';
import {
  FolderGlyph, FileGlyph, CloseGlyph, UpGlyph, UploadGlyph, BackGlyph, DownloadGlyph,
  RefreshGlyph, ImageGlyph, CodeGlyph, DocGlyph, GlobeGlyph,
  FolderPlusGlyph, FilePlusGlyph, TrashGlyph,
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

// A sort sorts the listing — folders included. No type grouping in any column:
// asking for name order and getting two alphabetical runs, one of folders and
// one of files, means finding a name still takes two passes over the pane.
//
// Name also breaks every tie, following the sort direction, so a column full of
// equal values still visibly reverses — folders share an mtime when a tree
// arrives in one checkout, and have no size at all.
const sortEntries = (es: FileEntry[], s: Sort) => {
  const dir = s.desc ? -1 : 1;
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name) * dir;
  return [...es].sort((a, b) => {
    if (s.key === 'size') return (a.size - b.size) * dir || byName(a, b);
    if (s.key === 'time') return ((a.mtime || 0) - (b.mtime || 0)) * dir || byName(a, b);
    return byName(a, b);
  });
};

const triggerDownload = (url: string, name: string) => {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
};

// How long typing has to pause before the file is written back.
const AUTOSAVE_MS = 800;

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
  trace: 'trace',
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
  onDelete: (path: string, name: string, dir: boolean) => void;
};

// Deleting asks in the row itself rather than in a browser dialog: the question
// names what is about to go, and for a folder it says that its contents go with
// it, because none of this is undoable.
function ConfirmDelete({ name, dir, busy, onYes, onNo }: {
  name: string; dir: boolean; busy: boolean; onYes: () => void; onNo: () => void;
}) {
  return (
    <span className="tw-confirm" onClick={(e) => e.stopPropagation()}>
      <span className="tw-warn">
        {dir ? `Delete "${name}" and everything in it?` : `Delete "${name}"?`}
      </span>
      <button className="mini-btn danger" disabled={busy} onClick={onYes}>{busy ? 'Deleting…' : 'Delete'}</button>
      <button className="mini-btn" disabled={busy} onClick={onNo}>Cancel</button>
    </span>
  );
}

// Rows for one already-loaded listing; folders recurse through FolderNode.
function DirRows({ entries, path, sessionId, prefix, sort, reloadKey, onOpen, onPreview, selected, onDelete }: RowProps & {
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
              onOpen={onOpen} onPreview={onPreview} selected={selected} onDelete={onDelete}
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
            <span className="tw-acts">
              <button
                className="tw-act" title="Download"
                onClick={(ev) => { ev.stopPropagation(); triggerDownload(api.downloadUrl(sessionId, p), e.name); }}
              >
                <DownloadGlyph />
              </button>
              <button
                className="tw-act danger" title={`Delete ${e.name}`}
                onClick={(ev) => { ev.stopPropagation(); onDelete(p, e.name, false); }}
              >
                <TrashGlyph />
              </button>
            </span>
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
  const { prefix, onOpen, onDelete } = rest;
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
        <span className="tw-acts">
          <button
            className="tw-act danger" title={`Delete ${name}`}
            onClick={(ev) => { ev.stopPropagation(); onDelete(path, name, true); }}
          >
            <TrashGlyph />
          </button>
        </span>
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
      {/* the row-actions column, reserved so the headings sit over their values */}
      <span className="tw-acts" />
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

// Which theme the app is in — CodeMirror needs to know, since its own chrome
// (selection, active line) is drawn from it rather than from our stylesheet.
function useTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

type ViewInfo = { meta: FilePreview | null; extra: string[]; edit?: SaveState; trace?: TraceInfo };

// What a rendered trace needs from the pane's info strip: the same chips and
// prompt navigation the Trace pane puts in its own header.
export type TraceInfo = {
  harnessLabel?: string;
  model?: string | null;
  turns?: number;
  prompts: number;
  query: string;
  setQuery: (q: string) => void;
  go: (dir: -1 | 1) => void;
};

// Text files are simply editable — there is no edit mode to enter and no Save
// button to find, so all the chrome needs is a quiet word about where the
// autosave got to, and the two choices a conflict genuinely requires.
export type SaveState = {
  /** Editable at all: a text kind we hold WHOLE (not a truncated head). */
  can: boolean;
  why?: string;                                   // why not, when it can't
  status: 'clean' | 'typing' | 'saving' | 'saved' | 'error';
  error: string | null;
  /** A concurrent writer won the race; the two ways out. */
  conflict: boolean;
  reload: () => void;
  overwrite: () => void;
};

// The viewer for one file. Kinds it can't render fall back to an honest
// "download it instead" card rather than an empty box. The view mode (`raw`,
// `scripts`) belongs to the pane, which draws the toggles in its info strip.
function FileView({ sessionId, path, zoom, raw, scripts, onInfo, onSaved }: {
  sessionId: string; path: string; zoom: number; raw: boolean; scripts: boolean;
  onInfo: (info: ViewInfo) => void;
  onSaved?: () => void;
}) {
  const [meta, setMeta] = useState<FilePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [dims, setDims] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [traceHead, setTraceHead] = useState<{ harnessLabel?: string; model?: string | null; total?: number; userTurns?: number[] } | null>(null);
  const [traceQuery, setTraceQuery] = useState('');
  const traceNav = useRef<((dir: -1 | 1) => void) | null>(null);
  const theme = useTheme();

  // Editing state. `draft` is null until the first keystroke: the editor is
  // always writable, but a file nobody touched has nothing to save.
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveState['status']>('clean');
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // The autosave timer, and the values it must read at fire time rather than at
  // schedule time (mtime moves with every save).
  const timer = useRef<number | null>(null);
  const pending = useRef<{ text: string; mtime: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setMeta(null); setErr(null); setSource(null); setDims(null); setPages(null);
    setDraft(null); setSaveErr(null); setConflict(false); setStatus('clean');
    setTraceHead(null); setTraceQuery('');
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

  // The text currently on screen: the draft while editing, the file otherwise.
  // html keeps its source in `source` (the preview payload has no text for it).
  const shown = draft ?? (meta?.kind === 'html' ? (source ?? '') : (meta?.text ?? ''));

  // Facts about the open file are reported up to the pane's info strip, so the
  // viewer body stays one uninterrupted surface.
  const extra = useMemo(() => {
    const out: string[] = [];
    // A rendered trace is measured in turns, not lines: the line count and the
    // read cap describe the JSONL under it, so they belong to the Source view.
    const rendering = meta?.kind === 'trace' && !raw;
    if (shown && !rendering) out.push(`${shown.split('\n').length.toLocaleString()} lines`);
    if (dims) out.push(dims);
    if (pages) out.push(`${pages} page${pages === 1 ? '' : 's'}`);
    if (meta?.truncated && !rendering) out.push('truncated');
    return out;
  }, [shown, meta?.truncated, meta?.kind, raw, dims, pages]);

  // Editable = a text-ish kind we hold in FULL. A truncated head must never be
  // writable: saving it back would drop everything past the 512 KB cap.
  // Traces are excluded on purpose: they are the live record a harness resumes
  // from, and an autosaving editor one stray keystroke away from it is a bad
  // trade for a file nobody needs to hand-edit.
  const editKind = !!meta && (meta.kind === 'text' || meta.kind === 'markdown' || meta.kind === 'html');
  const canEdit = editKind && !meta?.truncated;
  const saved = meta?.kind === 'html' ? (source ?? '') : (meta?.text ?? '');

  // Read at fire time by a callback that outlives the render that made it.
  const kindRef = useRef(meta?.kind);
  kindRef.current = meta?.kind;

  // One writer for every save — the debounce, the flush on close, and ⌘S all
  // come through here. `force` drops the mtime precondition, which is what
  // "overwrite" means after a conflict.
  const flush = useCallback(async (force = false) => {
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setStatus('saving'); setSaveErr(null);
    try {
      const after = await api.writeFile(sessionId, path, job.text, force ? 0 : job.mtime);
      setConflict(false);
      setMeta((m) => (m ? { ...m, text: m.kind === 'html' ? m.text : job.text, size: after.size, mtime: after.mtime } : m));
      if (kindRef.current === 'html') setSource(job.text);
      setStatus('saved');
      onSaved?.();
    } catch (e: any) {
      const msg = String(e?.message || e);
      // A refused save must NOT drop the text — put it back so the next attempt
      // (or an overwrite) still has it.
      pending.current = job;
      setConflict(/changed on disk/.test(msg));
      setSaveErr(msg);
      setStatus('error');
    }
  }, [sessionId, path, onSaved]);

  // Every keystroke restarts a short timer: agents read these files, and this
  // one writes to a FUSE-mounted bucket, so a save per character is out.
  const onEdit = useCallback((next: string) => {
    setDraft(next);
    if (!canEdit || !meta) return;
    pending.current = { text: next, mtime: meta.mtime };
    setStatus('typing');
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(), AUTOSAVE_MS);
  }, [canEdit, meta, flush]);

  // Closing the file, or switching to another, must not lose the last keystroke:
  // fetch outlives the component, so firing it from cleanup is enough.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) flushRef.current();
  }, [path]);

  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('clean'), 1800);
    return () => clearTimeout(t);
  }, [status]);

  const edit = useMemo<SaveState>(() => ({
    can: canEdit,
    // Only worth saying when editing was plausible and isn't: nobody expects to
    // type into a PDF, so an image or a binary says nothing at all.
    why: editKind && meta?.truncated ? 'too big to edit — only the first part is loaded' : undefined,
    status,
    error: saveErr,
    conflict,
    reload: () => {
      pending.current = null;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setDraft(null); setSaveErr(null); setConflict(false); setStatus('clean');
    setTraceHead(null); setTraceQuery('');
      setMeta(null);
      api.previewFile(sessionId, path).then(setMeta).catch(() => {});
      if (kindRef.current === 'html') {
        fetch(api.rawUrl(sessionId, path)).then((r) => r.text()).then(setSource).catch(() => {});
      }
    },
    overwrite: () => flush(true),
  }), [canEdit, editKind, meta?.truncated, status, saveErr, conflict, flush, sessionId, path]);

  const traceInfo = useMemo<TraceInfo | undefined>(() => (meta?.kind === 'trace' && !raw ? {
    harnessLabel: traceHead?.harnessLabel,
    model: traceHead?.model,
    turns: traceHead?.total,
    prompts: traceHead?.userTurns?.length || 0,
    query: traceQuery,
    setQuery: setTraceQuery,
    go: (d: -1 | 1) => traceNav.current?.(d),
  } : undefined), [meta?.kind, raw, traceHead, traceQuery]);

  const traceSrc = useCallback<TraceSource>(
    (offset, limit) => api.getFileTracePage(sessionId, path, offset, limit), [sessionId, path]);

  useEffect(() => { onInfo({ meta, extra, edit, trace: traceInfo }); }, [meta, extra, edit, traceInfo, onInfo]);

  if (err) return <div className="fv-empty">Could not open this file.<div className="fv-sub">{err}</div></div>;
  if (!meta) return <div className="fv-empty">Loading…</div>;

  const rawSrc = api.rawUrl(sessionId, path);
  const code = (text: string) => (
    <CodeView
      text={text} name={meta.name} theme={theme}
      editable={canEdit}
      onChange={onEdit}
      onSave={() => flush()}   // ⌘S still works; it just beats the timer
    />
  );
  const body = () => {
    if (meta.kind === 'markdown') {
      // Rendered stays the default view for markdown — Source is the editable
      // face of the same file, one toggle away.
      return raw
        ? code(shown)
        : <div className="markdown fv-md" dangerouslySetInnerHTML={{ __html: md }} />;
    }
    if (meta.kind === 'trace') {
      // Same two faces as markdown: the rendered conversation, or the JSONL
      // underneath it.
      return raw ? code(shown) : (
        <TraceView
          src={traceSrc} srcKey={`${sessionId}:${path}`} zoom={zoom} query={traceQuery}
          onHead={setTraceHead} onNav={(go) => { traceNav.current = go; }}
        />
      );
    }
    if (meta.kind === 'text') return code(shown);
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
      if (raw) {
        return source === null ? <div className="fv-empty">Loading source…</div> : code(shown);
      }
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
    // Painted page by page with pdf.js rather than handed to the browser's own
    // viewer: /raw is sandboxed without allow-same-origin, and Chrome won't run
    // its PDF viewer on a sandboxed resource — in a frame OR in its own tab. See
    // PdfView.
    if (meta.kind === 'pdf') return <PdfView src={rawSrc} onPages={setPages} />;
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
  const isCode = meta.kind === 'text'
    || (raw && (meta.kind === 'markdown' || meta.kind === 'html' || meta.kind === 'trace'));
  // A capped read is a partial answer, so say so where the text ends rather than
  // only as a chip in the strip — and offer the whole file in the same breath.
  const headOnly = !!meta.truncated && (isCode || meta.kind === 'markdown');
  return (
    <div className="fv-body" style={isCode ? { fontSize: `${(12.5 * zoom) / 100}px` } : undefined}>
      {body()}
      {headOnly && (
        <div className="fv-foot">
          Showing the first {fmtSize((shown || '').length)} of {fmtSize(meta.size)}.{' '}
          <button className="link-btn" onClick={() => triggerDownload(api.downloadUrl(sessionId, path), meta.name)}>
            Download the whole file
          </button>
        </div>
      )}
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
  const [confirmClose, setConfirmClose] = useState(false); // leaving with unsaved edits
  const [creating, setCreating] = useState<null | 'folder' | 'file'>(null);
  const [newName, setNewName] = useState('');
  const [pendingDel, setPendingDel] = useState<null | { path: string; name: string; dir: boolean }>(null);
  const [acting, setActing] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
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
    setConfirmClose(false);
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

  // Leaving is unconditional now — the last keystroke is flushed on the way out
  // (see FileView). The exception is an unresolved conflict, where leaving WOULD
  // drop work: that asks once.
  const edit = info.edit;
  const leaveView = () => {
    if (edit?.conflict && !confirmClose) { setConfirmClose(true); return; }
    setConfirmClose(false);
    setViewing(null);
  };
  useEffect(() => { if (!edit?.conflict) setConfirmClose(false); }, [edit?.conflict]);

  // Create lands in the folder you are looking at, which is the one the
  // breadcrumb names.
  const create = async () => {
    const name = newName.trim();
    if (!name || !creating) return;
    setActing(true); setActErr(null);
    try {
      await (creating === 'folder' ? api.createFolder : api.createFile)(session.id, root, name);
      setCreating(null); setNewName('');
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setActErr(String(e?.message || e));
    } finally {
      setActing(false);
    }
  };

  const doDelete = async () => {
    if (!pendingDel) return;
    setActing(true); setActErr(null);
    try {
      await api.deleteEntry(session.id, pendingDel.path);
      // If the open file was the one deleted, leave the viewer rather than
      // showing a preview of something that no longer exists.
      if (viewing && (viewing === pendingDel.path || viewing.startsWith(`${pendingDel.path}/`))) setViewing(null);
      setPendingDel(null);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setActErr(String(e?.message || e));
    } finally {
      setActing(false);
    }
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
      onKeyDown={viewing ? (e) => {
        if (e.key === 'Escape') { e.preventDefault(); leaveView(); }
        // Cmd/Ctrl-S works from anywhere in the pane, not just inside the editor.
        // ⌘S is a no-op that people press anyway: swallow it so the browser's
        // save dialog never appears over an editor that already saved.
        else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && edit?.can) {
          e.preventDefault();
        }
      } : undefined}
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
            <button className="mini-btn" title="Back to files (Esc)" onClick={leaveView}><BackGlyph /></button>
            <span className="fv-title" title={viewing}>
              <KindGlyph name={name} kind={meta?.kind} className="tw-ico" />
              <span className="fv-name">{name}</span>
              {(edit?.status === 'typing' || edit?.status === 'saving') && (
                <span className="fv-dirty" title="Saving…">•</span>
              )}
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
            <button
              className="mini-btn" title="New folder here"
              onClick={() => { setCreating('folder'); setNewName(''); setActErr(null); }}
            ><FolderPlusGlyph /></button>
            <button
              className="mini-btn" title="New empty file here"
              onClick={() => { setCreating('file'); setNewName(''); setActErr(null); }}
            ><FilePlusGlyph /></button>
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
            {edit?.conflict ? (
              // The one moment that still needs a decision: someone else wrote
              // the file while this buffer was open.
              <span className="fv-conflict">
                <span className="fi-err">changed on disk</span>
                <button className="mini-btn" onClick={edit.reload} title="Throw away my edits and load the file as it is now">Reload</button>
                <button className="mini-btn" onClick={edit.overwrite} title="Save my version over theirs">Overwrite</button>
              </span>
            ) : edit?.error ? (
              <span className="fi-err" title={edit.error}>{edit.error}</span>
            ) : edit?.can && edit.status !== 'clean' ? (
              <span className={`fv-save ${edit.status}`}>
                {edit.status === 'saving' ? 'saving…' : edit.status === 'saved' ? 'saved' : 'editing…'}
              </span>
            ) : null}
            {edit && !edit.can && edit.why && (
              <span className="fi-stat fi-extra" title={edit.why}>read-only</span>
            )}
            {info.trace && (
              // The Trace pane keeps these in its own header; here they join the
              // strip, so a transcript in the Files pane still has the chips,
              // prompt jumps and search that make a long one navigable.
              <span className="fv-trace-tools">
                {info.trace.harnessLabel && <span className="tv-chip">{info.trace.harnessLabel}</span>}
                {info.trace.model && <span className="tv-chip">{info.trace.model}</span>}
                {info.trace.turns != null && <span className="fi-stat">{info.trace.turns.toLocaleString()} turns</span>}
                <span className="tv-nav">
                  <button className="mini-btn" disabled={!info.trace.prompts} onClick={() => info.trace!.go(-1)}
                    title={info.trace.prompts ? `Previous prompt (${info.trace.prompts})` : 'No prompts in this trace'}>▲</button>
                  <button className="mini-btn" disabled={!info.trace.prompts} onClick={() => info.trace!.go(1)}
                    title={info.trace.prompts ? `Next prompt (${info.trace.prompts})` : 'No prompts in this trace'}>▼</button>
                </span>
                <input
                  className="tv-search fi-extra" placeholder="Search…"
                  value={info.trace.query} onChange={(e) => info.trace!.setQuery(e.target.value)}
                />
              </span>
            )}
            {(meta?.kind === 'markdown' || meta?.kind === 'html' || meta?.kind === 'trace') && (
              <span className="fv-toggles">
                <span className="seg">
                  <button className={raw ? '' : 'on'} onClick={() => setRaw(false)}>
                    {meta.kind === 'html' ? 'Page' : meta.kind === 'trace' ? 'Trace' : 'Rendered'}
                  </button>
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
        {creating && (
          <div className="files-new">
            {creating === 'folder' ? <FolderPlusGlyph className="tw-ico" /> : <FilePlusGlyph className="tw-ico" />}
            <input
              autoFocus className="files-new-input"
              placeholder={creating === 'folder' ? 'New folder name' : 'New file name'}
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setActErr(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); create(); }
                if (e.key === 'Escape') { e.preventDefault(); setCreating(null); setActErr(null); }
              }}
            />
            <button className="mini-btn primary" disabled={!newName.trim() || acting} onClick={create}>Create</button>
            <button className="mini-btn" disabled={acting} onClick={() => { setCreating(null); setActErr(null); }}>Cancel</button>
          </div>
        )}
        {pendingDel && (
          <div className="files-new danger-row">
            <TrashGlyph className="tw-ico" />
            <ConfirmDelete
              name={pendingDel.name} dir={pendingDel.dir} busy={acting}
              onYes={doDelete} onNo={() => { setPendingDel(null); setActErr(null); }}
            />
          </div>
        )}
        {actErr && <div className="files-new err">{actErr}</div>}
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
              onDelete={(p, name, isDir) => { setCreating(null); setActErr(null); setPendingDel({ path: p, name, dir: isDir }); }}
            />
          )}
          {busy && <div className="tree-msg">Uploading…</div>}
        </div>
      </div>

      {viewing && (
        <div className="files-view">
          <FileView
            sessionId={session.id} path={viewing} zoom={zoom} raw={raw} scripts={scripts}
            onInfo={setInfo} onSaved={() => setReloadKey((k) => k + 1)}
          />
        </div>
      )}

      <div className="files-hint">
        {!viewing
          ? 'Click a file to preview · click a folder to expand · double-click a folder to open it'
          : confirmClose
            ? 'This file changed on disk — Reload or Overwrite, or Esc again to leave your edits behind'
            : edit?.can
              ? 'Type to edit — saved automatically · Esc goes back'
              : 'Esc goes back to the files'}
      </div>
    </div>
  );
}
