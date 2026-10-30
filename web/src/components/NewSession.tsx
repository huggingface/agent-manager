import { useState } from 'react';
import type { Cli, LaunchChoice, Session } from '../types';
import { creatable } from '../types';
import Logo from './Logo';
import FolderPicker from './FolderPicker';
import LaunchField from './LaunchField';

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

// Creation widget used where the sidebar's own panel is not on screen: adding an
// agent to a group, and the empty-workspace prompt. The sidebar panel offers
// Shell and Files in its second picker row; this one is agents only.
export default function NewSession({
  clis, sessions, defaultPath = '.', onCreate, onCancel,
}: {
  clis: Cli[];
  sessions: Session[];
  defaultPath?: string;
  onCreate: (name: string, cli: string, path: string, launch?: LaunchChoice) => void;
  onCancel?: () => void;
}) {
  // 'trace' is excluded like shell/files: a trace pane is opened FROM a session
  // (the Trace button on its row), never created blank — one with no source
  // would have nothing to show.
  const agents = creatable(clis).filter((c) => c.available && c.id !== 'shell' && c.id !== 'files' && c.id !== 'trace');
  const [cli, setCli] = useState(agents[0]?.id || '');
  const [name, setName] = useState(() => (agents[0] ? defaultName(agents[0], sessions) : ''));
  // Prepopulated values follow the selected agent until the user types.
  const [nameDirty, setNameDirty] = useState(false);
  const [loc, setLoc] = useState(defaultPath || '.');
  const [launch, setLaunch] = useState<LaunchChoice>({});
  const sel = agents.find((c) => c.id === cli) || agents[0];

  const pick = (c: Cli) => {
    if (c.id !== cli) setLaunch({});
    setCli(c.id);
    if (!nameDirty) setName(defaultName(c, sessions));
  };
  const submit = () => { if (sel) onCreate(name.trim() || sel.label, sel.id, loc || '.', launch); };

  return (
    <div className="widget">
      <div className="w-field">
        <span className="w-label">Agent</span>
        <div className="agent-picks">
          {agents.map((c) => (
            <button
              key={c.id}
              className={`agent-pick${cli === c.id ? ' on' : ''}`}
              onClick={() => pick(c)}
            >
              <Logo cli={c.id} size={13} />
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="w-field">
        <span className="w-label">Name</span>
        <input
          autoFocus
          placeholder="Agent name"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameDirty(e.target.value.trim() !== ''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel?.(); }}
        />
      </div>
      <div className="w-field">
        <span className="w-label">Folder</span>
        <FolderPicker value={loc} onChange={setLoc} />
      </div>
      {sel?.launch && (sel.launch.model || sel.launch.effort) && (
        <div className="w-field">
          <span className="w-label">Model</span>
          <LaunchField cli={sel} value={launch} onChange={setLaunch} />
        </div>
      )}
      <div className="widget-actions">
        <button className="btn-primary" onClick={submit} disabled={!sel}>Create</button>
      </div>
    </div>
  );
}
