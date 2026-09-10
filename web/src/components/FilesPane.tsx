import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { recall, remember, readWrap, writeWrap } from './filesMemory';
import type { Session } from '../types';
import * as api from '../api';
import { Rails, railPad } from './Rails';
import { keyIntent, keepInView, survivingFocus, type TreeRow } from '../lib/treeNav';
import type { FileEntry, FileKind, FilePreview, WorkspaceFileCollision } from '../api';
import Logo from './Logo';
import { renderMarkdown } from '../lib/markdown';
import { useSaver } from '../lib/saveQueue';
import CodeView from './CodeView';
import FileWrapToggle from './FileWrapToggle';
import PdfView from './PdfView';
import type { TraceHeadInfo, TraceSource } from '../lib/traceWindows';
import LazyPanel from './LazyPanel';
import {
  FolderGlyph, FileGlyph, CloseGlyph, UpGlyph, UploadGlyph, BackGlyph, DownloadGlyph,
  RefreshGlyph, ImageGlyph, CodeGlyph, DocGlyph, GlobeGlyph,
  FolderPlusGlyph, FilePlusGlyph, TrashGlyph, PencilGlyph, MoveGlyph,
} from './icons';

// The rendered-conversation view of a .jsonl file is the trace pane's code,
// fetched only when such a file is opened (most Files sessions never do).
const loadTraceView = () => import('./TracePane');

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
  const stamp = `${sessionId}\u0000${path}\u0000${reloadKey}`;
  const [state, setState] = useState<{ for: string | null; entries: FileEntry[] | null; err: boolean }>(
    { for: null, entries: null, err: false });
  useEffect(() => {
    let alive = true;
    setState({ for: null, entries: null, err: false });
    api.listFiles(sessionId, path)
      .then((r) => { if (alive) setState({ for: stamp, entries: r.entries, err: false }); })
      .catch(() => { if (alive) setState({ for: stamp, entries: null, err: true }); });
    return () => { alive = false; };
  }, [sessionId, path, reloadKey]);
  // WHICH READ THESE ENTRIES CAME FROM — the folder AND the reload that asked
  // for them. The state update above lands in an effect, one render after its
  // inputs changed, so for that one render the previous answer would be drawn as
  // if it were this one. Two ways that bites, both real:
  //
  //   · a new FOLDER draws the old folder's entries against the new path — rows
  //     called `docs/alpha.txt` for a file that is `alpha.txt` at the root;
  //   · a RELOAD after a rename or a move draws the listing from before it, so
  //     the row the operation just created is briefly absent and the row it
  //     replaced is briefly still there.
  //
  // The second one is what put the keyboard on the wrong file: the focus is
  // asked to follow the renamed entry, that stale frame does not contain it, and
  // the repair below reasonably concludes the row is gone. A listing that is not
  // this read's is not a listing yet.
  return state.for === stamp ? state : { entries: null, err: false };
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
  /** Expanded folders, by path — held by the pane so a key and a click agree. */
  open: ReadonlySet<string>;
  setOpen: (path: string, on?: boolean) => void;
  /** The one row that is in the tab order. Focus, not selection: see treeNav. */
  focusPath: string | null;
  /** A row took the focus (Tab, a click, a key) — remember which. */
  onRowFocus: (path: string) => void;
  /** Ask for the focus to be MOVED to a row, once it is drawn. */
  requestFocus: (path: string) => void;
};

// Everything a row needs to be one item of the tree widget: which of the
// listing's rows carries the tab stop, where it sits in the hierarchy, and a
// path the pane can find it by again after a re-render reorders everything.
const rowProps = (
  path: string, dir: boolean, level: number, pos: number, size: number,
  focusPath: string | null, onRowFocus: (p: string) => void,
) => ({
  role: 'treeitem' as const,
  'aria-level': level,
  'aria-posinset': pos,
  'aria-setsize': size,
  'data-path': path,
  'data-dir': dir ? '1' : undefined,
  tabIndex: focusPath === path ? 0 : -1,
  onFocus: (e: React.FocusEvent) => { if (e.target === e.currentTarget) onRowFocus(path); },
});

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
        // An IME sends Enter to accept the candidate it is showing. Committing
        // the rename on that key would rename the file to half a word.
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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

type WorkspaceUploadStatus = 'queued' | 'uploading' | 'uploaded' | 'collision' | 'error' | 'canceled';
type WorkspaceUpload = {
  key: string;
  file: File;
  folder: string;
  destination: string;
  status: WorkspaceUploadStatus;
  loaded: number;
  error?: string;
  collision?: WorkspaceFileCollision;
};

function ReplaceUploadDialog({ upload, busy, onReplace, onCancel }: {
  upload: WorkspaceUpload; busy: boolean; onReplace: () => void; onCancel: () => void;
}) {
  return (
    <div className="fv-modal-back" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="fv-modal" role="dialog" aria-modal="true" aria-label={`Replace ${upload.file.name}?`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        }}>
        <div className="fv-modal-title">Replace “{upload.file.name}”?</div>
        <div className="fv-modal-body">
          A file already exists at <span className="mono">{upload.destination}</span>. Replace it only if it is still the exact file you reviewed here.
        </div>
        <div className="fv-modal-acts">
          <button className="mini-btn primary" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="mini-btn danger" disabled={busy} onClick={onReplace}>{busy ? 'Replacing…' : 'Replace'}</button>
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
      <button className="mini-btn" data-confirm="cancel" disabled={busy} onClick={onNo}>Cancel</button>
    </span>
  );
}

