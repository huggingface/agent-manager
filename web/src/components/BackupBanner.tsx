import type { BackupHealth } from '../api';

/**
 * The one line that stops a broken backup from looking like a working one.
 *
 * Renders nothing when `health` is null, which is the normal case — the server
 * only sends this object when a backup is failing or has gone quiet. Not
 * dismissible on purpose: the whole failure mode here is silence being mistaken
 * for health, and a dismissed warning is silence again.
 */
export default function BackupBanner({ health, onOpenSettings }: {
  health: BackupHealth | null | undefined;
  onOpenSettings: () => void;
}) {
  if (!health) return null;
  return (
    <div className="bkfail" role="status">
      <span className="bkfail-dot" aria-hidden="true" />
      <span className="bkfail-txt">
        {health.failing ? (
          <>
            <b>Bucket backup is failing.</b>{' '}
            {health.failures > 1 ? `${health.failures} runs in a row. ` : ''}
            {health.reason ? <span className="mono bkfail-why">{health.reason}</span> : null}
          </>
        ) : (
          <>
            <b>Bucket backup has not succeeded recently.</b>{' '}
            {health.lastSuccessAt
              ? `Last good run ${new Date(health.lastSuccessAt).toLocaleString()}.`
              : 'It has never completed a run.'}
          </>
        )}
      </span>
      <a className="bkfail-link" href={health.jobsUrl} target="_blank" rel="noreferrer">the runs ↗</a>
      <button className="bkfail-link" onClick={onOpenSettings}>settings</button>
    </div>
  );
}
