import type { Session } from '../types';
import { isPassive } from '../types';

// Road two of the two that take a session out of the working list.
//
// Road one is the operator saying "I am finished with this one" — stored on the
// server as `archivedAt`, and it means the same thing on every device. Road two
// is this: quiet for longer than the window. It is a statement about the clock,
// so it stays DERIVED — recomputed against the clock rather than written down
// once — which is why it expires the moment the setting changes and why nothing
// persists it.
//
// It lives here rather than inline in App because pinning's exemption is part of
// the verdict, and a rule that only exists inside a `useMemo` cannot be tested
// apart from the component that happens to hold it.

export type ArchiveAfter = 'week' | 'month' | 'never';

/**
 * Which sessions the idle window judges quiet.
 *
 * `pinned` is the exemption, and it suppresses THIS road and only this one.
 * Pinning says the clock is not the point for this session; road one is the
 * operator saying they are finished, which pinning has no business overriding
 * (and which clears the pin server-side anyway). Pass the set from
 * `pinnedSessionIds` in lib/pinned.ts — it counts group membership, so a pinned
 * group's members are exempt without being pinned in their own right.
 *
 * `now` is a parameter so the verdict can be asked about a moment other than
 * this one; callers in the app leave it alone.
 */
export function quietSessionIds(
  sessions: Session[],
  ages: Record<string, number>,
  archiveAfter: ArchiveAfter,
  pinned: Set<string>,
  now = Date.now(),
): Set<string> {
  const out = new Set<string>();
  if (archiveAfter === 'never') return out;
  const cut = now - (archiveAfter === 'week' ? 7 : 30) * 864e5;
  for (const s of sessions) {
    // Shells and passive panels have no trace clock — never archive them.
    if (s.cli === 'shell' || isPassive(s.cli) || s.state === 'working') continue;
    if (s.archivedAt) continue;                       // already on road one
    if (pinned.has(s.id)) continue;
    const last = ages[s.id] || Date.parse(s.createdAt) || 0;
    if (last && last < cut) out.add(s.id);
  }
  return out;
}
