import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { DevPreviewSummary } from '../api';
import { SlidersGlyph } from './icons';

// The build this tab's JavaScript came from. A switch replaces the server and
// the web app; a tab opened before it keeps the old UI until reloaded, and
// must say so rather than pass the old UI off as the new code.
let loadedId: string | null = null;

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');
const TITLE_CHARS = 22;
const clip = (text = '') => (text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text);

/**
 * Which code this dev Space runs, as one compact row under the sidebar logo:
 * "Preview: [#182 Security: keep e… ▾] [settings]". Picking an entry switches
 * to that one PR (or back to main); stacks and the full log live in
 * Settings → Preview. Renders nothing unless the server sent `devPreview`
 * (only when the Space sets AM_DEV_PREVIEW=1), so production never shows it.
 */
export default function DevPreviewBar({ summary, onOpenSettings }: {
  summary: DevPreviewSummary | null | undefined;
  onOpenSettings: () => void;
}) {
  // Faster than /api/info's 15s while a switch this tab started is underway.
  const [live, setLive] = useState<DevPreviewSummary | null>(null);
  const [prs, setPrs] = useState<api.DevPreviewPr[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const watching = useRef<string | null>(null);
  const s = live || summary;

  useEffect(() => {
    if (!summary) return;
    api.getDevPreviewPrs().then((r) => setPrs(r.ok ? r.prs || [] : [])).catch(() => setPrs([]));
  }, [!!summary]);

  const poll = useCallback(async () => {
    try {
      const next = await api.getDevPreviewStatus();
      setLive(next);
      setOffline(false);
      if (watching.current !== null && next.running.id !== watching.current && next.job?.state !== 'running' && !next.restartPending) location.reload();
      if (next.job && (next.job.state === 'failed' || next.job.state === 'refused')) {
        watching.current = null;
        setErr(next.job.error || `switch ${next.job.state}`);
      }
    } catch { setOffline(true); }
  }, []);
  const busy = !!s && (s.job?.state === 'running' || s.restartPending || offline);
  useEffect(() => {
    if (watching.current === null && !busy) return;
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [busy, poll, live]);

  if (!s) return null;
  const { running } = s;
  if (loadedId === null) loadedId = running.id;
  const stale = loadedId !== running.id;

  const current = running.kind === 'main' ? 'main'
    : running.prs.length === 1 && prs?.some((p) => p.number === running.prs[0].number && p.sha === running.prs[0].sha) ? `pr:${running.prs[0].number}`
    : 'running';
  const pick = async (value: string) => {
    if (value === current) return;
    const pr = value.startsWith('pr:') ? prs?.find((p) => `pr:${p.number}` === value) : null;
    const what = pr ? `#${pr.number} (${clip(pr.title)})` : 'main';
    if (!window.confirm(`Switch this Space to ${what}? The app server restarts, and so does every running agent.`)) return;
    setErr(null);
    watching.current = running.id;
    try {
      setLive(pr ? await api.switchDevPreview([{ number: pr.number, sha: pr.sha }]) : await api.rollbackDevPreview());
    } catch (e) { watching.current = null; setErr((e as Error).message); }
  };

  const note = offline ? 'restarting…'
    : s.job?.state === 'running' ? `${s.job.kind === 'rollback' ? 'rolling back' : `switching: ${s.job.step}`}…`
    : s.restartPending ? `restarting into ${s.next?.label ?? 'the new build'}…`
    : err ? err
    : s.crashed ? 'the last preview crashed on start and was rolled back'
    : null;

  return (
    <div className="devpv-bar" data-testid="dev-preview-bar">
      <div className="devpv-bar-row">
        <label className="devpv-bar-k" htmlFor="devpv-pick">Preview:</label>
        <select id="devpv-pick" className="devpv-pick mono" value={current} disabled={busy}
          title={running.kind === 'main' ? 'main (the image build)' : `${running.label}${running.base ? ` on main ${short(running.base)}` : ''}`}
          onChange={(e) => pick(e.target.value)} data-testid="dev-preview-pick">
          <option value="main">main</option>
          {current === 'running' ? <option value="running" disabled>{running.label}</option> : null}
          {(prs || []).map((p) => <option key={p.number} value={`pr:${p.number}`}>#{p.number} {clip(p.title)}</option>)}
        </select>
        <button className="icon-btn devpv-bar-btn" onClick={onOpenSettings} title="Preview settings: stacks, log, rollback"><SlidersGlyph /></button>
      </div>
      {note || stale ? (
        <div className={`devpv-bar-note${err && !busy ? ' bad' : ''}`} data-testid="dev-preview-note">
          {note}
          {stale && !busy ? <>{note ? ' · ' : ''}<button className="devpv-link" onClick={() => location.reload()}>reload for this build's UI</button></> : null}
        </div>
      ) : null}
    </div>
  );
}
