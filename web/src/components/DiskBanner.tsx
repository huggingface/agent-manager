import type { DiskHealth } from '../api';

const GiB = 1024 ** 3;
const fmtGb = (bytes: number) => {
  const gb = bytes / GiB;
  const fixed = gb >= 10 && Math.abs(gb - Math.round(gb)) < 0.05 ? String(Math.round(gb)) : gb.toFixed(1);
  return `${fixed} GB`;
};

/**
 * Warning when local disk drops below 10 GB free or when restored agent state
 * leaves < 10 GB of startup headroom on the container's local disk.
 */
export default function DiskBanner({ health }: { health: DiskHealth | null | undefined }) {
  if (!health) return null;
  const title = [
    `Free on local disk: ${fmtGb(health.freeBytes)} of ${fmtGb(health.totalBytes)} (${health.source})`,
    health.stateBytes ? `Saved agent state: ${fmtGb(health.stateBytes)} (startup peak ~${fmtGb(health.bootPeakBytes || health.stateBytes)})` : null,
    health.bootFreeBytes !== null ? `Estimated startup headroom: ${fmtGb(health.bootFreeBytes)}` : null,
  ].filter(Boolean).join('\n');

  return (
    <div className="bkfail ckfail diskfail" role="status" title={title}>
      <span className="bkfail-dot" aria-hidden="true" />
      <span className="bkfail-txt">
        {health.lowDisk ? (
          <>
            <b>Local disk has {fmtGb(health.freeBytes)} left (of {fmtGb(health.totalBytes)}).</b>{' '}
            Below {fmtGb(health.warnFreeBytes)}, checkpoints can fail and this Space risks not being able to boot after a restart.{' '}
            {health.bootRisk && health.bootPeakBytes
              ? `Restoring saved sessions alone needs ~${fmtGb(health.bootPeakBytes)} at startup. `
              : ''}
            Remove unused clones, envs, or caches in <span className="mono">$AM_LOCAL</span> or <span className="mono">/tmp</span>.
          </>
        ) : (
          <>
            <b>Local disk may not have enough room to boot ({fmtGb(health.bootFreeBytes ?? 0)} startup headroom of {fmtGb(health.totalBytes)}).</b>{' '}
            Restoring saved agent sessions needs ~{fmtGb(health.bootPeakBytes ?? 0)} on local disk at startup, leaving less than {fmtGb(health.warnFreeBytes)} and risking a failed boot on the next restart.
          </>
        )}
      </span>
    </div>
  );
}
