// Model and reasoning effort for a new agent: two selects under the folder in
// the create panels. Loaded on demand (Sidebar.tsx), so the entry bundle does
// not carry it.
//
// The options are what the CLI itself offered when the server last asked it
// (GET /api/launch-options): no free text, because the server only accepts an
// id from that list. Empty = the CLI's default, so leaving both alone launches
// exactly as before. Where the CLI reports levels per model (Codex), the effort
// select follows the chosen model.
//
// One catalog is shared by every mounted picker. It is asked again each time a
// picker opens, and every few seconds while the server is still building the
// lists (right after boot, or a refresh), so a list that arrives later shows
// up without a reload. Whenever the catalog changes, a choice it no longer
// offers is cleared through onChange, so what is shown is what is sent.
import { useEffect, useState } from 'react';
import { decodeResponse } from '../apiResponse';
import type { LaunchChoice, LaunchOptions } from '../types';
import { RefreshGlyph } from './icons';

// Here rather than in api.ts, so they stay out of the entry bundle too.
const getOptions = (): Promise<LaunchOptions> => fetch('/api/launch-options').then((r) => decodeResponse(r));
const refreshOptions = (): Promise<LaunchOptions> => fetch('/api/launch-options/refresh', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
}).then((r) => decodeResponse(r));

const POLL_MS = 3000;
let current: LaunchOptions | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;
let poll: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function settle(next: LaunchOptions) {
  current = next; lastError = null; notify();
  if (poll) clearTimeout(poll);
  poll = next.refreshing && listeners.size ? setTimeout(() => { poll = null; void revalidate(); }, POLL_MS) : null;
}
function revalidate(): Promise<void> {
  inflight ??= getOptions().then(settle, (e) => { lastError = message(e, 'could not load the model lists'); notify(); })
    .finally(() => { inflight = null; });
  return inflight;
}

export default function LaunchPicker({ cli, canModel, value, onChange, disabled }: {
  cli: string;
  canModel: boolean;
  value: LaunchChoice;
  onChange: (next: LaunchChoice) => void;
  disabled?: boolean;
}) {
  const [, rerender] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    void revalidate();
    return () => {
      listeners.delete(listener);
      if (!listeners.size && poll) { clearTimeout(poll); poll = null; }
    };
  }, []);

  const opts = current;
  const entry = opts?.clis.find((c) => c.id === cli);
  const effortsFor = (model?: string) => {
    if (!entry) return [];
    if (!entry.perModelEfforts) return entry.efforts || [];
    const m = entry.models.find((x) => x.id === model);
    return m ? m.efforts || [] : [...new Set(entry.models.flatMap((x) => x.efforts || []))];
  };

  // Keep the choice inside what the catalog offers now.
  useEffect(() => {
    if (!opts) return;
    const model = value.model && entry?.models.some((m) => m.id === value.model) ? value.model : undefined;
    const effort = value.effort && effortsFor(model).includes(value.effort) ? value.effort : undefined;
    if (model !== value.model || effort !== value.effort) onChange({ ...value, model, effort });
  });

  const refresh = async () => {
    setRefreshing(true);
    try { settle(await refreshOptions()); } catch (e) { lastError = message(e, 'could not refresh the model lists'); notify(); }
    finally { setRefreshing(false); }
  };
  const busy = refreshing || !!opts?.refreshing;
  const refreshButton = (
    <button type="button" className="mini-btn launch-refresh" disabled={disabled || refreshing}
      title={busy ? 'Asking the CLIs…' : 'Ask the CLIs for their model lists again'} aria-label="Refresh model lists"
      onClick={() => { void refresh(); }}>
      <RefreshGlyph className={busy ? 'spin' : undefined} />
    </button>
  );
  const errorLine = lastError && <div className="launch-pick-err mono">{lastError}</div>;
  if (!opts) return errorLine ? <div className="launch-pick">{refreshButton}{errorLine}</div> : null;

  const models = entry?.models || [];
  const efforts = effortsFor(value.model);
  const chosen = models.find((m) => m.id === value.model);
  const title = entry?.source ? `Models from ${entry.source}${entry.at ? `, ${new Date(entry.at).toLocaleString()}` : ''}` : undefined;
  const setModel = (model: string) => {
    const next: LaunchChoice = { ...value, model: model || undefined };
    // A level the new model does not have would be refused on create.
    if (next.effort && !effortsFor(next.model).includes(next.effort)) next.effort = undefined;
    onChange(next);
  };

  return (
    <div className="launch-pick">
      {canModel && (models.length ? (
        <select aria-label="Model" title={title} value={value.model || ''} disabled={disabled} onChange={(e) => setModel(e.target.value)}>
          <option value="">Model: CLI default</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
        </select>
      ) : (
        // No list (yet): the CLI default, and the way to ask again.
        <select aria-label="Model" disabled title={entry?.error || undefined} value="">
          <option value="">{busy ? 'Model: listing…' : 'Model: CLI default (no list)'}</option>
        </select>
      ))}
      {efforts.length > 0 && (
        <select aria-label="Reasoning effort" value={value.effort || ''} disabled={disabled}
          onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}>
          <option value="">Effort: default{chosen?.defaultEffort ? ` (${chosen.defaultEffort})` : ''}</option>
          {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      )}
      {refreshButton}
      {errorLine}
    </div>
  );
}
