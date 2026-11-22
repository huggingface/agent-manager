import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/devPreviewApi';
import type { DevPreviewSummary } from '../api';
import { SlidersGlyph } from './icons';
import { canPullLatest, compareRunning, newCommitsText, switchConfirmText, type DevPreviewPrList } from '../lib/devPreview';

// The panel (Settings → General) takes these through this module, so the row
// and the panel share one chunk and the entry maps only that one.
export * from '../lib/devPreviewApi';
export { canPullLatest, compareRunning, prList, switchConfirmText } from '../lib/devPreview';

// The build this tab's JavaScript came from. A switch replaces the server and
// the web app; a tab opened before it keeps the old UI until reloaded, and
// must say so rather than pass the old UI off as the new code.
let loadedId: string | null = null;

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');
const TITLE_CHARS = 22;
// How often the row re-reads the PR list while the tab is visible, so it can
// say a running PR (or main) has new commits. The server caches the list for 20 s.
const PRS_EVERY_MS = 60_000;
const clip = (text = '') => (text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text);

/**
 * Which code this dev Space runs, as one compact row under the sidebar logo:
 * "Preview: [#182 Security: keep e… ▾] [settings]". Picking an entry switches
 * to that one PR (or back to main); stacks and the full log live in
 * Settings → General (Dev preview). Renders nothing unless the server sent `devPreview`
 * (only when the Space sets AM_DEV_PREVIEW=1), so production never shows it.
 */
export default function DevPreviewBar({ summary, onOpenSettings }: {
  summary: DevPreviewSummary | null | undefined;
  onOpenSettings: () => void;
}) {
  // Faster than /api/info's 15s while a switch this tab started is underway.
  const [live, setLive] = useState<DevPreviewSummary | null>(null);
  const [list, setList] = useState<DevPreviewPrList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const watching = useRef<string | null>(null);
  const s = live || summary;

  // On mount, every PRS_EVERY_MS while the tab is visible, and when it comes
  // back into view. A failed read keeps the last good list.
  const loadingPrs = useRef(false);
  const loadPrs = useCallback(async () => {
    if (loadingPrs.current) return;
    loadingPrs.current = true;
    let next: DevPreviewPrList = { ok: false };
    try { next = await api.getDevPreviewPrs(); } catch { /* keep the last list */ }
    loadingPrs.current = false;
    setList((cur) => (next.ok && Array.isArray(next.prs) ? next : cur || { ok: false, prs: [] }));
  }, []);
  useEffect(() => {
    if (!summary) return;
    loadPrs();
    const visible = () => document.visibilityState === 'visible';
    const t = setInterval(() => { if (visible()) loadPrs(); }, PRS_EVERY_MS);
    const onFocus = () => loadPrs();
    const onVisible = () => { if (visible()) loadPrs(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [!!summary, loadPrs]);

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

  const prs = list?.prs;
  // One running PR is that PR's entry even after its head moved: the note
  // below offers the newer commits, and picking it again does nothing.
  const current = running.kind === 'main' ? 'main'
    : running.kind === 'prs' && running.prs.length === 1 && prs?.some((p) => p.number === running.prs[0].number && p.allowed !== false) ? `pr:${running.prs[0].number}`
    : 'running';
  const start = async (send: () => Promise<DevPreviewSummary>) => {
    setErr(null);
    watching.current = running.id;
    try { setLive(await send()); } catch (e) { watching.current = null; setErr((e as Error).message); }
  };
  const pick = async (value: string) => {
    if (value === current) return;
    const pr = value.startsWith('pr:') ? prs?.find((p) => `pr:${p.number}` === value) : null;
    if (!window.confirm(switchConfirmText(pr ? [pr] : []))) return;
    await start(() => (pr ? api.switchDevPreview([{ number: pr.number, sha: pr.sha }]) : api.rollbackDevPreview()));
  };
  // The same PRs in the same order, without SHAs: the server takes each PR's
  // head and main as GitHub reports them now. Same confirmation as any switch.
  const fresh = compareRunning(running, list);
  const pullLatest = async () => {
    const named = running.prs.map((p) => prs?.find((q) => q.number === p.number) || p);
    if (!window.confirm(switchConfirmText(named))) return;
    await start(() => api.switchDevPreview(running.prs.map((p) => ({ number: p.number }))));
  };

  const note = offline ? 'restarting…'
    : s.job?.state === 'running' ? `${s.job.kind === 'rollback' ? 'rolling back' : `switching: ${s.job.step}`}…`
    : s.restartPending ? `restarting into ${s.next?.label ?? 'the new build'}…`
    : err ? err
    : s.crashed ? 'the last preview crashed on start and was rolled back'
    : null;
  const pull = !note && !busy && canPullLatest(fresh) ? fresh : null;

  return (
    <div className="devpv-bar" data-testid="dev-preview-bar">
      <div className="devpv-bar-row">
        <label className="devpv-bar-k" htmlFor="devpv-pick">Preview:</label>
        <select id="devpv-pick" className="devpv-pick mono" value={current} disabled={busy}
          title={running.kind === 'main' ? 'main (the image build)' : `${running.label}${running.base ? ` on main ${short(running.base)}` : ''}`}
          onChange={(e) => pick(e.target.value)} data-testid="dev-preview-pick">
          <option value="main">main</option>
          {current === 'running' ? <option value="running" disabled>{running.label}</option> : null}
          {(prs || []).filter((p) => p.allowed !== false).map((p) => <option key={p.number} value={`pr:${p.number}`}>#{p.number} {clip(p.title)}</option>)}
        </select>
        <button className="icon-btn devpv-bar-btn" onClick={onOpenSettings} title="Preview settings: stacks, log, rollback"><SlidersGlyph /></button>
      </div>
      {note || pull || stale ? (
        <div className={`devpv-bar-note${err && !busy ? ' bad' : ''}`} data-testid="dev-preview-note">
          {note}
          {pull ? <><span className="devpv-dot" aria-hidden="true" />{newCommitsText(pull)} · <button className="devpv-link devpv-pull" onClick={pullLatest} data-testid="dev-preview-pull-link">pull latest</button></> : null}
          {stale && !busy ? <>{note || pull ? ' · ' : ''}<button className="devpv-link" onClick={() => location.reload()}>reload for this build's UI</button></> : null}
        </div>
      ) : null}
    </div>
  );
}
