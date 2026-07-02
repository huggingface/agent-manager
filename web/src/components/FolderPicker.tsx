import { useEffect, useState } from 'react';
import * as api from '../api';
import { FolderGlyph } from './icons';

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
// Folder names are typed freely; just strip separators and traversal.
const cleanName = (s: string) => s.replace(/[/\\]/g, '').replace(/\.\./g, '').trim();

// Inline "+ new folder" row shown at the end of every level, so a fresh
// subfolder anywhere in the tree is one click + type away.
function NewFolderRow({ base, depth, onPick }: {
  base: string; depth: number; onPick: (p: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const commit = () => {
    const n = cleanName(name);
    if (n) onPick(join(base, n));
    setAdding(false); setName('');
  };
  if (!adding) {
    return (
      <button className="fp-row fp-new" style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => setAdding(true)}>
        + new folder…
      </button>
    );
  }
  return (
    <div className="fp-row" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
      <input
        autoFocus className="fp-input" placeholder="folder name" value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setAdding(false); setName(''); } }}
      />
    </div>
  );
}

// One level of the workspace folder tree: click a name to pick it as the
// location, click the caret to expand its subfolders.
function Level({ path, depth, value, onPick }: {
  path: string; depth: number; value: string; onPick: (p: string) => void;
}) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    api.listFolders(path).then((r) => { if (alive) setFolders(r.folders); }).catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [path]);

  if (!folders) return <div className="fp-row fp-msg" style={{ paddingLeft: `${depth * 14 + 8}px` }}>…</div>;
  return (
    <>
      {folders.map((f) => {
        const p = join(path, f);
        const expanded = open.has(f);
        return (
          <div key={f}>
            <div className={`fp-row${value === p ? ' picked' : ''}`} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
              <button
                className="fp-caret"
                aria-label={expanded ? 'Collapse' : 'Expand'}
                onClick={() => setOpen((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; })}
              >{expanded ? '▾' : '▸'}</button>
              <FolderGlyph className="fp-ico" open={expanded} />
              <button className="fp-name" onClick={() => onPick(p)}>{f}</button>
            </div>
            {expanded && <Level path={p} depth={depth + 1} value={value} onPick={onPick} />}
          </div>
        );
      })}
      <NewFolderRow base={path} depth={depth} onPick={onPick} />
    </>
  );
}

/**
 * Workspace location picker. `value` is a workspace-relative path; '' means
 * the default (a fresh auto-named folder — or the workspace root for a Files
 * agent). Picking a not-yet-existing folder is fine: the server creates it
 * when the agent is created.
 */
export default function FolderPicker({ value, autoLabel, onChange }: {
  value: string;
  autoLabel: string;
  onChange: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fp">
      <button className="fp-current" onClick={() => setOpen((o) => !o)} title="Choose where this agent runs">
        <FolderGlyph className="fp-ico" open={open} />
        <span className="fp-path">{value || autoLabel}</span>
        <span className="fp-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="fp-tree">
          <button className={`fp-row fp-root${value === '' ? ' picked' : ''}`} onClick={() => onChange('')}>
            {autoLabel}
          </button>
          <Level path="" depth={1} value={value} onPick={(p) => { onChange(p); }} />
        </div>
      )}
    </div>
  );
}
