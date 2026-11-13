import type { CheckpointHealth } from '../api';

const NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', openclaw: 'OpenClaw',
  opencode: 'opencode', hermes: 'Hermes', fx: 'fx', antigravity: 'Antigravity',
};
const when = (at: number | null) => (at ? new Date(at).toLocaleString() : null);

/**
 * Agent state that is not reaching durable storage, one line per harness.
 *
 * Sessions live on the container's own disk and are copied out every few
 * seconds (scripts/agent-state.sh). When that copy fails, everything keeps
 * working — until a restart brings back the last good copy, however old. The
 * server sends `health` only once an adapter has gone five minutes without a
 * clean pass, so this renders nothing in the normal case. Not dismissible, for
 * the reason BackupBanner is not.
 */
export default function CheckpointBanner({ health }: { health: CheckpointHealth | null | undefined }) {
  if (!health) return null;
  return (
    <>
      {health.stalled && (
        <div className="bkfail ckfail" role="status" title={`Log: ${health.log}`}>
          <span className="bkfail-dot" aria-hidden="true" />
          <span className="bkfail-txt">
            <b>Agent sessions are not being saved.</b>{' '}
            No checkpoint has finished since {when(health.stalled.lastPassAt)}. A restart now would lose the work since then.
          </span>
        </div>
      )}
      {health.adapters.map((a) => {
        const name = NAMES[a.adapter] || a.adapter;
        // Every path that is not getting through is known and failed on its
        // own: the rest of this harness's files are being saved.
        const some = a.pending > 0 && !a.untested;
        const since = when(a.lastSuccessAt);
        return (
          <div
            className="bkfail ckfail"
            role="status"
            key={a.adapter}
            title={[a.reason, a.paths && `Not copied: ${a.paths}`, `Log: ${health.log}`].filter(Boolean).join('\n')}
          >
            <span className="bkfail-dot" aria-hidden="true" />
            <span className="bkfail-txt">
              <b>
                {some
                  ? `${name}: ${a.pending} file${a.pending === 1 ? ' is' : 's are'} not being backed up.`
                  : `${name} sessions are not being saved.`}
              </b>{' '}
              {since ? `Last complete save ${since}. ` : 'No complete save since this Space started. '}
              {some ? '' : 'A restart now would lose the work since then. '}
              {a.reason ? <span className="mono bkfail-why">{a.reason}</span> : null}
            </span>
          </div>
        );
      })}
    </>
  );
}
