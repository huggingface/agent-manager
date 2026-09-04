import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recall, remember, readWrap, writeWrap } from './filesMemory';
import type { Session } from '../types';
import * as api from '../api';
import { Rails, railPad } from './Rails';
import type { FileEntry, FileKind, FilePreview } from '../api';
import Logo from './Logo';
import { renderMarkdown } from '../lib/markdown';
import FileLinkContent, { FileLinkScope } from './FileLinkContent';
import { fileRequest, fileResourceUrl } from '../lib/fileLinks';
import CodeView from './CodeView';
import FileWrapToggle from './FileWrapToggle';
import PdfView from './PdfView';
import { TraceView, type TraceHeadInfo, type TraceSource } from './TracePane';
import {
  FolderGlyph, FileGlyph, CloseGlyph, UpGlyph, UploadGlyph, BackGlyph, DownloadGlyph,
  RefreshGlyph, ImageGlyph, CodeGlyph, DocGlyph, GlobeGlyph,
  FolderPlusGlyph, FilePlusGlyph, TrashGlyph, PencilGlyph, MoveGlyph,
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

// The rails live in components/Rails.tsx: the reader's sub-agent strip draws the
// same tree, and one copy of six lines is better than two that drift.
const padFor = railPad;

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
  onRename: (path: string, name: string) => void;
  renaming: string | null;
  setRenaming: (path: string | null) => void;
  /** Drag-and-drop, and the tap-friendly version of the same move. */
  onMove: (from: string, toDir: string) => void;
  moving: Moving | null;
  setMoving: (m: Moving | null) => void;
  /** The folder new entries and uploads land in. */
  target: string;
  setTarget: (dir: string) => void;
};

export interface Moving { path: string; name: string; dir: boolean }

// A move that would change nothing, or eat itself: back into the folder it is
// already in, or a folder into its own subtree.
const canMoveTo = (m: Moving, destDir: string) =>
  dirOf(m.path) !== destDir && destDir !== m.path && !destDir.startsWith(`${m.path}/`);

// Renaming happens in the row, on the name itself: the thing being renamed stays
// where it is, under the cursor, instead of jumping to a dialog. Enter commits,
// Esc abandons, and a blur commits too — leaving the field is an answer.
function RenameInput({ init, onCommit, onCancel }: {
  init: string; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(init);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;            // blur fires again after Enter
    done.current = true;
    const name = v.trim();
    if (commit && name && name !== init) onCommit(name); else onCancel();
  };
  return (
    <input
      className="tw-rename" autoFocus value={v}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => {
        // Select the stem, not the extension: renaming rarely means retyping .txt.
        const dot = init.lastIndexOf('.');
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : init.length);
      }}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel(); }
      }}
      onBlur={() => finish(true)}
    />
  );
}

// Leaving a file with an unsaved buffer is the one moment that deserves to
// interrupt: a hint at the foot of the pane is not a warning, and the cost of
// missing it is the work you just did. Small, centred on the pane, and every
// answer is one click — including doing nothing.
function UnsavedDialog({ name, conflict, busy, onSave, onDiscard, onCancel }: {
  name: string; conflict: boolean; busy: boolean;
  onSave: () => void; onDiscard: () => void; onCancel: () => void;
}) {
  return (
    <div
      className="fv-modal-back"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="fv-modal" role="dialog" aria-modal="true" aria-label="Unsaved changes"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }   // Esc backs out, never discards
          if (e.key === 'Enter') { e.preventDefault(); onSave(); }
        }}
      >
        <div className="fv-modal-title">Unsaved changes in {name}</div>
        <div className="fv-modal-body">
          {conflict
            ? 'This file also changed on disk since you opened it. Saving replaces what is there now.'
            : 'Your edits have not been written to the file.'}
        </div>
        <div className="fv-modal-acts">
          <button className="mini-btn" onClick={onCancel}>Keep editing</button>
          <button className="mini-btn danger" onClick={onDiscard} disabled={busy}>Discard</button>
          <button className="mini-btn primary" autoFocus onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : conflict ? 'Overwrite and close' : 'Save and close'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
