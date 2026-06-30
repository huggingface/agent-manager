import { useEffect, useRef, useState } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { FileEntry } from '../api';
import Logo from './Logo';
import { FolderGlyph, FileGlyph } from './icons';

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

// Lazily-loaded contents of one directory; recurses through FolderNode. Nesting
// is structural (each level wrapped in .tree-children) so the indent guide lines
// come for free.
function DirContents({ sessionId, path, onOpen }: {
  sessionId: string; path: string; onOpen: (p: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    api.listFiles(sessionId, path)
      .then((r) => { if (alive) { setEntries(r.entries); setErr(false); } })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [sessionId, path]);

  if (err) return <div className="tree-msg">can't read folder</div>;
  if (!entries) return <div className="tree-msg">…</div>;
  if (entries.length === 0) return <div className="tree-msg">empty</div>;

  return (
    <>
      {sortEntries(entries).map((e) => (e.dir ? (
        <FolderNode key={e.name} sessionId={sessionId} path={join(path, e.name)} name={e.name} onOpen={onOpen} />
      ) : (
        <div
          key={e.name}
          className="tree-row file"
          onDoubleClick={() => triggerDownload(api.downloadUrl(sessionId, join(path, e.name)), e.name)}
          title="Double-click to download"
        >
          <span className="tw-caret" />
          <FileGlyph className="tw-ico" />
          <span className="tw-name">{e.name}</span>
          <span className="tw-size">{fmtSize(e.size)}</span>
        </div>
      )))}
    </>
  );
}

// A folder row: single click toggles inline expand, double click opens it as the
// new tree root (breadcrumb navigation). A short timer disambiguates the two.
function FolderNode({ sessionId, path, name, onOpen }: {
  sessionId: string; path: string; name: string; onOpen: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      <div className="tree-row folder" onClick={onClick} onDoubleClick={onDoubleClick} title="Click to expand · double-click to open">
        <span className={`tw-caret${open ? ' open' : ''}`}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4" /></svg>
        </span>
        <FolderGlyph className="tw-ico" />
        <span className="tw-name">{name}</span>
      </div>
      {open && <div className="tree-children"><DirContents sessionId={sessionId} path={path} onOpen={onOpen} /></div>}
    </>
  );
}

export default function FilesPane({
  session, focused, zoom = 100, onFocus, onClose,
}: {
  session: Session;
  focused?: boolean;
  zoom?: number;
  onFocus?: () => void;
  onClose: () => void;
}) {
  const [root, setRoot] = useState('');
  const [rootLabel, setRootLabel] = useState('workspace');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => { api.listFiles(session.id, '').then((r) => setRootLabel(r.root)).catch(() => {}); }, [session.id]);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    for (const f of Array.from(files)) {
      try { await api.uploadFile(session.id, root, f); } catch { /* skip */ }
    }
    setBusy(false);
    setReloadKey((k) => k + 1);
  };

  const up = () => setRoot(root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '');
  const crumbs = ['', ...root.split('/').filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join('/'))];

  return (
    <div className={`slot${focused ? ' focused' : ''}`} onMouseDown={onFocus}>
      <div className="pane-head">
        <div className="ph-left">
          <Logo cli="files" size={20} />
          <span className="status idle" />
        </div>
        <span className="ph-title">{session.name}</span>
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
      </div>

      <div className="files-bar">
        <button className="mini-btn" title="Up" disabled={!root} onClick={up}>↑</button>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c || 'root'}>
              {i > 0 && <span className="sep">/</span>}
              <button className="crumb" onClick={() => setRoot(c)}>{i === 0 ? rootLabel : c.split('/').pop()}</button>
            </span>
          ))}
        </div>
        <span className="spacer" />
        <label className="mini-btn upload-btn" title="Upload files">
          ↥ Upload
          <input type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      <div
        className={`files-body tree${dragOver ? ' drag' : ''}`}
        style={{ fontSize: `${(13 * zoom) / 100}px` }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
      >
        <DirContents key={`${root}:${reloadKey}`} sessionId={session.id} path={root} onOpen={setRoot} />
        {busy && <div className="tree-msg">Uploading…</div>}
      </div>

      <div className="files-hint">Click a folder to expand · double-click to open it · double-click a file to download</div>
    </div>
  );
}