// Rows for one already-loaded listing; folders recurse through FolderNode.
function DirRows({ entries, path, sessionId, prefix, sort, reloadKey, onOpen, onPreview, selected, onDelete, onRename, renaming, setRenaming, onMove, moving, setMoving, target, setTarget, open, setOpen, focusPath, onRowFocus, requestFocus }: RowProps & {
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
              open={open} setOpen={setOpen} focusPath={focusPath} onRowFocus={onRowFocus}
              requestFocus={requestFocus} pos={i + 1} setSize={arr.length}
            />
          );
        }
        const kindNote = e.kind && e.kind !== 'binary' ? `${KIND_LABEL[e.kind]} · ` : '';
        // Only the focused row's actions are Tab stops. Every row's would mean
        // four stops per row between the listing and whatever follows it, all of
        // them invisible until their row is hovered.
        const act = focusPath === p ? 0 : -1;
        return (
          <div
            key={e.name}
            {...rowProps(p, false, prefix.length + 1, i + 1, arr.length, focusPath, onRowFocus)}
            aria-selected={selected === p ? true : undefined}
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
                onCancel={() => { setRenaming(null); requestFocus(p); }}
              />
            ) : <span className="tw-name"><span className="tw-ink">{e.name}</span></span>}
            <span className="tw-size">{fmtSize(e.size)}</span>
            <span className="tw-time">{fmtWhen(e.mtime)}</span>
            <span className="tw-acts">
              <button
                className="tw-act" tabIndex={act} title="Download" aria-label={`Download ${e.name}`}
                onClick={(ev) => { ev.stopPropagation(); triggerDownload(api.downloadUrl(sessionId, p), e.name); }}
              >
                <DownloadGlyph />
              </button>
              <button
                className="tw-act" tabIndex={act} title={`Rename ${e.name}`} aria-label={`Rename ${e.name}`}
                onClick={(ev) => { ev.stopPropagation(); setRenaming(p); }}
              >
                <PencilGlyph />
              </button>
              <button
                className="tw-act" tabIndex={act} title={`Move ${e.name} — then pick a folder`}
                aria-label={`Move ${e.name} — then pick a destination folder`}
                onClick={(ev) => { ev.stopPropagation(); setMoving({ path: p, name: e.name, dir: false }); requestFocus(p); }}
              >
                <MoveGlyph />
              </button>
              <button
                className="tw-act danger" tabIndex={act} title={`Delete ${e.name}`} aria-label={`Delete ${e.name}`}
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
  // Not rows: a folder that is loading, empty or unreadable has nothing to focus,
  // and offering an empty destination would be a keyboard dead end. They are
  // announced instead, so the state is readable rather than silent.
  const here = path.split('/').pop() || path;
  const msg = (text: string, label?: string) => (
    <div className="tree-msg" style={padFor(prefix)} role="status" aria-label={label}>{text}</div>
  );
  if (err) return msg("can't read folder", `${here} could not be read`);
  // The visible ellipsis is the listing's own idiom; a reader gets a sentence.
  if (!entries) return msg('…', `Loading ${here}`);
  if (entries.length === 0) return msg('empty', `${here} is empty`);
  return <DirRows entries={entries} path={path} sessionId={sessionId} prefix={prefix} {...rest} />;
}

// A folder row: single click toggles inline expand, double click opens it as the
// new tree root. A short timer disambiguates the two.
function FolderNode({ path, name, mtime, isLast, pos, setSize, ...rest }: RowProps & {
  path: string; name: string; mtime: number; isLast: boolean; pos: number; setSize: number;
}) {
  const {
    prefix, onOpen, onDelete, onRename, renaming, setRenaming, onMove, moving, setMoving,
    target, setTarget, open: openSet, setOpen: setOpenPath, focusPath, onRowFocus, requestFocus,
  } = rest;
  const open = openSet.has(path);
  const [over, setOver] = useState(false);
  const takes = !!moving && canMoveTo(moving, path);   // would a drop here do anything?
  const act = focusPath === path ? 0 : -1;            // see the file row
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
    timer.current = setTimeout(() => { timer.current = null; setOpenPath(path); }, 200);
  };
  const onDoubleClick = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    onOpen(path);
  };
  return (
    <>
      <div
        {...rowProps(path, true, prefix.length + 1, pos, setSize, focusPath, onRowFocus)}
        aria-expanded={open}
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
            onCancel={() => { setRenaming(null); requestFocus(path); }}
          />
        ) : <span className="tw-name"><span className="tw-ink">{name}</span></span>}
        <span className="tw-size" />
        <span className="tw-time">{fmtWhen(mtime)}</span>
        <span className="tw-acts">
          {/* no download for a folder — hold its slot so Rename, Move and Delete
              sit in the same place on every row */}
          <span className="tw-act ghost" aria-hidden />
          <button
            className="tw-act" tabIndex={act} title={`Rename ${name}`} aria-label={`Rename folder ${name}`}
            onClick={(ev) => { ev.stopPropagation(); setRenaming(path); }}
          >
            <PencilGlyph />
          </button>
          <button
            className="tw-act" tabIndex={act} title={`Move ${name} — then pick a folder`}
            aria-label={`Move folder ${name} — then pick a destination folder`}
            onClick={(ev) => { ev.stopPropagation(); setMoving({ path, name, dir: true }); requestFocus(path); }}
          >
            <MoveGlyph />
          </button>
          <button
            className="tw-act danger" tabIndex={act} title={`Delete ${name}`}
            aria-label={`Delete folder ${name} and everything in it`}
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

