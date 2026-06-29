import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../types';
import * as api from '../api';
import type { FileEntry } from '../api';
import Logo from './Logo';

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export default function FilesPane({
  session, focused, onFocus, onClose,
}: {
  session: Session;
  focused?: boolean;
  onFocus?: () => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState('');
  const [rootLabel, setRootLabel] = useState('workspace');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: string) => {
    try {
      const r = await api.listFiles(session.id, p);
      setEntries(r.entries);
      setPath(r.path);
      setRootLabel(r.root);
      setErr(null);
    } catch {
      setErr('Could not read folder');
    }
  }, [session.id]);

  useEffect(() => { load(''); }, [load]);

  const up = () => load(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    for (const f of Array.from(files)) {
      try { await api.uploadFile(session.id, path, f); } catch { /* skip */ }
    }
    setBusy(false);
    load(path);
  };

  const crumbs = ['', ...path.split('/').filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join('/'))];

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
        <button className="mini-btn" title="Up" disabled={!path} onClick={up}>↑</button>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c || 'root'}>
              {i > 0 && <span className="sep">/</span>}
              <button className="crumb" onClick={() => load(c)}>{i === 0 ? rootLabel : c.split('/').pop()}</button>
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
        className={`files-body${dragOver ? ' drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
      >
        {err && <div className="files-empty">{err}</div>}
        {!err && entries.length === 0 && <div className="files-empty">Empty folder — drop files here or use Upload.</div>}
        {entries.map((e) => (
          e.dir ? (
            <div key={e.name} className="file-row" onClick={() => load(join(path, e.name))}>
              <span className="fi dir">▸</span><span className="fname">{e.name}</span><span className="fsize">—</span>
            </div>
          ) : (
            <a key={e.name} className="file-row" href={api.downloadUrl(session.id, join(path, e.name))} download>
              <span className="fi">·</span><span className="fname">{e.name}</span><span className="fsize">{fmtSize(e.size)}</span>
            </a>
          )
        ))}
        {busy && <div className="files-empty">Uploading…</div>}
      </div>
    </div>
  );
}
