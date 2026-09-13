import type { Group, Session } from '../types';

// Pinning, in one place, because every part of it is a decision rather than a
// mechanism and the decisions have to agree with each other.
//
// What pinning is: the operator saying "keep this in front of me". It buys two
// things and no others — a place above the sidebar's rule, and immunity from
// the idle window. It is stored, like archiving, because the clock cannot say
// it.
//
// What can be pinned: an ungrouped session, or a whole group. A session inside
// a group cannot. Its group is the thing that gets pinned, and the pin lives on
// the group's own row one line above it.

/** Every session that belongs to some group. */
function groupedIds(groups: Group[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) for (const id of g.sessionIds) out.add(id);
  return out;
}

/**
 * Every session the idle window must leave alone: the ungrouped ones pinned
 * outright, and every member of a pinned group.
 *
 * Members inherit because the alternative eats itself. A group pinned to keep it
 * in view, whose agents each age out on their own schedule, empties one row at a
 * time and then vanishes — the sidebar drops a group once all its agents are
 * archived. Pinning it would have caused exactly what it was asked to prevent.
 *
 * A `pinnedAt` on a GROUPED session is ignored rather than honoured. The rule is
 * that such a session cannot be pinned, so a stray value — written before it
 * joined a group, or by some path that did not clear it — describes a state the
 * rule says does not exist. Reading it would make the exemption depend on
 * history the operator can no longer see or change.
 */
export function pinnedSessionIds(sessions: Session[], groups: Group[]): Set<string> {
  const grouped = groupedIds(groups);
  const out = new Set<string>();
  for (const s of sessions) if (s.pinnedAt && !grouped.has(s.id)) out.add(s.id);
  for (const g of groups) if (g.pinnedAt) for (const id of g.sessionIds) out.add(id);
  return out;
}

/**
 * Can this ref be pinned at all? Only an ungrouped session or a group.
 *
 * The sidebar asks so it can leave the control off a grouped row entirely,
 * rather than offering one that argues back.
 */
export function canPin(ref: string, groups: Group[]): boolean {
  if (ref.startsWith('g:')) return true;
  return !groupedIds(groups).has(ref.slice(2));
}

/**
 * The sidebar's one order, split in two.
 *
 * `order` stays the single ordering truth — pinning does not introduce a second
 * one, it partitions this one and keeps each half in it. That is why dragging
 * and pinning cannot disagree about what comes first: there is nothing for them
 * to disagree about. (What happens when a row is dragged ACROSS the rule is the
 * other half of that answer — see pinAfterDrop.)
 *
 * `order` holds top-level refs only, so a grouped session is not in it and
 * cannot land in either half however its record happens to read. That is the
 * whole of "a grouped session is never drawn above the rule": there is no code
 * here that could draw one.
 */
export function partitionByPin(
  order: string[],
  sessions: Session[],
  groups: Group[],
): { pinned: string[]; rest: string[] } {
  const sessById = new Map(sessions.map((s) => [s.id, s]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const ref of order) {
    const isPinned = ref.startsWith('g:')
      ? !!groupById.get(ref.slice(2))?.pinnedAt
      : !!sessById.get(ref.slice(2))?.pinnedAt;
    (isPinned ? pinned : rest).push(ref);
  }
  return { pinned, rest };
}

/**
 * What a drop does to the dragged row's pin: `true` to pin, `false` to unpin,
 * `null` to leave it alone.
 *
 * One rule, and it covers both boundaries the sidebar has. A dropped row takes
 * the pin state of where it lands:
 *
 *   - beside a neighbour, it takes that neighbour's side of the rule, so the
 *     rule is a boundary the operator can drag across rather than a line that
 *     silently snaps their drop back where it came from;
 *   - INTO a group (`landsInGroup`), it takes the only state available there,
 *     which is unpinned — a grouped session cannot be pinned, so the pin it
 *     arrived with has to go rather than linger and reappear if it is ever
 *     dragged back out.
 */
export function pinAfterDrop(
  draggedRef: string,
  target: { ref?: string; landsInGroup?: boolean },
  isPinned: (ref: string) => boolean,
): boolean | null {
  if (target.landsInGroup) return isPinned(draggedRef) ? false : null;
  if (!target.ref || draggedRef === target.ref) return null;
  const want = isPinned(target.ref);
  return want === isPinned(draggedRef) ? null : want;
}
