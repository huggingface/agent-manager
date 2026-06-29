import { useState } from 'react';
import type { Cli } from '../types';

export default function NewSession({
  clis, onCreate, onCancel,
}: {
  clis: Cli[];
  onCreate: (name: string, cli: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const firstAvail = clis.find((c) => c.available)?.id || 'shell';
  const [cli, setCli] = useState(firstAvail);
  const submit = () => { onCreate(name.trim(), cli); setName(''); };

  return (
    <div className="widget">
      <input
        autoFocus
        placeholder="Agent name (e.g. refactor-api)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel?.(); }}
      />
      <select value={cli} onChange={(e) => setCli(e.target.value)}>
        {clis.map((c) => (
          <option key={c.id} value={c.id} disabled={!c.available}>
            {c.label}{c.available ? '' : ' — unavailable'}
          </option>
        ))}
      </select>
      <div className="widget-actions">
        <button className="btn-primary" onClick={submit}>Create agent</button>
        {onCancel && <button className="btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
