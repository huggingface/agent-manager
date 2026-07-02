import { useState } from 'react';
import type { Cli, Session } from '../types';
import Logo from './Logo';
import FolderPicker from './FolderPicker';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Next free "<label-slug>-<n>" for this CLI — mirrors the server's nextName so
// the prepopulated value matches what the server would pick anyway.
function defaultName(c: Cli, sessions: Session[]) {
  const base = slug(c.label) || c.id;
  const re = new RegExp(`^${base}-(\\d+)$`);
  let max = 0;
  for (const s of sessions) {
    const m = s.name.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${base}-${max + 1}`;
}

// Creation widget for AI agents. Shell and Files are created via the quick-add
// buttons at the bottom of the sidebar instead (rename after creation).
export default function NewSession({
  clis, sessions, defaultPath = '', onCreate, onCancel,
}: {
  clis: Cli[];
  sessions: Session[];
  defaultPath?: string;
  onCreate: (name: string, cli: string, path: string) => void;
  onCancel?: () => void;
}) {
  const agents = clis.filter((c) => c.available && c.id !== 'shell' && c.id !== 'files');
  const [cli, setCli] = useState(agents[0]?.id || '');
  const [name, setName] = useState(() => (agents[0] ? defaultName(agents[0], sessions) : ''));
  // Prepopulated values follow the selected agent until the user types.
  const [nameDirty, setNameDirty] = useState(false);
  const [loc, setLoc] = useState(defaultPath);
  const sel = agents.find((c) => c.id === cli) || agents[0];

  const pick = (c: Cli) => {
    setCli(c.id);
    if (!nameDirty) setName(defaultName(c, sessions));
  };
  const submit = () => { if (sel) onCreate(name.trim() || sel.label, sel.id, loc); };

  return (
    <div className="widget">
      <div className="agent-picks">
        {agents.map((c) => (
          <button
            key={c.id}
            className={`agent-pick${cli === c.id ? ' on' : ''}`}
            onClick={() => pick(c)}
          >
            <Logo cli={c.id} size={16} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      <div className="widget-sep" />
      <input
        autoFocus
        placeholder="Agent name"
        value={name}
        onChange={(e) => { setName(e.target.value); setNameDirty(e.target.value.trim() !== ''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel?.(); }}
      />
      <FolderPicker value={loc} autoLabel="new folder (auto)" onChange={setLoc} />
      <div className="widget-actions">
        <button className="btn-primary" onClick={submit} disabled={!sel}>Create</button>
      </div>
    </div>
  );
}