function DirRows({ entries, path, sessionId, prefix, sort, reloadKey, onOpen, onPreview, selected, onDelete, onRename, renaming, setRenaming, onMove, moving, setMoving, target, setTarget }: RowProps & {
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
              onRename={onRename} renaming={renaming} setRenaming={setRenaming}
              onMove={onMove} moving={moving} setMoving={setMoving} target={target} setTarget={setTarget}
            />
          );
        }
        const kindNote = e.kind && e.kind !== 'binary' ? `${KIND_LABEL[e.kind]} · ` : '';
        return (
          <div
            key={e.name}
            className={`tree-row file${selected === p ? ' selected' : ''}${moving?.path === p ? ' moving' : ''}`}
            style={padFor(prefix)}
            draggable={renaming !== p}
            onDragStart={(ev) => {
              ev.dataTransfer.setData('text/plain', p);
              ev.dataTransfer.effectAllowed = 'move';
              setMoving({ path: p, name: e.name, dir: false });
            }}
            onDragEnd={() => setMoving(null)}
            onClick={() => onPreview(p)}
            title={`${e.name} — ${kindNote}${fmtSize(e.size)} · ${fmtStamp(e.mtime)}`}
          >
            <Rails prefix={prefix} isLast={isLast} />
            <KindGlyph name={e.name} kind={e.kind} className="tw-ico" />
            {renaming === p ? (
              <RenameInput
                init={e.name}
                onCommit={(name) => onRename(p, name)}
                onCancel={() => setRenaming(null)}
              />
            ) : <span className="tw-name">{e.name}</span>}
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
                className="tw-act" title={`Rename ${e.name}`}
                onClick={(ev) => { ev.stopPropagation(); setRenaming(p); }}
              >
                <PencilGlyph />
              </button>
              <button
                className="tw-act" title={`Move ${e.name} — then pick a folder`}
                onClick={(ev) => { ev.stopPropagation(); setMoving({ path: p, name: e.name, dir: false }); }}
              >
                <MoveGlyph />
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
  const { prefix, onOpen, onDelete, onRename, renaming, setRenaming, onMove, moving, setMoving, target, setTarget } = rest;
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const takes = !!moving && canMoveTo(moving, path);   // would a drop here do anything?
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = () => {
    if (renaming === path) return;   // the row is an input right now
    if (moving) {                    // a move is armed: this row is the answer
      if (canMoveTo(moving, path)) onMove(moving.path, path);
      else setMoving(null);
      return;
    }
    setTarget(path);                 // new folders, new files and uploads land here
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
        className={`tree-row folder${target === path ? ' target' : ''}${over && takes ? ' drop' : ''}${moving?.path === path ? ' moving' : ''}`}
        style={padFor(prefix)}
        draggable={renaming !== path}
        onDragStart={(ev) => {
          ev.dataTransfer.setData('text/plain', path);
          ev.dataTransfer.effectAllowed = 'move';
          setMoving({ path, name, dir: true });
        }}
        onDragEnd={() => { setMoving(null); setOver(false); }}
        onDragOver={(ev) => { if (takes) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(ev) => {
          setOver(false);
          if (!takes || !moving) return;
          ev.preventDefault(); ev.stopPropagation();
          onMove(moving.path, path);
        }}
        onClick={onClick} onDoubleClick={onDoubleClick}
        title={`${name} — folder · ${fmtStamp(mtime)}\nClick to expand · double-click to open`}
      >
        <Rails prefix={prefix} isLast={isLast} />
        <FolderGlyph className="tw-ico dir" open={open} />
        {renaming === path ? (
          <RenameInput
            init={name}
            onCommit={(next) => onRename(path, next)}
            onCancel={() => setRenaming(null)}
          />
        ) : <span className="tw-name">{name}</span>}
        <span className="tw-size" />
        <span className="tw-time">{fmtWhen(mtime)}</span>
        <span className="tw-acts">
          {/* no download for a folder — hold its slot so Rename, Move and Delete
              sit in the same place on every row */}
          <span className="tw-act ghost" aria-hidden />
          <button
            className="tw-act" title={`Rename ${name}`}
            onClick={(ev) => { ev.stopPropagation(); setRenaming(path); }}
          >
            <PencilGlyph />
          </button>
          <button
            className="tw-act" title={`Move ${name} — then pick a folder`}
            onClick={(ev) => { ev.stopPropagation(); setMoving({ path, name, dir: true }); }}
          >
            <MoveGlyph />
          </button>
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
function resolveMarkdown(html: string, sessionId: string, filePath: string, source?: LinkedFileSource) {
  const base = dirOf(filePath);
  const host = document.createElement('div');
  host.innerHTML = html; // already sanitized by renderMarkdown
  const external = (u: string) => /^([a-z]+:|\/\/|\/)/i.test(u);
  host.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && (!external(src) || src.startsWith('/') && !src.startsWith('//'))) {
      const request = fileRequest(src, { session: source ? undefined : sessionId, root: source?.root, base });
      if (request) img.setAttribute('src', fileResourceUrl('raw', request));
    }
  });
  host.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return; // in-page anchors stay in-page
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

export type ViewInfo = {
  meta: FilePreview | null; extra: string[]; edit?: SaveState; trace?: TraceInfo;
  /** True when a text surface is on screen, so wrapping means something. */
  showWrap?: boolean;
};

// What a rendered trace needs from the pane's info strip: the same chips and
// prompt navigation the Trace pane puts in its own header.
export type TraceInfo = {
  harnessLabel?: string;
  model?: string | null;
  /** whole-trace turn count once the summary lands, else what is loaded */
  turns?: number;
  /** true while `turns` is only what the reader holds so far */
  partial?: boolean;
  prompts: number;
  /** the reader has something on screen — the jump buttons mean something */
  ready: boolean;
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
  status: 'clean' | 'dirty' | 'saving' | 'saved' | 'error';
  /** Write the buffer. Enabled only while there is something to write. */
  save: () => void;
  /** Write it and report whether it landed — for "save and close". */
  saveNow: (force?: boolean) => Promise<boolean>;
  /** Throw the buffer away and go back to what is on disk. */
  discard: () => void;
  error: string | null;
  /** A concurrent writer won the race; the two ways out. */
  conflict: boolean;
  reload: () => void;
  overwrite: () => void;
  /** Soft-wrap long lines — a reading preference, sticky across files. */
  wrap: boolean;
  setWrap: (on: boolean) => void;
  /** Re-indent JSON in the buffer. Absent unless the open file is JSON. */
  prettify?: () => void;
  /** Why the last Prettify didn't happen. Not a save failure — nothing is dirty. */
  prettifyError?: string | null;
};

// The viewer for one file. Kinds it can't render fall back to an honest
// "download it instead" card rather than an empty box. The view mode (`raw`,
// `scripts`) belongs to the pane, which draws the toggles in its info strip.
export type LinkedFileSource = {
  root: string;
  preview: () => Promise<FilePreview>;
  rawUrl: string;
  downloadUrl: string;
};

export function FileView({ sessionId, path, zoom, raw, scripts, onInfo, onSaved, source: linkedSource, line, column }: {
  sessionId: string; path: string; zoom: number; raw: boolean; scripts: boolean;
  onInfo: (info: ViewInfo) => void;
  onSaved?: () => void;
  /** Shared file links are read-only and never adopt a Files pane's draft. */
  source?: LinkedFileSource;
  line?: number;
  column?: number;
}) {
  const readOnly = !!linkedSource;
  const rawSrc = linkedSource?.rawUrl ?? api.rawUrl(sessionId, path);
  const downloadSrc = linkedSource?.downloadUrl ?? api.downloadUrl(sessionId, path);
  const [meta, setMeta] = useState<FilePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [dims, setDims] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [traceHead, setTraceHead] = useState<TraceHeadInfo | null>(null);
  const [traceQuery, setTraceQuery] = useState('');
  const traceNav = useRef<((dir: -1 | 1) => void) | null>(null);
  const theme = useTheme();

  // Editing state. `draft` is null until the first keystroke: the editor is
  // always writable, but a file nobody touched has nothing to save.
  const [wrap, setWrapPref] = useState(readWrap);
  const [draft, setDraft] = useState<string | null>(() => {
    const kept = readOnly ? null : recall(sessionId).draft;
    return kept && kept.path === path ? kept.text : null;
  });
  const [status, setStatus] = useState<SaveState['status']>(() => {
    const kept = readOnly ? null : recall(sessionId).draft;
    return kept && kept.path === path ? 'dirty' : 'clean';
  });
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // The buffer waiting to be written, if any. There is no timer: these files
  // have no undo and no git behind them, so nothing reaches disk until it is
  // asked for.
  const pending = useRef<{ text: string; base: string | null } | null>(null);
  // Adopt a kept buffer ONCE per file. Re-checking on every render resurrected
  // it mid-save — ⌘S fires two handlers (the editor's keymap and the pane's), the
  // first cleared `pending` and the render in between put it back with the tag it
  // had before the write, so the second handler saved a stale base and the file
  // reported itself changed on disk one moment after being saved.
  const restoredFor = useRef<string | null>(null);
  if (restoredFor.current !== path) {
    restoredFor.current = path;
    const kept = readOnly ? null : recall(sessionId).draft;
    pending.current = kept && kept.path === path ? { text: kept.text, base: kept.base } : null;
  }

  useEffect(() => {
    let alive = true;
    setMeta(null); setErr(null); setSource(null); setDims(null); setPages(null);
    setSaveErr(null); setConflict(false); setFmtErr(null);
    // A buffer kept across a pane switch survives the reload of its own file —
    // dropping it here is exactly the loss this is meant to prevent.
    const kept = readOnly ? null : recall(sessionId).draft;
    if (kept && kept.path === path) { setDraft(kept.text); setStatus('dirty'); }
    else { setDraft(null); setStatus('clean'); }
    setTraceHead(null); setTraceQuery('');
    (linkedSource ? linkedSource.preview() : api.previewFile(sessionId, path))
      .then((m) => { if (alive) setMeta(m); })
      .catch((e) => { if (alive) setErr(String(e?.message || e)); });
    return () => { alive = false; };
  }, [sessionId, path, linkedSource, readOnly]);

  // html source isn't in the preview payload (the iframe reads the bytes
  // itself) — fetch it only if the source view is asked for.
  useEffect(() => {
    if (!raw || meta?.kind !== 'html' || source !== null) return;
    let alive = true;
    fetch(rawSrc).then((r) => r.text())
      .then((t) => { if (alive) setSource(t.slice(0, 512 * 1024)); })
      .catch(() => { if (alive) setSource('(could not read source)'); });
    return () => { alive = false; };
  }, [raw, meta?.kind, rawSrc, source]);

  const kind = meta?.kind;
  const md = useMemo(
    () => (kind === 'markdown' && meta?.text != null && !raw
      ? resolveMarkdown(renderMarkdown(meta.text), sessionId, path, linkedSource) : ''),
    [kind, meta?.text, raw, sessionId, path, linkedSource],
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
  const canEdit = !readOnly && editKind && !meta?.truncated;
  const saved = meta?.kind === 'html' ? (source ?? '') : (meta?.text ?? '');

  // Read at fire time by a callback that outlives the render that made it.
  const kindRef = useRef(meta?.kind);
  kindRef.current = meta?.kind;

  // One writer for every save — the debounce, the flush on close, and ⌘S all
  // come through here. `force` drops the mtime precondition, which is what
  // "overwrite" means after a conflict.
  // Resolves true when the file on disk matches the buffer — which "save and
  // close" needs, so a failed write keeps the dialog up instead of closing over
  // the error.
  const inflight = useRef<Promise<boolean> | null>(null);
  const flush = useCallback((force = false): Promise<boolean> => {
    // One write at a time. Two callers land on the same save rather than racing
    // each other into a conflict of their own making.
    if (inflight.current) return inflight.current;
    const job = pending.current;
    if (!job) return Promise.resolve(true);   // nothing outstanding
    pending.current = null;
    setStatus('saving'); setSaveErr(null);
    const run = async (): Promise<boolean> => {
    try {
      const after = await api.writeFile(sessionId, path, job.text, force ? null : job.base);
      setConflict(false);
      setMeta((m) => (m ? { ...m, text: m.kind === 'html' ? m.text : job.text, size: after.size, mtime: after.mtime, tag: after.tag } : m));
      remember(sessionId, { draft: null });
      if (kindRef.current === 'html') setSource(job.text);
      setStatus('saved');
      onSaved?.();
      return true;
    } catch (e: any) {
      const msg = String(e?.message || e);
      // A refused save must NOT drop the text — put it back so the next attempt
      // (or an overwrite) still has it.
      pending.current = job;
      setConflict(/changed on disk/.test(msg));
      setSaveErr(msg);
      setStatus('error');
      return false;
    }
    };
    const p = run().finally(() => { inflight.current = null; });
    inflight.current = p;
    return p;
  }, [sessionId, path, onSaved]);

  // Typing only fills the buffer. Writing it is a decision, taken with the Save
  // button or ⌘S — an autosave here would be one stray keystroke away from
  // silently rewriting a file with no undo behind it.
  const onEdit = useCallback((next: string) => {
    setDraft(next);
    if (!canEdit || !meta) return;
    const base = meta.tag ?? null;
    pending.current = { text: next, base };
    // Held outside the component so switching this tile to another session — or
    // reloading the app — doesn't take the buffer with it.
    remember(sessionId, { draft: { path, text: next, base } });
    setStatus((st) => (st === 'error' ? st : 'dirty'));   // keep a failure visible
  }, [canEdit, meta, sessionId, path]);

  // Switching files abandons an unsaved buffer, so the pane asks before it lets
  // that happen (see leaveView).
  useEffect(() => () => { pending.current = null; }, [path]);

  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('clean'), 1800);
    return () => clearTimeout(t);
  }, [status]);

  // JSON arrives from agents as one enormous line more often than not, which is
  // unreadable either way: wrap turns it into a paragraph, Prettify gives it
  // structure. Both are offered; neither writes anything on its own.
  const isJson = /\.json$/i.test(meta?.name || '');
  // Kept apart from saveErr on purpose: "this isn't valid JSON" is a complaint
  // about a button press, not an unsaved buffer, and must not make the file look
  // dirty or stand in the way of closing it.
  const [fmtErr, setFmtErr] = useState<string | null>(null);
  const prettify = useCallback(() => {
    const src = draft ?? saved;
    try {
      const next = `${JSON.stringify(JSON.parse(src), null, 2)}\n`;
      if (next !== src) onEdit(next);
      setFmtErr(null);
    } catch (e: any) {
      // Say where it broke — "Expected double-quoted property name at position
      // 15" is the useful half of this feature when a file is half-written.
      setFmtErr(`not valid JSON — ${String(e?.message || e).replace(/^JSON\.parse: /, '')}`);
    }
  }, [draft, saved, onEdit]);

  const edit = useMemo<SaveState>(() => ({
    can: canEdit,
    save: () => flush(),
    saveNow: (force = false) => flush(force),
    discard: () => {
      pending.current = null;
      remember(sessionId, { draft: null });
      setDraft(null); setSaveErr(null); setStatus('clean');
    },
    // Only worth saying when editing was plausible and isn't: nobody expects to
    // type into a PDF, so an image or a binary says nothing at all.
    why: editKind && meta?.truncated ? 'too big to edit — only the first part is loaded' : undefined,
    status,
    error: saveErr,
    conflict,
    reload: () => {
      pending.current = null;
      remember(sessionId, { draft: null });
      setDraft(null); setSaveErr(null); setConflict(false); setStatus('clean');
      setTraceHead(null); setTraceQuery('');
      setMeta(null);
      api.previewFile(sessionId, path).then(setMeta).catch(() => {});
      if (kindRef.current === 'html') {
        fetch(api.rawUrl(sessionId, path)).then((r) => r.text()).then(setSource).catch(() => {});
      }
    },
    overwrite: () => flush(true),
    wrap,
    setWrap: (on: boolean) => { setWrapPref(on); writeWrap(on); },
    prettify: isJson && canEdit ? prettify : undefined,
    prettifyError: fmtErr,
  }), [canEdit, editKind, meta?.truncated, status, saveErr, conflict, flush, sessionId, path,
       wrap, isJson, prettify, fmtErr]);

  const traceInfo = useMemo<TraceInfo | undefined>(() => (meta?.kind === 'trace' && !raw ? {
    harnessLabel: traceHead?.harnessLabel,
    model: traceHead?.model,
    turns: traceHead ? (traceHead.total ?? traceHead.loaded) : undefined,
    partial: !!traceHead && traceHead.total == null,
    prompts: traceHead?.userTurns?.length || 0,
    ready: !!traceHead,
    query: traceQuery,
    setQuery: setTraceQuery,
    go: (d: -1 | 1) => traceNav.current?.(d),
  } : undefined), [meta?.kind, raw, traceHead, traceQuery]);

  // The reader opens on the tail of the transcript and pages backwards from
  // there; the summary is the one call that reads all of it.
  const traceSrc = useMemo<TraceSource>(() => ({
    window: (req, bytes, min, signal) => api.getFileTraceWindow(sessionId, path, req, bytes, min, signal),
    summary: (signal) => api.getFileTraceSummary(sessionId, path, signal),
  }), [sessionId, path]);

  // Rendered markdown and a rendered trace do their own wrapping; the toggle is
  // for the surfaces that actually scroll sideways.
  const showWrap = !!meta && (meta.kind === 'text'
    || ((meta.kind === 'markdown' || meta.kind === 'html' || meta.kind === 'trace') && raw));
  useEffect(() => { onInfo({ meta, extra, edit, trace: traceInfo, showWrap }); },
    [meta, extra, edit, traceInfo, showWrap, onInfo]);

  if (err) return <div className="fv-empty">Could not open this file.<div className="fv-sub">{err}</div></div>;
  if (!meta) return <div className="fv-empty">Loading…</div>;

  const code = (text: string) => (
    <CodeView
      text={text} name={meta.name} theme={theme}
      wrap={wrap}
      line={line} column={column}
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
        : <FileLinkScope session={linkedSource ? undefined : sessionId} root={linkedSource?.root} base={dirOf(path)}>
            <FileLinkContent className="markdown fv-md" html={md} />
          </FileLinkScope>;
    }
    if (meta.kind === 'trace') {
      // Same two faces as markdown: the rendered conversation, or the JSONL
      // underneath it.
      return raw ? code(shown) : (
        <FileLinkScope unavailable><TraceView
          src={traceSrc} srcKey={`file:${sessionId}:${path}`} zoom={zoom} query={traceQuery}
          onHead={setTraceHead} onNav={(go) => { traceNav.current = go; }}
        /></FileLinkScope>
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
        <button className="mini-btn" onClick={() => triggerDownload(downloadSrc, meta.name)}>
          <DownloadGlyph /> Download
        </button>
      </div>
    );
  };

  // Text previews follow the shared zoom. Code/source keeps its compact 12.5px
  // base; rendered markdown keeps its 14px reading base, with its nested type
  // expressed in em below so headings, code and tables move with it. A rendered
  // trace already spends the same zoom inside TraceView (13px, like the session
  // reader). Images and PDF pages keep their intrinsic scale: a text-size control
  // should not enlarge pixels. Rendered HTML lives in an opaque sandboxed frame,
  // so the parent cannot safely reach in and restyle its document; its Source
  // view still zooms as code.
  const isCode = meta.kind === 'text'
    || (raw && (meta.kind === 'markdown' || meta.kind === 'html' || meta.kind === 'trace'));
  const textBase = isCode ? 12.5 : (meta.kind === 'markdown' ? 14 : null);
  // A capped read is a partial answer, so say so where the text ends rather than
  // only as a chip in the strip — and offer the whole file in the same breath.
  const headOnly = !!meta.truncated && (isCode || meta.kind === 'markdown');
  return (
    <div className="fv-body" style={textBase ? { fontSize: `${(textBase * zoom) / 100}px` } : undefined}>
      {body()}
      {headOnly && (
        <div className="fv-foot">
          Showing the first {fmtSize((shown || '').length)} of {fmtSize(meta.size)}.{' '}
          <button className="link-btn" onClick={() => triggerDownload(downloadSrc, meta.name)}>
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
  // Where this pane was when it last went off screen. Read once, at mount.
  const kept = useMemo(() => recall(session.id), [session.id]);
  const [root, setRoot] = useState(kept.root);
  const [rootLabel, setRootLabel] = useState('workspace');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<Sort>(kept.sort ?? DEFAULT_SORT);
  const [viewing, setViewing] = useState<string | null>(kept.viewing);
  const [info, setInfo] = useState<ViewInfo>({ meta: null, extra: [] });
  const [raw, setRaw] = useState(false);          // markdown/html: show the source
  const [scripts, setScripts] = useState(false);  // html: run the page's own JS
  const [confirmClose, setConfirmClose] = useState(false); // leaving with unsaved edits
  const [creating, setCreating] = useState<null | 'folder' | 'file'>(null);
  const [newName, setNewName] = useState('');
  const [pendingDel, setPendingDel] = useState<null | { path: string; name: string; dir: boolean }>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  // Where new folders, new files and uploads land: the folder you last clicked,
  // falling back to the one the breadcrumb names.
  const [target, setTarget] = useState<string | null>(kept.target);
  const [acting, setActing] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const dir = useDir(session.id, root, reloadKey);

  // Coming back to a pane should put you where you left it, not at the top of
  // the workspace — the folder you were in, the file you were reading, and the
  // way you had it sorted.
  useEffect(() => {
    remember(session.id, { root, viewing, target, sort });
  }, [session.id, root, viewing, target, sort]);

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
      try { await api.uploadFile(session.id, dest, f); } catch { /* skip */ }
    }
    setBusy(false);
    setReloadKey((k) => k + 1);
  };

  // Nothing is written without being asked for, so leaving a file with an unsaved
  // buffer would drop it silently. Ask in a dialog — the answer is the work.
  const edit = info.edit;
  const unsaved = edit?.status === 'dirty' || edit?.status === 'error' || !!edit?.conflict;
  const leaveView = () => {
    if (unsaved) { setConfirmClose(true); return; }
    setConfirmClose(false);
    setViewing(null);
  };
  useEffect(() => { if (!unsaved) setConfirmClose(false); }, [unsaved]);

  // "Save and close" has to wait for the write to land before leaving, so the
  // dialog stays up (disabled) rather than closing on a save that then fails.
  // Dismissing the dialog has to hand focus back, or the keyboard is left on
  // <body> and the next Esc goes nowhere — which reads as the guard being broken.
  const backToEditing = () => {
    setConfirmClose(false);
    requestAnimationFrame(() => {
      const cm = paneRef.current?.querySelector<HTMLElement>('.fv-cm .cm-content');
      (cm || paneRef.current)?.focus({ preventScroll: true });
    });
  };

  const saveAndClose = async () => {
    if (!edit) return;
    const ok = await edit.saveNow(!!edit.conflict);
    if (ok) { setConfirmClose(false); setViewing(null); }
  };

  // Create lands in the folder you are looking at, which is the one the
  // breadcrumb names.
  const create = async () => {
    const name = newName.trim();
    if (!name || !creating) return;
    setActing(true); setActErr(null);
    try {
      await (creating === 'folder' ? api.createFolder : api.createFile)(session.id, dest, name);
      setCreating(null); setNewName('');
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setActErr(String(e?.message || e));
    } finally {
      setActing(false);
    }
  };

  const dest = target && (target === root || target.startsWith(root ? `${root}/` : '')) ? target : root;
  useEffect(() => { setTarget(null); setMoving(null); }, [root]);

  const doMove = async (from: string, toDir: string) => {
    setMoving(null); setActErr(null);
    try {
      const { path: next } = await api.moveEntry(session.id, from, toDir);
      if (viewing === from) setViewing(next);
      else if (viewing && viewing.startsWith(`${from}/`)) setViewing(`${next}${viewing.slice(from.length)}`);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setActErr(String(e?.message || e));
    }
  };

  const doRename = async (p: string, name: string) => {
    setRenaming(null); setActErr(null);
    try {
      const { path: next } = await api.renameEntry(session.id, p, name);
      // Keep the viewer pointed at the same bytes: renaming the open file, or a
      // folder above it, should not close what you were reading.
      if (viewing === p) setViewing(next);
      else if (viewing && viewing.startsWith(`${p}/`)) setViewing(`${next}${viewing.slice(p.length)}`);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setActErr(String(e?.message || e));
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
        else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && edit?.can) {
          e.preventDefault();
          if (edit.status === 'dirty' || edit.status === 'error') edit.save();
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
              {(edit?.status === 'dirty' || edit?.status === 'saving') && (
                <span className="fv-dirty" title="Unsaved changes">•</span>
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
              <span className="fv-edit">
                {edit.status === 'saved' ? <span className="fv-save saved">saved</span> : (
                  <>
                    <button className="mini-btn" onClick={edit.discard} disabled={edit.status === 'saving'}>Discard</button>
                    <button
                      className="mini-btn primary" onClick={edit.save}
                      disabled={edit.status === 'saving'} title="Save (⌘S)"
                    >
                      {edit.status === 'saving' ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
              </span>
            ) : null}
            {edit?.prettifyError && <span className="fi-err" title={edit.prettifyError}>{edit.prettifyError}</span>}
            {edit?.can && edit.prettify && (
              <button
                className="mini-btn" onClick={edit.prettify}
                title="Re-indent this JSON in the buffer — it still needs saving"
              >
                Prettify
              </button>
            )}
            {info.showWrap && edit && (
              <FileWrapToggle wrap={edit.wrap} onChange={edit.setWrap} />
            )}
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
                {info.trace.turns != null && (
                  <span className="fi-stat">{info.trace.turns.toLocaleString()} turns{info.trace.partial ? ' loaded' : ''}</span>
                )}
                <span className="tv-nav">
                  <button className="mini-btn" disabled={!info.trace.ready} onClick={() => info.trace!.go(-1)}
                    title={info.trace.prompts ? `Previous prompt (${info.trace.prompts})` : 'Previous prompt'}>▲</button>
                  <button className="mini-btn" disabled={!info.trace.ready} onClick={() => info.trace!.go(1)}
                    title={info.trace.prompts ? `Next prompt (${info.trace.prompts})` : 'Next prompt'}>▼</button>
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
              title={`Will be created in ${dest || rootLabel}`}
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setActErr(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); create(); }
                if (e.key === 'Escape') { e.preventDefault(); setCreating(null); setActErr(null); }
              }}
            />
            <span className="files-new-where" title="Click a folder to change where new entries land">
              in {dest ? dest.split('/').pop() : rootLabel}
            </span>
            <button className="mini-btn primary" disabled={!newName.trim() || acting} onClick={create}>Create</button>
            <button className="mini-btn" disabled={acting} onClick={() => { setCreating(null); setActErr(null); }}>Cancel</button>
          </div>
        )}
        {moving && (
          <div className="files-new">
            <MoveGlyph className="tw-ico" />
            <span className="tw-warn">Moving <strong>{moving.name}</strong> — click a folder, or drop it on one</span>
            {canMoveTo(moving, root) && (
              <button className="mini-btn" onClick={() => doMove(moving.path, root)}>
                Move here ({root ? root.split('/').pop() : rootLabel})
              </button>
            )}
            <button className="mini-btn" onClick={() => setMoving(null)}>Cancel</button>
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
              onRename={doRename} renaming={renaming} setRenaming={(p) => { setActErr(null); setRenaming(p); }}
              onMove={doMove} moving={moving} setMoving={(m) => { setActErr(null); setMoving(m); }}
              target={dest} setTarget={setTarget}
            />
          )}
          {busy && <div className="tree-msg">Uploading…</div>}
        </div>
      </div>

      {viewing && confirmClose && edit && (
        <UnsavedDialog
          name={viewing.split('/').pop()!}
          conflict={!!edit.conflict}
          busy={edit.status === 'saving'}
          onSave={saveAndClose}
          onDiscard={() => { edit.discard(); setConfirmClose(false); setViewing(null); }}
          onCancel={backToEditing}
        />
      )}

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
          : edit?.status === 'dirty'
              ? 'Unsaved changes — ⌘S or Save'
              : edit?.can
                ? 'Type to edit · ⌘S saves · Esc goes back'
                : 'Esc goes back to the files'}
      </div>
    </div>
  );
}
