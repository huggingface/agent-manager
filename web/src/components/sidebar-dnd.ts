// Where a drag would land in the sidebar tree.
//
// Pure geometry, kept out of the component because it is the whole of the
// behaviour and it was quietly wrong: the only target a group offered was the
// name chip riding its top border — roughly 17px tall and no wider than the
// name — while the frame below it, often a hundred pixels of it, refused every
// drop. Reordering two groups meant threading a moving cursor through that chip,
// and once every agent lived in a group there was no top-level row left to aim
// at, so an agent could go into a group and never come back out.
//
// Three rules come out of that:
//   * a target is as big as the thing it represents (the frame, not the label),
//   * a target that cannot take this particular drag answers null, so the event
//     keeps bubbling to something that can, and
//   * the background between and below the frames is itself a target — that is
//     what "put this back at the top level" means.

export type Zone = 'before' | 'after' | 'on';
export type Kind = 'group' | 'session';

/** Just the geometry we need from a DOMRect, so tests can hand-build one. */
export type Box = { top: number; height: number };

export type DropQuery = {
  dragRef: string | null;   // what's in flight ('s:…' / 'g:…'), null when nothing is
  ref: string;              // the row or frame being hovered
  kind: Kind;
  nested: boolean;          // a session row inside a group
  isMember?: boolean;       // hovering a group that already holds the dragged session
  box: Box;
  clientY: number;
};

// A frame is tall, so its before/after strips are a fixed band at the edges
// rather than half the box: everything between them means "into this group".
const EDGE = 14;

/**
 * The zone a drop on `ref` would use, or null when this target can't take the
 * drag — the caller must then leave the event alone (no preventDefault, no
 * stopPropagation) so an enclosing frame, or the tree itself, still gets a say.
 */
export function dropZone(q: DropQuery): Zone | null {
  const { dragRef, ref, kind, nested, box, clientY } = q;
  if (!dragRef || dragRef === ref) return null;
  const draggingGroup = dragRef.startsWith('g:');
  // A group can't nest. Rather than swallow the event, hand it to the frame
  // around this row — that's what makes a group's interior a live target for
  // another group instead of a dead zone the size of the group.
  if (nested && draggingGroup) return null;

  const y = clientY - box.top;
  const band = kind === 'group' && !nested ? Math.min(EDGE, box.height / 3) : box.height / 3;

  // Reordering groups: every point on the frame has to mean something, so split
  // it down the middle.
  if (draggingGroup) return y < box.height / 2 ? 'before' : 'after';
  // The agent already lives in this group, so 'into' is a no-op — only the edges
  // (pull it out, above or below) still say anything.
  if (kind === 'group' && q.isMember) return y < band ? 'before' : y > box.height - band ? 'after' : null;
  return y < band ? 'before' : y > box.height - band ? 'after' : 'on';
}

/**
 * A drop on the tree's own background — the margins between frames, and the
 * empty space under the list. Answers with the top-level item it lands next to,
 * so an agent dragged out of a group becomes loose in the right place.
 */
export function backgroundAnchor(
  items: Array<{ ref: string; box: Box }>,
  dragRef: string | null,
  clientY: number,
): { ref: string; zone: 'before' | 'after' } | null {
  if (!dragRef) return null;
  const rest = items.filter((i) => i.ref !== dragRef);
  if (!rest.length) return null;
  for (const i of rest) {
    if (clientY < i.box.top + i.box.height / 2) return { ref: i.ref, zone: 'before' };
  }
  return { ref: rest[rest.length - 1].ref, zone: 'after' };
}
