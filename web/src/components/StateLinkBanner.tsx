import type { StateLinkHealth } from '../api';

const NAMES: Record<string, string> = {
  opencode: 'opencode', hermes: 'Hermes', fx: 'fx', antigravity: 'Antigravity',
};

/**
 * A CLI whose state folder under HOME should be a link to local disk, and is
 * not (server/src/state-links.js). On a Space HOME is the bucket, so the CLI
 * is writing there directly: nothing checkpoints it, and SQLite on the bucket
 * corrupts. Antigravity's links are repaired before its next launch once no
 * agy runs; until then this stays. Not dismissible, like CheckpointBanner.
 */
export default function StateLinkBanner({ health }: { health: StateLinkHealth | null | undefined }) {
  if (!health?.broken?.length) return null;
  const clis = [...new Set(health.broken.map((b) => b.cli))];
  return (
    <>
      {clis.map((cli) => {
        const rows = health.broken.filter((b) => b.cli === cli);
        const name = NAMES[cli] || cli;
        const onBucket = rows.some((b) => b.kind === 'dir' && b.onBucket);
        const what = onBucket ? `${name} state is on the bucket (link replaced).` : `${name} state is not linked to local disk.`;
        const repair = cli === 'antigravity' ? health.repair : null;
        return (
          <div
            className="bkfail ckfail"
            role="status"
            key={cli}
            title={[...rows.map((b) => `${b.link}: ${b.kind === 'dir' ? 'a real directory' : b.kind}, expected a link to ${b.target}`),
              repair && `Last repair ${repair.outcome}: ${repair.detail}`, `Log: ${health.log}`].filter(Boolean).join('\n')}
          >
            <span className="bkfail-dot" aria-hidden="true" />
            <span className="bkfail-txt">
              <b>{what}</b>{' '}
              {cli === 'antigravity'
                ? (repair?.outcome === 'deferred'
                  ? 'An agy session is running, so it was not moved. Stop the Antigravity sessions and start one again to repair it. '
                  : 'It is repaired before the next Antigravity launch. ')
                : 'Restart the Space to relink it. '}
              {onBucket ? 'Until then nothing there is checkpointed, and its databases can corrupt. ' : ''}
              <span className="mono bkfail-why">{rows.map((b) => b.link).join(', ')}</span>
            </span>
          </div>
        );
      })}
    </>
  );
}
