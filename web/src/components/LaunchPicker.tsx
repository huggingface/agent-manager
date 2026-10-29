// Model and reasoning effort for a new agent: two selects under the folder in
// the create panels. Loaded on demand (Sidebar.tsx), so the entry bundle does
// not carry it.
//
// The options are what the CLI itself offered when the server last asked it
// (GET /api/launch-options): no free text, because the server only accepts an
// id from that list. Empty = the CLI's default, so leaving both alone launches
// exactly as before. Where the CLI reports levels per model (Codex), the effort
// select follows the chosen model.
import { useEffect, useState } from 'react';
import { decodeResponse } from '../apiResponse';
import type { LaunchChoice, LaunchOptions } from '../types';
import { RefreshGlyph } from './icons';

// Here rather than in api.ts, so they stay out of the entry bundle too.
const getOptions = (): Promise<LaunchOptions> => fetch('/api/launch-options').then((r) => decodeResponse(r));
const refreshOptions = (): Promise<LaunchOptions> => fetch('/api/launch-options/refresh', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
}).then((r) => decodeResponse(r));

// One fetch per page load, shared by every panel; a refresh replaces it.
let shared: Promise<LaunchOptions> | null = null;
const load = () => (shared ??= getOptions().catch((error) => { shared = null; throw error; }));

export default function LaunchPicker({ cli, value, onChange, disabled }: {
  cli: string;
  value: LaunchChoice;
  onChange: (next: LaunchChoice) => void;
  disabled?: boolean;
}) {
  const [opts, setOpts] = useState<LaunchOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let alive = true;
    load().then((o) => { if (alive) setOpts(o); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'could not load the model lists'); });
    return () => { alive = false; };
  }, []);

  const entry = opts?.clis.find((c) => c.id === cli);
  const refresh = async () => {
    setRefreshing(true); setError(null);
    try {
      const next = refreshOptions();
      shared = next;
      setOpts(await next);
    } catch (e) {
      shared = null;
      setError(e instanceof Error ? e.message : 'could not refresh the model lists');
    } finally { setRefreshing(false); }
  };
  if (!entry) return error ? <div className="launch-pick-err mono">{error}</div> : null;

  const chosen = entry.models.find((m) => m.id === value.model);
  const effortsFor = (model?: string) => {
    if (!entry.perModelEfforts) return entry.efforts || [];
    const m = entry.models.find((x) => x.id === model);
    return m ? m.efforts || [] : [...new Set(entry.models.flatMap((x) => x.efforts || []))];
  };
  const efforts = effortsFor(value.model);
  if (!entry.model && !efforts.length) return null;
  const setModel = (model: string) => {
    const next: LaunchChoice = { ...value, model: model || undefined };
    // A level the new model does not have would be refused on create.
    if (next.effort && !effortsFor(next.model).includes(next.effort)) next.effort = undefined;
    onChange(next);
  };
  const title = entry.source ? `Models from ${entry.source}${entry.at ? `, ${new Date(entry.at).toLocaleString()}` : ''}` : undefined;

  return (
    <div className="launch-pick">
      {entry.model && (
        <select aria-label="Model" title={title} value={value.model || ''} disabled={disabled} onChange={(e) => setModel(e.target.value)}>
          <option value="">Model: CLI default</option>
          {entry.models.map((m) => (
            <option key={m.id} value={m.id}>{m.label || m.id}</option>
          ))}
        </select>
      )}
      {efforts.length > 0 && (
        <select aria-label="Reasoning effort" value={value.effort || ''} disabled={disabled}
          onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}>
          <option value="">Effort: default{chosen?.defaultEffort ? ` (${chosen.defaultEffort})` : ''}</option>
          {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      )}
      <button type="button" className="mini-btn launch-refresh" disabled={disabled || refreshing}
        title={refreshing ? 'Asking the CLIs…' : 'Ask the CLIs for their model lists again'} aria-label="Refresh model lists"
        onClick={() => { void refresh(); }}>
        <RefreshGlyph className={refreshing ? 'spin' : undefined} />
      </button>
      {error && <div className="launch-pick-err mono">{error}</div>}
    </div>
  );
}
