import type { Group, Session } from '../types';

// Pinning, in one place, because every part of it is a decision rather than a
// mechanism and the decisions have to agree with each other.
//
// What pinning is: the operator saying "keep this in front of me". It buys two
// things and no others — a place above the sidebar's rule, and immunity from
// the idle window. It is stored, like archiving, because the clock cannot say
// it.

/**
 * Every session the idle window must leave alone: the ones pinned outright, and
 * every member of a pinned group.
 *
 * Members inherit because the alternative eats itself. A group pinned to keep it
 * in view, whose agents each age out on their own schedule, empties one row at a
 * time and then vanishes — the sidebar drops a group once all its agents are
 * archived. Pinning it would have caused exactly what it was asked to prevent.
 *
 * Their own `pinnedAt` is untouched by the group's, so unpinning the group hands
 * every member back to the ordinary rules without anyone having to remember
 * which of them had been pinned individually first.
 */
export function pinnedSessionIds(sessions: Session[], groups: Group[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) if (s.pinnedAt) out.add(s.id);
  for (const g of groups) if (g.pinnedAt) for (const id of g.sessionIds) out.add(id);
  return out;
}

/**
 * Which pinned sessions are drawn out of the group they belong to, and which
 * group each came from.
 *
 * A pinned session inside an UNPINNED group is lifted to the top block. The two
 * alternatives cost more than they save: leaving it in place makes pinning
 * useless in the one case you most want it — a single agent inside a long group,
 * far down the list — and drawing it in both places puts two live rows on screen
 * for one session, each with its own state and its own controls.
 *
 * A session inside a PINNED group is NOT lifted: the group is already at the top
 * and carrying it, so lifting would be that duplicate by another route.
 *
 * Lifting is a view. Membership is not touched, the row says which group it came
 * from, and unpinning drops it home.
 */
export function liftedSessions(sessions: Session[], groups: Group[]): Map<string, Group> {
  const home = new Map<string, Group>();
  for (const g of groups) for (const id of g.sessionIds) home.set(id, g);
  const out = new Map<string, Group>();
  for (const s of sessions) {
    if (!s.pinnedAt) continue;
    const g = home.get(s.id);
    if (g && !g.pinnedAt) out.set(s.id, g);
  }
  return out;
}

/**
 * The sidebar's one order, split in two.
 *
 * `order` stays the single ordering truth — pinning does not introduce a second
 * one, it partitions this one and keeps each half in it. That is why dragging
 * and pinning cannot disagree about what comes first: there is nothing for them
 * to disagree about. (What happens when a row is dragged ACROSS the rule is the
 * other half of that answer, and lives in the sidebar: the row takes the pin
 * state of whatever it lands beside, the same way a row dropped into a group
 * takes that group's membership.)
 *
 * Lifted rows are appended to the pinned half in the order their groups appear,
 * because `order` holds top-level refs only and a grouped session has no
 * position of its own in it.
 */
export function partitionByPin(
  order: string[],
  sessions: Session[],
  groups: Group[],
): { pinned: string[]; rest: string[] } {
  const sessById = new Map(sessions.map((s) => [s.id, s]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const lifted = liftedSessions(sessions, groups);
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const ref of order) {
    const isPinned = ref.startsWith('g:')
      ? !!groupById.get(ref.slice(2))?.pinnedAt
      : !!sessById.get(ref.slice(2))?.pinnedAt;
    (isPinned ? pinned : rest).push(ref);
  }
  for (const ref of order) {
    if (!ref.startsWith('g:')) continue;
    const g = groupById.get(ref.slice(2));
    if (!g || g.pinnedAt) continue;
    for (const id of g.sessionIds) if (lifted.has(id)) pinned.push(`s:${id}`);
  }
  return { pinned, rest };
}

/**
 * What a drop does to the dragged row's pin: `true` to pin, `false` to unpin,
 * `null` to leave it alone.
 *
 * This is the other half of "pinning does not introduce a second ordering". The
 * partition above keeps the two axes from disagreeing about order; this keeps
 * them from disagreeing about sides. A dropped row takes the pin state of
 * whatever it lands beside — the same way a row dropped into a group takes that
 * group's membership — so the rule is a boundary the operator can drag across
 * rather than a line that silently snaps their drop back where it came from.
 *
 * Dropping ONTO something (into a group, or paired with a session) is not a
 * neighbour relationship and is not handled here: membership decides which
 * block draws it from then on, so its own pin has nothing left to say.
 */
export function pinAfterDrop(
  draggedRef: string,
  targetRef: string,
  isPinned: (ref: string) => boolean,
): boolean | null {
  if (draggedRef === targetRef) return null;
  const want = isPinned(targetRef);
  return want === isPinned(draggedRef) ? null : want;
}
