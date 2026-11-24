import type { StateLinkHealth } from '../api';

const NAMES: Record<string, string> = {
  opencode: 'opencode', hermes: 'Hermes', fx: 'fx', antigravity: 'Antigravity',
};

/**
 * A CLI whose state folder under HOME should be a link to local disk, and is
 * not (server/src/state-links.js). On a Space HOME is the bucket, so the CLI
 * is writing there directly: nothing checkpoints it, and SQLite on the bucket
 * corrupts. The manager's own agy runs with HOME on local disk, so for
 * Antigravity this means an agy started some other way wrote there; it is
 * moved at the next server start. Not dismissible, like CheckpointBanner.
 */
export default function StateLinkBanner({ health }: { health: StateLinkHealth | null | undefined }) {
  if (!health?.broken?.length) return null;
  const clis = [...new Set(health.broken.map((b) => b.cli))];
  return (
    <>
      {clis.map((cli) => {
        const rows = health.broken.filter((b) => b.cli === cli);
        const name = NAMES[cli] || cli;
        const own = rows.filter((b) => b.local);
        const onBucket = rows.some((b) => b.kind === 'dir' && b.onBucket);
        const repair = cli === 'antigravity' ? health.repair : null;
        const what = own.length
          ? `${name}'s local HOME is broken.`
          : onBucket ? `${name} state is on the bucket (link replaced).` : `${name} state is not linked to local disk.`;
        let todo = 'Restart the Space to relink it. ';
        if (cli === 'antigravity') {
          if (own.length) todo = 'New Antigravity sessions will not start until it is fixed; restarting the Space rebuilds it. ';
          else if (repair?.outcome === 'deferred') todo = 'An agy started outside the manager wrote there. It was not moved because agy is running; it is moved to local disk at the next server start with no agy running. ';
          else todo = 'An agy started outside the manager wrote there. It is moved to local disk at the next server start. ';
        }
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
              {todo}
              {onBucket ? 'Until then nothing there is checkpointed, and its databases can corrupt. ' : ''}
              <span className="mono bkfail-why">{rows.map((b) => b.link).join(', ')}</span>
            </span>
          </div>
        );
      })}
    </>
  );
}
