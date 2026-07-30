import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { FileEntry } from '../api';
import Logo from './Logo';
import { FolderGlyph, FileGlyph, CloseGlyph, UpGlyph, UploadGlyph, PlusGlyph, PencilGlyph, TrashGlyph, MoveGlyph } from './icons';

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const sortEntries = (es: FileEntry[]) =>
  [...es].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

const triggerDownload = (url: string, name: string) => {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
};

// An entry on its way somewhere else — dragged, or picked with the move button
// (touch has no drag). Both routes end in the same move() with the same rules.
interface Moving { path: string; name: string; dir: boolean }

// Our own drag flavour, so a folder can tell an entry coming from this tree from
// an OS file drop and treat them differently (move vs upload).
const ENTRY_MIME = 'application/x-agent-manager-entry';

// Where an entry may land: not back where it already is, and — for a folder —
// not inside itself, which would take the folder with it.
const canDrop = (m: Moving, destDir: string) =>
  parentOf(m.path) !== destDir && !(m.dir && (destDir === m.path || destDir.startsWith(`${m.path}/`)));

// The whole tree talks to the pane through this: rows are recursive and every
// one of them can rename, delete, and accept a drop, so threading callbacks
// through each level would mean passing eight props down N levels.
interface TreeApi {
  sessionId: string;
  open: (p: string) => void;               // re-root the tree here
  fail: (msg: string) => void;             // into the hint bar
  // Re-read one directory listing wherever it sits in the tree. A move touches
  // two of them (source parent, destination), which is why refreshes travel on
  // a bus instead of a callback to the immediate parent.
  refresh: (dir: string) => void;
  subscribe: (dir: string, fn: () => void) => () => void;
  upload: (dir: string, files: FileList | File[]) => void;
  drag: Moving | null;                     // HTML5 drag in flight
  setDrag: (m: Moving | null) => void;
  dropDir: string | null;                  // the folder the drag is hovering
  setDropDir: (p: string | null) => void;
  picked: Moving | null;                   // move-by-button, awaiting a target
  pick: (m: Moving | null) => void;
  move: (m: Moving, destDir: string) => void;
}
const TreeCtx = createContext<TreeApi | null>(null);
const useTree = () => useContext(TreeCtx)!;

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

// Inline field for naming a new folder or renaming an entry. Enter commits,
// Escape cancels, blur commits — and `done` keeps the blur that follows a
// keypress from committing (or cancelling) a second time.
function NameInput({ init, placeholder = 'folder name', onCommit, onCancel }: {
  init: string; placeholder?: string; onCommit: (name: string) => void; onCancel: () => void;
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
      autoFocus className="tw-input" value={value} spellCheck={false} placeholder={placeholder}
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

// Lazily-loaded contents of one directory; recurses through EntryRow. Re-reads
// when the pane's refresh bus names this path.
function DirContents({ path, prefix }: { path: string; prefix: boolean[] }) {
  const { sessionId, subscribe } = useTree();
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => subscribe(path, () => setNonce((n) => n + 1)), [subscribe, path]);
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
      {arr.map((e, i) => (
        <EntryRow
          key={e.name} entry={e} path={join(path, e.name)} prefix={prefix} isLast={i === arr.length - 1}
        />
      ))}
    </>
  );
}

