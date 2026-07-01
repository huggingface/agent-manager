import { useState } from 'react';
import type { Cli } from '../types';
import Logo from './Logo';

export default function NewSession({
  clis, onCreate, onCancel,
}: {
  clis: Cli[];
  onCreate: (name: string, cli: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const avail = clis.filter((c) => c.available);
  const [cli, setCli] = useState(avail[0]?.id || 'shell');
  const sel = avail.find((c) => c.id === cli) || avail[0];
  const submit = () => { if (!sel) return; onCreate(name.trim() || sel.label, sel.id); setName(''); };

  return (
    <div className="widget">
      <input
        autoFocus
        placeholder="Agent name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel?.(); }}
      />
      <div className="agent-picks">
        {avail.map((c) => (
          <button
            key={c.id}
            className={`agent-pick${cli === c.id ? ' on' : ''}`}
            onClick={() => setCli(c.id)}
          >
            <Logo cli={c.id} size={16} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      <div className="widget-actions">
        <button className="btn-primary" onClick={submit} disabled={!sel}>Create</button>
      </div>
    </div>
  );
}
