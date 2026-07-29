import { useEffect, useRef, useState } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { FileEntry } from '../api';
import Logo from './Logo';
import { FolderGlyph, FileGlyph, CloseGlyph, UpGlyph, UploadGlyph, PlusGlyph, PencilGlyph, TrashGlyph } from './icons';

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const sortEntries = (es: FileEntry[]) =>
  [...es].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

const triggerDownload = (url: string, name: string) => {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
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

// Inline field for naming a new folder or renaming one. Enter commits, Escape
// cancels, blur commits — and `done` keeps the blur that follows a keypress
// from committing (or cancelling) a second time.
function NameInput({ init, onCommit, onCancel }: {
  init: string; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(init);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== init) onCommit(name); else onCancel();
  };
  return (
    <input
      autoFocus className="tw-input" value={value} spellCheck={false} placeholder="folder name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

// Lazily-loaded contents of one directory; recurses through FolderNode.
// `nonce` re-lists after one of its folders is renamed or deleted.
function DirContents({ sessionId, path, prefix, onOpen, onError }: {
  sessionId: string; path: string; prefix: boolean[];
  onOpen: (p: string) => void; onError: (msg: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    api.listFiles(sessionId, path)
      .then((r) => { if (alive) { setEntries(r.entries); setErr(false); } })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [sessionId, path, nonce]);

  if (err) return <div className="tree-msg" style={padFor(prefix)}>can't read folder</div>;
  if (!entries) return <div className="tree-msg" style={padFor(prefix)}>…</div>;
  if (entries.length === 0) return <div className="tree-msg" style={padFor(prefix)}>empty</div>;

  const arr = sortEntries(entries);
  return (
    <>
      {arr.map((e, i) => {
        const isLast = i === arr.length - 1;
        const p = join(path, e.name);
        return e.dir ? (
          <FolderNode
            key={e.name} sessionId={sessionId} path={p} name={e.name} prefix={prefix} isLast={isLast}
            onOpen={onOpen} onError={onError} onChanged={() => setNonce((n) => n + 1)}
          />
        ) : (
          <div
            key={e.name}
            className="tree-row file"
            style={padFor(prefix)}
            onDoubleClick={() => triggerDownload(api.downloadUrl(sessionId, p), e.name)}
            title="Double-click to download"
          >
            <Rails prefix={prefix} isLast={isLast} />
            <FileGlyph className="tw-ico" />
            <span className="tw-name">{e.name}</span>
            <span className="tw-size">{fmtSize(e.size)}</span>
          </div>
        );
      })}
    </>
  );
}

// A folder row: single click toggles inline expand, double click opens it as the
// new tree root. A short timer disambiguates the two. Rename and delete ride the
// row on hover; delete asks once, because it takes the contents with it.
function FolderNode({ sessionId, path, name, prefix, isLast, onOpen, onError, onChanged }: {
  sessionId: string; path: string; name: string; prefix: boolean[]; isLast: boolean;
  onOpen: (p: string) => void; onError: (msg: string) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onClick = () => {
    if (editing || confirmDel || timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; setOpen((o) => !o); }, 200);
  };
  const onDoubleClick = () => {
    if (editing || confirmDel) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    onOpen(path);
  };
  // The parent listing owns this row, so it's the one that has to re-read.
  const settle = (p: Promise<unknown>) =>
    p.then(() => { onError(''); onChanged(); }).catch((e) => onError(e.message));
  const rename = (next: string) => { setEditing(false); settle(api.renameEntry(sessionId, path, next)); };
  const remove = () => { setConfirmDel(false); settle(api.deleteEntry(sessionId, path)); };

  return (
    <>
      <div className="tree-row folder" style={padFor(prefix)} onClick={onClick} onDoubleClick={onDoubleClick} title="Click to expand · double-click to open">
        <Rails prefix={prefix} isLast={isLast} />
        <FolderGlyph className="tw-ico" open={open} />
        {editing ? (
          <NameInput init={name} onCommit={rename} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <span className="tw-name">{name}</span>
            {/* the row's expand/open gestures must not fire from these buttons */}
            <span
              className={`tw-actions${confirmDel ? ' open' : ''}`}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {confirmDel ? (
                <>
                  <span className="tw-warn">Delete folder and everything in it?</span>
                  <button className="mini-btn danger" onClick={remove}>Delete</button>
                  <button className="mini-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="mini-btn" title="Rename folder" onClick={() => setEditing(true)}><PencilGlyph /></button>
                  <button className="mini-btn" title="Delete folder" onClick={() => setConfirmDel(true)}><TrashGlyph /></button>
                </>
              )}
            </span>
          </>
        )}
      </div>
      {open && <DirContents sessionId={sessionId} path={path} prefix={[...prefix, !isLast]} onOpen={onOpen} onError={onError} />}
    </>
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
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.listFiles(session.id, '').then((r) => setRootLabel(r.root)).catch(() => {}); }, [session.id]);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    for (const f of Array.from(files)) {
      try { await api.uploadFile(session.id, root, f); } catch { /* skip */ }
    }
    setBusy(false);
    setReloadKey((k) => k + 1);
  };

  // A new folder lands in whichever folder the tree is currently rooted at.
  const createFolder = (name: string) => {
    setCreating(false);
    api.createFolder(session.id, root, name)
      .then(() => { setErr(''); setReloadKey((k) => k + 1); })
      .catch((e) => setErr(e.message));
  };

  // Navigating away drops a stale "already exists" / "that folder is …" notice.
  const goto = (p: string) => { setErr(''); setCreating(false); setRoot(p); };
  const up = () => goto(root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '');
  const crumbs = ['', ...root.split('/').filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join('/'))];
  const here = root ? root.split('/').pop() : rootLabel;

  return (
    <div className={`slot${focused ? ' focused' : ''}`} onMouseDown={onFocus}>
      {/* One compact bar: logo, navigation, new folder, upload, close — no title. */}
      <div
        className={`pane-head files-head${dragId ? ' draggable' : ''}`}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
      >
        <Logo cli="files" size={16} tint="#d99a2b" />
        <button className="mini-btn" title="Up" disabled={!root} onClick={up}><UpGlyph /></button>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c || 'root'}>
              {i > 0 && <span className="sep">/</span>}
              <button className="crumb" onClick={() => goto(c)}>{i === 0 ? rootLabel : c.split('/').pop()}</button>
            </span>
          ))}
        </div>
        <span className="spacer" />
        <button className="mini-btn" title={`New folder in ${here}`} onClick={(e) => { e.stopPropagation(); setCreating(true); }}>
          <PlusGlyph /> Folder
        </button>
        <label className="mini-btn upload-btn" title="Upload files">
          <UploadGlyph /> Upload
          <input type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
        </label>
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
      </div>

      <div
        className={`files-body tree${dragOver ? ' drag' : ''}`}
        style={{ fontSize: `${(13 * zoom) / 100}px` }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
      >
        {creating && (
          <div className="tree-row folder" style={padFor([])}>
            <FolderGlyph className="tw-ico" />
            <NameInput init="" onCommit={createFolder} onCancel={() => setCreating(false)} />
          </div>
        )}
        <DirContents key={`${root}:${reloadKey}`} sessionId={session.id} path={root} prefix={[]} onOpen={goto} onError={setErr} />
        {busy && <div className="tree-msg">Uploading…</div>}
      </div>

      {err
        ? <div className="files-hint err">{err}</div>
        : <div className="files-hint">Click a folder to expand · double-click to open it · double-click a file to download</div>}
    </div>
  );
}