// One row, file or folder. A folder single-clicks to expand inline and
// double-clicks to become the new tree root (a short timer disambiguates the
// two); a file double-clicks to download. Rename, move, and delete ride the row
// on hover; delete asks first, since nothing here is undoable.
function EntryRow({ entry, path, prefix, isLast }: {
  entry: FileEntry; path: string; prefix: boolean[]; isLast: boolean;
}) {
  const t = useTree();
  const dir = entry.dir;
  const kind = dir ? 'folder' : 'file';
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // While a row is being renamed or is asking about a delete, its gestures are
  // off — a click near the buttons must not also expand or re-root the tree.
  const held = editing || confirmDel;
  const onClick = () => {
    if (held || !dir || timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; setOpen((o) => !o); }, 200);
  };
  const onDoubleClick = () => {
    if (held) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (dir) t.open(path);
    else triggerDownload(api.downloadUrl(t.sessionId, path), entry.name);
  };

  // The parent listing owns this row, so it's the one that has to re-read.
  const settle = (p: Promise<unknown>) =>
    p.then(() => { t.fail(''); t.refresh(parentOf(path)); }).catch((e) => t.fail(e.message));
  const rename = (next: string) => { setEditing(false); settle(api.renameEntry(t.sessionId, path, next)); };
  const remove = () => { setConfirmDel(false); settle(api.deleteEntry(t.sessionId, path)); };

  // Folders take drops: an entry from this tree moves into them, OS files
  // upload into them. A file row is not a container, so it lets the drag fall
  // through to the body, which stands for the folder the tree is rooted at.
  const onDragOver = (e: React.DragEvent) => {
    const inside = !!t.drag;
    if (!dir || !(inside || e.dataTransfer.types.includes('Files'))) return;
    e.stopPropagation();                        // a folder owns the hover, even to refuse it
    if (inside && !canDrop(t.drag!, path)) { t.setDropDir(null); return; }
    e.preventDefault();                         // only now is it a drop target
    e.dataTransfer.dropEffect = inside ? 'move' : 'copy';
    t.setDropDir(path);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    t.setDropDir(null);
    if (t.drag) t.move(t.drag, path);           // move() re-checks where it may land
    else if (e.dataTransfer.files.length) t.upload(path, e.dataTransfer.files);
  };

  // A picked entry turns every eligible folder into a one-click destination —
  // the touch route to the same move, where no drag is possible.
  const target = t.picked && dir && canDrop(t.picked, path) ? t.picked : null;
  const mine = t.picked?.path === path || t.drag?.path === path;

  return (
    <>
      <div
        className={`tree-row ${kind}${t.dropDir === path ? ' drop' : ''}${mine ? ' lifted' : ''}`}
        style={padFor(prefix)}
        draggable={!held}
        onDragStart={(e) => {
          if (held) return;
          e.stopPropagation();                  // not the pane's own header drag
          e.dataTransfer.setData(ENTRY_MIME, path);
          e.dataTransfer.effectAllowed = 'move';
          t.setDrag({ path, name: entry.name, dir });
        }}
        onDragEnd={() => { t.setDrag(null); t.setDropDir(null); }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title={dir ? 'Click to expand · double-click to open · drag to move' : 'Double-click to download · drag to move'}
      >
        <Rails prefix={prefix} isLast={isLast} />
        {dir ? <FolderGlyph className="tw-ico" open={open} /> : <FileGlyph className="tw-ico" />}
        {editing ? (
          <NameInput init={entry.name} placeholder={`${kind} name`} onCommit={rename} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <span className="tw-name">{entry.name}</span>
            {!dir && <span className="tw-size">{fmtSize(entry.size)}</span>}
            {/* the row's expand/open gestures must not fire from these buttons */}
            <span
              className={`tw-actions${confirmDel || target ? ' open' : ''}`}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {confirmDel ? (
                <>
                  <span className="tw-warn">{dir ? 'Delete folder and everything in it?' : 'Delete file?'}</span>
                  <button className="mini-btn danger" onClick={remove}>Delete</button>
                  <button className="mini-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
                </>
              ) : target ? (
                <button className="mini-btn accent" onClick={() => t.move(target, path)}>Move here</button>
              ) : !t.picked && (
                <>
                  <button className="mini-btn" title={`Rename ${kind}`} onClick={() => setEditing(true)}><PencilGlyph /></button>
                  <button className="mini-btn" title={`Move ${kind}`} onClick={() => t.pick({ path, name: entry.name, dir })}><MoveGlyph /></button>
                  <button className="mini-btn" title={`Delete ${kind}`} onClick={() => setConfirmDel(true)}><TrashGlyph /></button>
                </>
              )}
            </span>
          </>
        )}
      </div>
      {dir && open && <DirContents path={path} prefix={[...prefix, !isLast]} />}
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
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState<Moving | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [picked, setPicked] = useState<Moving | null>(null);

  useEffect(() => { api.listFiles(session.id, '').then((r) => setRootLabel(r.root)).catch(() => {}); }, [session.id]);

  // Directory listings subscribe by path so an edit can re-read exactly the
  // ones it touched, leaving the rest of the expanded tree where it was.
  const subs = useRef(new Map<string, Set<() => void>>());
  const subscribe = useCallback((dir: string, fn: () => void) => {
    const at = subs.current.get(dir) ?? new Set<() => void>();
    subs.current.set(dir, at);
    at.add(fn);
    return () => { at.delete(fn); if (!at.size) subs.current.delete(dir); };
  }, []);
  const refresh = useCallback((dir: string) => { subs.current.get(dir)?.forEach((fn) => fn()); }, []);

  const upload = useCallback(async (dir: string, files: FileList | File[]) => {
    setBusy(true);
    for (const f of Array.from(files)) {
      try { await api.uploadFile(session.id, dir, f); } catch { /* skip */ }
    }
    setBusy(false);
    refresh(dir);
  }, [session.id, refresh]);

  const move = useCallback((m: Moving, destDir: string) => {
    setDrag(null); setDropDir(null); setPicked(null);
    if (!canDrop(m, destDir)) return;
    api.moveEntry(session.id, m.path, destDir)
      .then(() => { setErr(''); refresh(parentOf(m.path)); refresh(destDir); })
      .catch((e) => setErr(e.message));
  }, [session.id, refresh]);

  // A new folder lands in whichever folder the tree is currently rooted at.
  const createFolder = (name: string) => {
    setCreating(false);
    api.createFolder(session.id, root, name)
      .then(() => { setErr(''); refresh(root); })
      .catch((e) => setErr(e.message));
  };

  // Navigating away drops a stale "already exists" / "that folder is …" notice.
  const goto = (p: string) => { setErr(''); setCreating(false); setRoot(p); };
  const up = () => goto(root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '');
  const crumbs = ['', ...root.split('/').filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join('/'))];
  const here = root ? root.split('/').pop() : rootLabel;

  // Crumbs are drop targets too: rooted deep in the tree, they're the only way
  // to send something back up without navigating there first.
  const crumbDnd = (c: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag || !canDrop(drag, c)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropDir(c);
    },
    onDrop: (e: React.DragEvent) => { if (drag) { e.preventDefault(); move(drag, c); } },
  });

  const tree: TreeApi = {
    sessionId: session.id, open: goto, fail: setErr, refresh, subscribe, upload,
    drag, setDrag, dropDir, setDropDir, picked, pick: setPicked, move,
  };

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
              <button
                /* the current root is the body's target, not the crumb's */
                className={`crumb${drag && dropDir === c && c !== root ? ' drop' : ''}`}
                onClick={() => goto(c)}
                {...crumbDnd(c)}
              >
                {i === 0 ? rootLabel : c.split('/').pop()}
              </button>
            </span>
          ))}
        </div>
        <span className="spacer" />
        {picked && canDrop(picked, root) && (
          <button className="mini-btn accent" title={`Move ${picked.name} into ${here}`} onClick={(e) => { e.stopPropagation(); move(picked, root); }}>
            <MoveGlyph /> Move here
          </button>
        )}
        <button className="mini-btn" title={`New folder in ${here}`} onClick={(e) => { e.stopPropagation(); setCreating(true); }}>
          <PlusGlyph /> Folder
        </button>
        <label className="mini-btn upload-btn" title={`Upload into ${here}`}>
          <UploadGlyph /> Upload
          <input type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(root, e.target.files); e.target.value = ''; }} />
        </label>
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
      </div>

      <TreeCtx.Provider value={tree}>
        {/* Anything dropped on the background — an OS file, or an entry from
            deeper in the tree — belongs to the folder the tree is rooted at. */}
        <div
          className={`files-body tree${dropDir === root ? ' drag' : ''}`}
          style={{ fontSize: `${(13 * zoom) / 100}px` }}
          onDragOver={(e) => {
            if (drag && !canDrop(drag, root)) { setDropDir(null); return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = drag ? 'move' : 'copy';
            setDropDir(root);
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDir(null); }}
          onDrop={(e) => {
            e.preventDefault();
            setDropDir(null);
            if (drag) move(drag, root);
            else if (e.dataTransfer.files.length) upload(root, e.dataTransfer.files);
          }}
        >
          {creating && (
            <div className="tree-row folder" style={padFor([])}>
              <FolderGlyph className="tw-ico" />
              <NameInput init="" onCommit={createFolder} onCancel={() => setCreating(false)} />
            </div>
          )}
          <DirContents key={root} path={root} prefix={[]} />
          {busy && <div className="tree-msg">Uploading…</div>}
        </div>
      </TreeCtx.Provider>

      {err ? <div className="files-hint err">{err}</div>
        : picked ? (
          <div className="files-hint moving">
            <span>Moving <b>{picked.name}</b> — pick a destination folder</span>
            <button className="mini-btn" onClick={() => setPicked(null)}>Cancel</button>
          </div>
        ) : (
          <div className="files-hint">Click to expand · double-click to open or download · drag into a folder to move</div>
        )}
    </div>
  );
}