type ViewInfo = {
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
export function FileView({ sessionId, path, zoom, raw, scripts, onInfo, onSaved }: {
  sessionId: string; path: string; zoom: number; raw: boolean; scripts: boolean;
  onInfo: (info: ViewInfo) => void;
  onSaved?: () => void;
}) {
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
    const kept = recall(sessionId).draft;
    return kept && kept.path === path ? kept.text : null;
  });
  const [status, setStatus] = useState<SaveState['status']>(() => {
    const kept = recall(sessionId).draft;
    return kept && kept.path === path ? 'dirty' : 'clean';
  });
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // The buffer waiting to be written, if any. There is no timer: these files
  // have no undo and no git behind them, so nothing reaches disk until it is
  // asked for.
  const pending = useRef<{ text: string } | null>(null);
  // The version the buffer was typed against — the precondition the next write
  // carries. It moves on when a write commits, so a save that follows an older
  // one isn't refused for being based on the version that one replaced.
  const baseRef = useRef<string | null>(null);
  // The last text this viewer put on disk, for telling a real save from a repeat
  // of one that already landed.
  const committed = useRef<string | null>(null);
  // Adopt a kept buffer ONCE per file. Re-checking on every render resurrected
  // it mid-save — ⌘S fires two handlers (the editor's keymap and the pane's), the
  // first cleared `pending` and the render in between put it back with the tag it
  // had before the write, so the second handler saved a stale base and the file
  // reported itself changed on disk one moment after being saved.
  const restoredFor = useRef<string | null>(null);
  if (restoredFor.current !== path) {
    restoredFor.current = path;
    const kept = recall(sessionId).draft;
    const mine = kept && kept.path === path ? kept : null;
    pending.current = mine ? { text: mine.text } : null;
    committed.current = null;
    // A kept buffer keeps the version it was typed against: the file may have
    // moved on while it sat there, and that is a conflict, not an overwrite.
    baseRef.current = mine ? mine.base : null;
  }

  useEffect(() => {
    let alive = true;
    setMeta(null); setErr(null); setSource(null); setDims(null); setPages(null);
    setSaveErr(null); setConflict(false); setFmtErr(null);
    // A buffer kept across a pane switch survives the reload of its own file —
    // dropping it here is exactly the loss this is meant to prevent.
    const kept = recall(sessionId).draft;
    if (kept && kept.path === path) { setDraft(kept.text); setStatus('dirty'); }
    else { setDraft(null); setStatus('clean'); }
    setTraceHead(null); setTraceQuery('');
    api.previewFile(sessionId, path)
      .then((m) => { if (alive) { setMeta(m); if (!pending.current) baseRef.current = m.tag ?? null; } })
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
  // Which file this viewer is on *now*. A response describes the file it was
  // sent for, which is not necessarily this one any more.
  const hereRef = useRef({ sessionId, path });
  hereRef.current = { sessionId, path };
  // The text a write actually put on the wire, for working out afterwards
  // whether a lost answer had landed.
  const lastSent = useRef<{ sessionId: string; path: string; text: string } | null>(null);

  // One writer for every save — the Save button, ⌘S and "save and close" all
  // come through here. `force` drops the content precondition, which is what
  // "overwrite" means after a conflict.
  //
  // A Save commits the version that was asked for. Reading the live buffer when
  // the request finally goes out would quietly widen every Save into "and
  // everything typed since", which is the one thing the file policy is not:
  // §1 keeps normal Save explicit, and text typed after it stays dirty until it
  // is saved in its own right.
  //
  // The base is the exception, and is read as the write goes out: an earlier
  // save of this same file may have committed in the meantime, and this text is
  // now based on what it left behind.
  const write = useCallback(async (job: { force: boolean; sessionId: string; path: string; text: string; base: string | null }) => {
    const { force, text } = job;
    const here = job.sessionId === hereRef.current.sessionId && job.path === hereRef.current.path;
    const base = here ? baseRef.current : job.base;
    // ⌘S fires two handlers (the editor's keymap and the pane's), so the second
    // one arrives behind the first with the same text. It is still a save — the
    // buffer it asked for is on disk — but it does not need a second round trip
    // to say what the first already did.
    if (!force && here && text === committed.current) {
      return { sessionId: job.sessionId, path: job.path, text, after: null };
    }
    lastSent.current = { sessionId: job.sessionId, path: job.path, text };
    const after = await api.writeFile(job.sessionId, job.path, text, force ? null : base);
    return { sessionId: job.sessionId, path: job.path, text, after };
  }, []);

  type Written = { sessionId: string; path: string; text: string; after: Awaited<ReturnType<typeof api.writeFile>> | null };

  const saver = useSaver<{ force: boolean; sessionId: string; path: string; text: string; base: string | null }, Written | null>({
    send: write,
    onCommit: (_req, result, superseded) => {
      if (!result) return;              // there was nothing left to write
      const { sessionId: sid, path: fp, text, after } = result;
      const here = sid === hereRef.current.sessionId && fp === hereRef.current.path;

      // The remembered draft is shared by every viewer of this session, and it
      // outlives them. Only the draft that IS this text may be released by this
      // response — a newer draft, or one belonging to another file, is exactly
      // the work an older success must not touch.
      const kept = recall(sid).draft;
      if (kept && kept.path === fp) {
        if (kept.text === text) remember(sid, { draft: null });
        else if (after) remember(sid, { draft: { ...kept, base: after.tag ?? null } });
      }

      if (!here) return;                // this viewer moved on; its state is not this file's
      committed.current = text;
      if (after) {
        setConflict(false);
        baseRef.current = after.tag ?? null;
        setMeta((m) => (m ? { ...m, text: m.kind === 'html' ? m.text : text, size: after.size, mtime: after.mtime, tag: after.tag } : m));
        if (kindRef.current === 'html') setSource(text);
        onSaved?.();
      }
      // Does this response still describe the editor? Not if a newer save is
      // already queued behind it, and not if the buffer has been typed into
      // since. Either way the draft stays — releasing it here is the lost-work
      // bug this guards.
      const buffered = pending.current;
      const stale = superseded || (!!buffered && buffered.text !== text);
      if (stale) {
        // A queued write is going out this instant; anything else is unsaved.
        if (!superseded) setStatus((st) => (st === 'error' ? st : 'dirty'));
        return;
      }
      pending.current = null;
      setStatus('saved');
    },
    onFail: (e, job) => {
      if (job.sessionId !== hereRef.current.sessionId || job.path !== hereRef.current.path) return;
      const msg = e.message;
      // A refused save must NOT drop the text — the buffer is left where it is
      // so the next attempt (or an overwrite) still has it.
      setConflict((e instanceof api.ApiError && e.code === 'file-changed') || /changed on disk/.test(msg));
      setSaveErr(msg);
      setStatus('error');
    },
    // A write that never answers must not hold the file's slot forever. Files
    // can be large, so this is generous — it is a request that is not coming
    // back, not a slow one.
    timeoutMs: 30_000,
    // A lost answer may have committed. Read the file back and compare before
    // anything is sent again: retrying blind would either repeat a write that
    // landed or walk over what replaced it.
    reconcile: async () => {
      const sent = lastSent.current;
      if (!sent) return { outcome: 'lost' };
      const m = await api.previewFile(sent.sessionId, sent.path);
      // html keeps its source outside the preview payload, so there is nothing
      // to compare: the retry goes through the base precondition instead, which
      // reports a conflict rather than overwriting.
      if (m.kind === 'html' || m.text !== sent.text) return { outcome: 'lost' };
      return {
        outcome: 'committed',
        result: { sessionId: sent.sessionId, path: sent.path, text: sent.text, after: { size: m.size, mtime: m.mtime, tag: m.tag ?? null } },
      };
    },
  });

  // Resolves true when the file on disk matches the buffer — which "save and
  // close" needs, so a failed write keeps the dialog up instead of closing over
  // the error, and a write still queued behind another one keeps it up too.
  const saveRequest = saver.request;
  const flush = useCallback((force = false): Promise<boolean> => {
    const job = pending.current;
    if (!job) return Promise.resolve(true);   // nothing outstanding
    setStatus('saving'); setSaveErr(null);
    // The version asked for is fixed here, at the moment the operator asked.
    return saveRequest({ force, sessionId, path, text: job.text, base: baseRef.current });
  }, [saveRequest, sessionId, path]);

  // Typing only fills the buffer. Writing it is a decision, taken with the Save
  // button or ⌘S — an autosave here would be one stray keystroke away from
  // silently rewriting a file with no undo behind it.
  const onEdit = useCallback((next: string) => {
    setDraft(next);
    if (!canEdit || !meta) return;
    pending.current = { text: next };
    // Held outside the component so switching this tile to another session — or
    // reloading the app — doesn't take the buffer with it.
    remember(sessionId, { draft: { path, text: next, base: baseRef.current } });
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
    // "Save and close" asks a stricter question than Save: is the buffer as it
    // stands now on disk? A write that succeeded for older text is not a yes.
    saveNow: async (force = false) => {
      const ok = await flush(force);
      return ok && !pending.current;
    },
    discard: () => {
      pending.current = null;
      saver.reset();
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
      saver.reset();
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
  }), [canEdit, editKind, meta?.truncated, status, saveErr, conflict, flush, saver.reset, sessionId, path,
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

  const rawSrc = api.rawUrl(sessionId, path);
  const code = (text: string) => (
    <CodeView
      text={text} name={meta.name} theme={theme}
      wrap={wrap}
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
        <LazyPanel load={loadTraceView} what="the trace viewer" render={(m) => (
          <m.TraceView
            src={traceSrc} srcKey={`file:${sessionId}:${path}`} zoom={zoom} query={traceQuery}
            onHead={setTraceHead} onNav={(go) => { traceNav.current = go; }}
          />
        )} />
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
  const [workspaceUploads, setWorkspaceUploads] = useState<WorkspaceUpload[]>([]);
  const workspaceUploadsRef = useRef<WorkspaceUpload[]>([]);
  const workspaceUploadBusy = useRef(false);
  const workspaceControllers = useRef(new Map<string, AbortController>());
  const [pendingReplace, setPendingReplace] = useState<string | null>(null);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  // Expanded folders live here rather than in each row, so the keyboard's
  // expand/collapse and the pointer's click-to-expand are the same fact, and
  // `aria-expanded` can be read off it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // WHICH ROW OWNS THE KEYBOARD — by path, never by index: a sort or a refresh
  // reorders the listing under you, and an index would silently mean a different
  // file. It is the tree's single tab stop and nothing more; opening, moving and
  // deleting are separate acts, so arrowing over a row changes nothing on disk.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // A pending request to MOVE the browser's focus, which is a different question
  // from which row is the tab stop: only a user action sets one, it expires, and
  // it is dropped if the operator has since gone to another pane. That is what
  // keeps a slow directory response from stealing the keyboard.
  const wantFocus = useRef<{ path: string; until: number } | null>(null);
  // Set by an operation that is about to remove the focused row, so the repair
  // below knows the focus was ours to place and not someone else's to keep. A
  // deadline rather than a flag: opening a folder empties the listing until the
  // read comes back, so the claim has to outlive a render or two — and then
  // lapse, rather than waiting to pounce on whatever is drawn next.
  const claim = useRef(0);
  const drawn = useRef<string[]>([]);

  const dir = useDir(session.id, root, reloadKey);

  const rowEls = () => Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') || []);
  const rowEl = (path: string) => rowEls().find((el) => el.dataset.path === path) || null;
  const rows = (): TreeRow[] => rowEls().map((el) => ({
    path: el.dataset.path || '', dir: el.dataset.dir === '1', open: el.getAttribute('aria-expanded') === 'true',
  }));
  const requestFocus = useCallback((path: string) => {
    setFocusPath(path);
    wantFocus.current = { path, until: Date.now() + 2000 };
  }, []);
  const setOpenPath = useCallback((path: string, on?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (on ?? !next.has(path)) next.add(path); else next.delete(path);
      return next;
    });
  }, []);
  // True when the focus is somewhere in this pane right now — asked BEFORE an
  // operation removes the row that had it, since by the time React has taken the
  // row away the browser has already parked the focus on <body>.
  const claimFocus = () => {
    if (paneRef.current?.contains(document.activeElement)) claim.current = Date.now() + 2000;
  };

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

  // KEEP THE TAB STOP ON A ROW THAT EXISTS. Runs after every render because
  // every render is a chance the listing changed underneath the focus: renamed,
  // deleted, moved away, re-sorted, or replaced when the root changed. Only the
  // tab stop is repaired here; the browser's focus moves only when this pane was
  // the one holding it.
  useLayoutEffect(() => {
    if (viewing || !bodyRef.current) return;
    const paths = rowEls().map((el) => el.dataset.path || '');
    // NOTHING DRAWN YET. The folder is still being read, so this is not an answer
    // about anything: a claim keeps waiting, a pending focus request keeps
    // waiting, and — the part that bit — the last listing the operator actually
    // saw stays recorded. Overwriting it with the empty one made the repair
    // afterwards forget where the missing row had been, and send the focus to
    // the top of the listing instead of to its neighbour.
    if (!paths.length) return;
    const before = drawn.current;
    drawn.current = paths;
    if (focusPath && paths.includes(focusPath)) return;   // the claim, if any, keeps until it lapses
    const mine = Date.now() < claim.current || bodyRef.current.contains(document.activeElement);
    claim.current = 0;
    const next = focusPath ? survivingFocus(before, paths, focusPath) : paths[0];
    if (!next) return;
    if (mine) requestFocus(next); else setFocusPath(next);
  });

  // Move the focus to a row that was asked for. Split from the repair above
  // because the row is often not drawn yet — a rename or a move only lands after
  // the listing has been read again — so this waits for the render that draws it,
  // and gives up rather than pouncing on a row that arrives much later.
  useLayoutEffect(() => {
    const req = wantFocus.current;
    const box = bodyRef.current;
    if (!req || !box || viewing) return;
    const active = document.activeElement as HTMLElement | null;
    const elsewhere = active && active !== document.body && !paneRef.current?.contains(active);
    if (elsewhere || Date.now() > req.until) { wantFocus.current = null; return; }
    const el = rowEl(req.path);
    if (!el) return;
    wantFocus.current = null;
    el.focus({ preventScroll: true });
    keepInView(el, box);
  });

  const updateWorkspaceUpload = (key: string, patch: Partial<WorkspaceUpload>) => {
    const next = workspaceUploadsRef.current.map((item) => item.key === key ? { ...item, ...patch } : item);
    workspaceUploadsRef.current = next;
    setWorkspaceUploads(next);
  };
  const runWorkspaceUpload = async (item: WorkspaceUpload, replaceToken?: string) => {
    if (workspaceUploadsRef.current.find((current) => current.key === item.key)?.status === 'canceled') return;
    const controller = new AbortController();
    workspaceControllers.current.set(item.key, controller);
    updateWorkspaceUpload(item.key, { status: 'uploading', loaded: 0, error: undefined, collision: undefined });
    try {
      await api.uploadFile(session.id, item.folder, item.file, {
        replaceToken,
        signal: controller.signal,
        onProgress: ({ loaded }) => updateWorkspaceUpload(item.key, { loaded }),
      });
      if (controller.signal.aborted) return;
      updateWorkspaceUpload(item.key, { status: 'uploaded', loaded: item.file.size });
      setReloadKey((key) => key + 1);
    } catch (error) {
      if (controller.signal.aborted) return;
      // A stale replacement can report that the destination disappeared. With
      // no fresh token there is nothing left to replace: make the next action a
      // normal create retry instead of offering a Replace button that cannot run.
      if (error instanceof api.WorkspaceUploadError && error.collision?.replaceToken) {
        updateWorkspaceUpload(item.key, {
          status: 'collision',
          loaded: 0,
          error: error.message,
          collision: error.collision,
          destination: `${rootLabel}/${error.collision.path}`,
        });
      } else {
        updateWorkspaceUpload(item.key, {
          status: 'error', loaded: 0,
          error: error instanceof Error ? error.message : 'Upload failed before the file was published.',
        });
      }
    } finally {
      if (workspaceControllers.current.get(item.key) === controller) workspaceControllers.current.delete(item.key);
    }
  };

  const upload = async (files: FileList | File[]) => {
    if (workspaceUploadBusy.current) {
      setActErr('Wait for the current upload batch, or cancel a file in it.');
      return;
    }
    const selected = Array.from(files);
    if (!selected.length) return;
    const folder = dest;
    const items = selected.map((file): WorkspaceUpload => ({
      key: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      folder,
      destination: `${rootLabel}/${join(folder, file.name)}`,
      status: 'queued',
      loaded: 0,
    }));
    workspaceUploadsRef.current = [...workspaceUploadsRef.current, ...items];
    setWorkspaceUploads(workspaceUploadsRef.current);
    workspaceUploadBusy.current = true;
    setBusy(true); setActErr(null);
    for (const item of items) await runWorkspaceUpload(item);
    workspaceUploadBusy.current = false;
    setBusy(false);
  };

  const cancelWorkspaceUpload = (key: string) => {
    workspaceControllers.current.get(key)?.abort();
    updateWorkspaceUpload(key, { status: 'canceled', loaded: 0, error: undefined, collision: undefined });
    if (pendingReplace === key) setPendingReplace(null);
  };
  const retryWorkspaceUpload = (key: string) => {
    if (workspaceUploadBusy.current || replaceBusy) return;
    const item = workspaceUploadsRef.current.find((candidate) => candidate.key === key);
    if (item) void runWorkspaceUpload(item);
  };
  const confirmWorkspaceReplace = async () => {
    const item = workspaceUploadsRef.current.find((candidate) => candidate.key === pendingReplace);
    const token = item?.collision?.replaceToken;
    if (!item || !token || replaceBusy) return;
    setReplaceBusy(true);
    await runWorkspaceUpload(item, token);
    setReplaceBusy(false); setPendingReplace(null);
  };
  const cancelWorkspaceReplace = () => {
    if (pendingReplace) cancelWorkspaceUpload(pendingReplace);
    setPendingReplace(null);
  };
  useEffect(() => () => {
    for (const controller of workspaceControllers.current.values()) controller.abort();
  }, []);

  // Nothing is written without being asked for, so leaving a file with an unsaved
  // buffer would drop it silently. Ask in a dialog — the answer is the work.
  const edit = info.edit;
  // A write still in flight counts: leaving while it is out is leaving with the
  // answer unknown, and the dialog is where "save and close" lives.
  const unsaved = edit?.status === 'dirty' || edit?.status === 'error'
    || edit?.status === 'saving' || !!edit?.conflict;
  const leaveView = () => {
    if (unsaved) { setConfirmClose(true); return; }
    setConfirmClose(false);
    // Back to the row the file was opened from — the listing was only hidden, so
    // its expansion and scroll are still there and this is the last piece of
    // where you were.
    if (viewing) requestFocus(viewing);
    setViewing(null);
  };
  useEffect(() => { if (!unsaved) setConfirmClose(false); }, [unsaved]);

  // "Save and close" has to wait for the write to land before leaving, so the
  // dialog stays up (disabled) rather than closing on a save that then fails.
  // Dismissing the dialog has to hand focus back, or the keyboard is left on
  // <body> and the next Esc goes nowhere — which reads as the guard being broken.
  const backToEditing = () => {
    // The dialog's own answer. A save that was already out when it was clicked
    // must not come back and close the view anyway.
    closeIntent.current = false;
    setConfirmClose(false);
    requestAnimationFrame(() => {
      const cm = paneRef.current?.querySelector<HTMLElement>('.fv-cm .cm-content');
      (cm || paneRef.current)?.focus({ preventScroll: true });
    });
  };

  // Whether the operator still wants to leave, read after the write settles
  // rather than assumed from when it started.
  const closeIntent = useRef(false);
  const saveAndClose = async () => {
    if (!edit) return;
    closeIntent.current = true;
    // saveNow answers the strict question — is the buffer as it stands on disk —
    // so text typed while the write was out comes back as false rather than as
    // permission to close over it. Keep editing withdraws the intent outright.
    const ok = await edit.saveNow(!!edit.conflict);
    if (!ok || !closeIntent.current) return;
    closeIntent.current = false;
    setConfirmClose(false);
    if (viewing) requestFocus(viewing);
    setViewing(null);
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
    setMoving(null); setActErr(null); claimFocus();
    try {
      const { path: next } = await api.moveEntry(session.id, from, toDir);
      requestFocus(next);          // follow the entry to where it went
      if (viewing === from) setViewing(next);
      else if (viewing && viewing.startsWith(`${from}/`)) setViewing(`${next}${viewing.slice(from.length)}`);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setActErr(String(e?.message || e));
    }
  };

  const doRename = async (p: string, name: string) => {
    setRenaming(null); setActErr(null); claimFocus();
    try {
      const { path: next } = await api.renameEntry(session.id, p, name);
      requestFocus(next);          // same row, new name
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
    setActing(true); setActErr(null); claimFocus();
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

  // THE LISTING'S KEYS. One handler for every row, on the box they sit in: rows
  // come and go, and a listener per row would be a listener per row to get wrong.
  // What each key means is in lib/treeNav.ts; what is here is everything that
  // depends on what the pane is doing — an armed move, an open confirmation — and
  // the rule that a key belongs to whatever is focused before it belongs to us.
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    // Composition first: an IME sends Enter to finish a word, and that Enter is
    // the input's, not ours. Then anything being typed into.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.altKey || e.metaKey || e.ctrlKey) return;   // ⌘S and friends belong to the pane

    if (e.key === 'Escape') {
      // One Escape undoes one pending thing, and closes nothing else. The row it
      // was about gets the focus back, because that is where the eye is.
      if (moving) { e.preventDefault(); e.stopPropagation(); const { path } = moving; setMoving(null); requestFocus(path); return; }
      if (pendingDel && !acting) { e.preventDefault(); e.stopPropagation(); const { path } = pendingDel; setPendingDel(null); requestFocus(path); return; }
      return;
    }
    // A focused action button owns its own Enter and Space; the row must not act
    // on the same press as well.
    if (el.closest('button')) return;

    const here = el.closest<HTMLElement>('[role="treeitem"]')?.dataset.path ?? focusPath;
    const intent = keyIntent(rows(), here ?? null, e.key);
    if (!intent) return;                     // Tab, typing, anything else: not ours
    e.preventDefault();
    e.stopPropagation();                     // and not the other panes' either
    if (intent.kind === 'focus') { requestFocus(intent.path); return; }
    if (intent.kind === 'expand' || intent.kind === 'collapse') {
      setOpenPath(intent.path, intent.kind === 'expand');
      requestFocus(intent.path);             // expanding does not leave the folder
      return;
    }
    // Enter. While a move is armed the tree is a destination picker, exactly as
    // it is for the pointer: a folder that can take the entry takes it, a folder
    // that cannot cancels, and a file is not a destination at all.
    if (moving) {
      if (!intent.dir) return;
      if (canMoveTo(moving, intent.path)) doMove(moving.path, intent.path);
      else { const { path } = moving; setMoving(null); requestFocus(path); }
      return;
    }
    // Opening a folder replaces every row, so say the focus is ours to place —
    // asked here, while the row that has it is still on screen.
    if (intent.dir) { claimFocus(); openDir(intent.path); } else setViewing(intent.path);
  };

  const up = () => setRoot(root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '');
  const openDir = (p: string) => { setViewing(null); setRoot(p); };
  const crumbs = ['', ...root.split('/').filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join('/'))];

  // A confirmation that nobody's keyboard can reach is not a confirmation. It
  // opens on Cancel, never on Delete: the key that opened it is still going up,
  // and a Space release landing on a freshly focused Delete would delete the file
  // with one press. One Tab away is close enough for the answer that is meant to
  // cost something.
  useEffect(() => {
    if (!pendingDel || !paneRef.current?.contains(document.activeElement)) return;
    paneRef.current.querySelector<HTMLElement>('[data-confirm="cancel"]')?.focus({ preventScroll: true });
  }, [pendingDel]);

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

  const workspaceUploadCounts = useMemo(() => ({
    queued: workspaceUploads.filter((item) => item.status === 'queued').length,
    uploading: workspaceUploads.filter((item) => item.status === 'uploading').length,
    uploaded: workspaceUploads.filter((item) => item.status === 'uploaded').length,
    failed: workspaceUploads.filter((item) => item.status === 'error' || item.status === 'collision').length,
    canceled: workspaceUploads.filter((item) => item.status === 'canceled').length,
  }), [workspaceUploads]);
  const replacement = workspaceUploads.find((item) => item.key === pendingReplace) || null;

  const meta = info.meta;
  const name = viewing ? viewing.split('/').pop()! : '';

  return (
    <div
      className={`slot${focused ? ' focused' : ''}`} ref={paneRef} tabIndex={-1}
      onMouseDown={onFocus}
      // …and the same for the keyboard: tabbing into the listing has to make
      // this the pane the app considers current, or the row you are standing on
      // is in one pane while the app's shortcuts are pointed at another. React's
      // onFocus is focusin, so it fires for anything inside the pane.
      onFocus={onFocus}
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
            <button className="mini-btn" title="Back to files (Esc)" aria-label="Back to files" onClick={leaveView}><BackGlyph /></button>
            <span className="fv-title" title={viewing}>
              <KindGlyph name={name} kind={meta?.kind} className="tw-ico" />
              <span className="fv-name">{name}</span>
              {(edit?.status === 'dirty' || edit?.status === 'saving') && (
                <span className="fv-dirty" title="Unsaved changes">•</span>
              )}
            </span>
            <span className="spacer" />
            <button
              className="mini-btn" title="Download" aria-label={`Download ${name}`}
              onClick={() => triggerDownload(api.downloadUrl(session.id, viewing), name)}
            >
              <DownloadGlyph />
            </button>
          </>
        ) : (
          <>
            <button className="mini-btn" title="Up" aria-label="Up one folder" disabled={!root} onClick={up}><UpGlyph /></button>
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
              className="mini-btn" title="New folder here" aria-label={`New folder in ${dest || rootLabel}`}
              onClick={() => { setCreating('folder'); setNewName(''); setActErr(null); }}
            ><FolderPlusGlyph /></button>
            <button
              className="mini-btn" title="New empty file here" aria-label={`New file in ${dest || rootLabel}`}
              onClick={() => { setCreating('file'); setNewName(''); setActErr(null); }}
            ><FilePlusGlyph /></button>
            <button
              className="mini-btn" title="Refresh" aria-label="Refresh the listing"
              onClick={() => setReloadKey((k) => k + 1)}
            ><RefreshGlyph /></button>
            {/* A <label> around a hidden <input type=file> is clickable and
                nothing else: the input cannot be tabbed to (it is hidden) and a
                label is not a control, so the picker had no keyboard at all.
                Made a button in its own right, opening the same picker. */}
            <label
              className={`mini-btn upload-btn${busy ? ' disabled' : ''}`}
              title={busy ? 'Current upload batch is still running' : 'Upload files'}
              role="button" tabIndex={0} aria-label="Upload files" aria-disabled={busy || undefined}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.currentTarget.querySelector<HTMLInputElement>('input[type=file]')?.click();
              }}
            >
              <UploadGlyph /> Upload
              <input type="file" multiple hidden disabled={busy} onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
            </label>
          </>
        )}
        <button
          className="mini-btn ph-close" title="Close" aria-label="Close the files pane"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        ><CloseGlyph /></button>
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
              // A failure that is not a conflict — the disk is full, the server
              // said no — still has a way forward. Without one the buffer is
              // stranded: kept, but with nothing on screen to send it again.
              <span className="fv-edit">
                <span className="fi-err" title={edit.error}>{edit.error}</span>
                <button className="mini-btn" onClick={edit.discard}>Discard</button>
                <button className="mini-btn primary" onClick={edit.save} disabled={edit.status === 'saving'}>
                  {edit.status === 'saving' ? 'Saving…' : 'Retry'}
                </button>
              </span>
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
      {/* The key handler sits on the STACK, not on the listing: the create field,
          the move bar and the delete confirmation are drawn above the rows, not
          inside them, and Escape has to reach them from whichever of their
          buttons has the focus. Everything it does is still about the listing —
          see onTreeKey, which hands every key back that is not its business. */}
      <div
        className="files-stack" hidden={!!viewing} onKeyDown={onTreeKey}
        style={{ fontSize: `${(13 * zoom) / 100}px` }}
      >
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
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;   // see RenameInput
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
            <button
              className="mini-btn"
              onClick={() => { const { path } = moving; setMoving(null); requestFocus(path); }}
            >Cancel</button>
          </div>
        )}
        {pendingDel && (
          <div className="files-new danger-row">
            <TrashGlyph className="tw-ico" />
            <ConfirmDelete
              name={pendingDel.name} dir={pendingDel.dir} busy={acting}
              onYes={doDelete}
              onNo={() => { setPendingDel(null); setActErr(null); requestFocus(pendingDel.path); }}
            />
          </div>
        )}
        {actErr && <div className="files-new err">{actErr}</div>}
        {workspaceUploads.length > 0 && (
          <div className="files-uploads" aria-label="Workspace upload results">
            <div className="files-uploads-head mono" role="status">
              <span>{workspaceUploads.length} file{workspaceUploads.length === 1 ? '' : 's'}</span>
              {workspaceUploadCounts.queued > 0 && <span>{workspaceUploadCounts.queued} queued</span>}
              {workspaceUploadCounts.uploading > 0 && <span>{workspaceUploadCounts.uploading} uploading</span>}
              {workspaceUploadCounts.uploaded > 0 && <span>{workspaceUploadCounts.uploaded} uploaded</span>}
              {workspaceUploadCounts.failed > 0 && <span className="bad">{workspaceUploadCounts.failed} need attention</span>}
              {workspaceUploadCounts.canceled > 0 && <span>{workspaceUploadCounts.canceled} canceled</span>}
              <span className="spacer" />
              <button className="mini-btn" onClick={() => {
                const next = workspaceUploadsRef.current.filter((item) => !['uploaded', 'canceled'].includes(item.status));
                workspaceUploadsRef.current = next; setWorkspaceUploads(next);
              }}>Clear finished</button>
            </div>
            <div className="files-upload-list">
              {workspaceUploads.map((item) => {
                const percent = item.file.size ? Math.min(100, Math.round((item.loaded / item.file.size) * 100)) : 0;
                return <div key={item.key} className={`files-upload-row ${item.status}`}>
                  <span className="files-upload-name" title={item.destination}>{item.file.name}</span>
                  <span className="files-upload-state mono" title={item.error}>
                    {item.status === 'uploading' ? `${percent}% · publishing after upload`
                      : item.status === 'collision' ? item.error
                        : item.status === 'error' ? item.error
                          : item.status}
                  </span>
                  {item.status === 'collision' && <>
                    <button className="mini-btn danger-hover" onClick={() => setPendingReplace(item.key)}>Replace…</button>
                    <button className="mini-btn" onClick={() => cancelWorkspaceUpload(item.key)}>Cancel</button>
                  </>}
                  {item.status === 'error' && <>
                    <button className="mini-btn" disabled={busy || replaceBusy} onClick={() => retryWorkspaceUpload(item.key)}>Retry</button>
                    <button className="mini-btn" onClick={() => cancelWorkspaceUpload(item.key)}>Dismiss</button>
                  </>}
                  {(item.status === 'queued' || item.status === 'uploading') && (
                    <button className="mini-btn" onClick={() => cancelWorkspaceUpload(item.key)}>Cancel</button>
                  )}
                </div>;
              })}
            </div>
          </div>
        )}
        <Cols
          sort={sort}
          onSort={(k) => setSort((s) => (s.key === k ? { key: k, desc: !s.desc } : { key: k, desc: k !== 'name' }))}
        />
        <div
          ref={bodyRef}
          className={`files-body tree${dragOver ? ' drag' : ''}`}
          role="tree"
          aria-label={`Files in ${root ? `${rootLabel}/${root}` : rootLabel}`}
          // With rows on screen the tab stop is one of them; with none — loading,
          // empty, unreadable — it is the box itself, so Tab still finds the
          // listing and lands on something that says what it is.
          tabIndex={dir.entries?.length ? -1 : 0}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
        >
          {dir.err && <div className="tree-msg" role="status">can't read folder</div>}
          {!dir.err && !dir.entries && <div className="tree-msg" role="status" aria-label="Loading files">…</div>}
          {dir.entries?.length === 0 && <div className="tree-msg" role="status">empty folder</div>}
          {dir.entries && dir.entries.length > 0 && (
            <DirRows
              entries={dir.entries} path={root} sessionId={session.id} prefix={[]} sort={sort}
              reloadKey={reloadKey} onOpen={openDir} onPreview={setViewing} selected={viewing}
              onDelete={(p, name, isDir) => { setCreating(null); setActErr(null); setPendingDel({ path: p, name, dir: isDir }); }}
              onRename={doRename} renaming={renaming} setRenaming={(p) => { setActErr(null); setRenaming(p); }}
              onMove={doMove} moving={moving} setMoving={(m) => { setActErr(null); setMoving(m); }}
              target={dest} setTarget={setTarget}
              open={expanded} setOpen={setOpenPath} focusPath={focusPath}
              onRowFocus={setFocusPath} requestFocus={requestFocus}
            />
          )}
        </div>
      </div>

      {replacement && (
        <ReplaceUploadDialog upload={replacement} busy={replaceBusy}
          onReplace={() => void confirmWorkspaceReplace()} onCancel={cancelWorkspaceReplace} />
      )}

      {viewing && confirmClose && edit && (
        <UnsavedDialog
          name={viewing.split('/').pop()!}
          conflict={!!edit.conflict}
          busy={edit.status === 'saving'}
          onSave={saveAndClose}
          onDiscard={() => { edit.discard(); setConfirmClose(false); requestFocus(viewing); setViewing(null); }}
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
          ? 'Click a file to preview · double-click a folder to open it · ↑↓ move, → expand, ← collapse, Enter opens, Tab reaches the row\u2019s actions'
          : edit?.status === 'dirty'
              ? 'Unsaved changes — ⌘S or Save'
              : edit?.can
                ? 'Type to edit · ⌘S saves · Esc goes back'
                : 'Esc goes back to the files'}
      </div>
    </div>
  );
}
