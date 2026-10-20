// The session's sub-agent roster, cached outside React.
//
// It is one directory listing per session (187 bytes per sub-agent) and it
// carries what a trace window cannot: the agentId of a spawn whose launch
// receipt has scrolled away, the depth, and when each sub-agent's transcript
// last changed — the fact the "no write in 15m" rule needs.
//
// WHY A MODULE-LEVEL CACHE. The reader remounts often (the pane re-renders as
// the trace window polls, and the exchange list is rebuilt when older turns
// arrive), and an effect that owns the answer loses it every time: measured in
// the browser, every single request was cancelled by its own cleanup before the
// response landed, so rows kept saying "running" with no last-write time even
// though the roster had been fetched a dozen times. Holding the answer here
// means a remount starts from what we already know, and the in-flight promise is
// shared instead of duplicated.
import { getSubAgents, type SubAgentEntry } from '../api';

const FRESH_MS = 15_000;
const cache = new Map<string, { at: number; agents: SubAgentEntry[] }>();
const inflight = new Map<string, Promise<SubAgentEntry[]>>();

export const cachedRoster = (sessionId: string): SubAgentEntry[] | null => cache.get(sessionId)?.agents ?? null;

export function loadRoster(sessionId: string, force = false): Promise<SubAgentEntry[]> {
  const hit = cache.get(sessionId);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.agents);
  const pending = inflight.get(sessionId);
  if (pending) return pending;
  const p = getSubAgents(sessionId)
    .then((r) => {
      cache.set(sessionId, { at: Date.now(), agents: r.agents });
      return r.agents;
    })
    .finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}
