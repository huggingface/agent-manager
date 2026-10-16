import type { DevPreviewSummary } from '../api';

// The build this tab's JavaScript came from. A switch replaces the server and
// the web app; a tab opened before it keeps running the old UI until reloaded,
// and must say so rather than pass the old UI off as the new code.
let loadedId: string | null = null;

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');

/**
 * Which code this dev Space is running, on every view. Renders nothing unless
 * the server sent `devPreview` (only when the Space sets AM_DEV_PREVIEW=1), so
 * production never shows it. Not dismissible: the point is that the operator
 * always knows what they are looking at.
 */
export default function DevPreviewBanner({ summary, onOpen }: {
  summary: DevPreviewSummary | null | undefined;
  onOpen: () => void;
}) {
  if (!summary) return null;
  const { running, job, crashed } = summary;
  if (loadedId === null) loadedId = running.id;
  const stale = loadedId !== running.id;
  const busy = job?.state === 'running';
  return (
    <div className={`devpv${running.kind === 'main' ? ' main' : ''}`} role="status" data-testid="dev-preview-banner">
      <span className="devpv-tag">preview</span>
      <span className="devpv-txt">
        {running.kind === 'main' ? (
          <b>main</b>
        ) : (
          <>
            {running.prs.map((p, i) => (
              <span key={p.number}>
                {i > 0 ? ' + ' : ''}<b>#{p.number}</b> <span className="mono">{short(p.sha)}</span>
              </span>
            ))}
            {running.base ? <span className="devpv-dim"> on main <span className="mono">{short(running.base)}</span></span> : null}
          </>
        )}
        {summary.restartPending ? <span className="devpv-dim"> · restarting into it…</span> : null}
        {busy ? <span className="devpv-dim"> · {job!.kind === 'rollback' ? 'rolling back' : `switching: ${job!.step}`}…</span> : null}
        {crashed ? <span className="devpv-warn"> · the last preview crashed on start and was rolled back</span> : null}
      </span>
      {stale ? <button className="devpv-link" onClick={() => location.reload()}>reload to load this build's UI</button> : null}
      <button className="devpv-link" onClick={onOpen}>switch</button>
    </div>
  );
}
