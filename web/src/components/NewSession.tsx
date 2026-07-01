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
  const pick = (c: Cli) => { onCreate(name.trim() || c.label, c.id); setName(''); };

  return (
    <div className="widget">
      <input
        autoFocus
        placeholder="Agent name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.(); }}
      />
      <div className="agent-picks">
        {clis.filter((c) => c.available).map((c) => (
          <button key={c.id} className="agent-pick" title={`New ${c.label}`} onClick={() => pick(c)}>
            <Logo cli={c.id} size={16} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      {onCancel && <button className="btn-ghost" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
