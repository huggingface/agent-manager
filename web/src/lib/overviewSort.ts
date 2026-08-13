// Ordering the Overview by when something last happened.
//
// The Overview's own order is the sidebar's: the tree, hand-arranged, groups as
// capsules. That answers "where is this agent" and nothing else. The two
// questions it cannot answer are "where did I last type something" and "who
// answered most recently", and both are a timestamp the digest already carries
// (`lastPromptTs` / `lastAssistantTs`, ms epoch, 0 when unknown).
//
// Three rules, all of them here rather than in the component, because they are
// the part that can be wrong:
//
//  1. **A running agent is not ranked.** Its last message is whatever it said
//     before it started working, so ranking it by that buries the agent that is
//     doing something right now under agents that are done. They come out in
//     their own section, and the caller pins it above the sorted list.
//  2. **A missing timestamp sinks.** `0` means "we do not know" — a session
//     that never started, has no transcript, or runs a harness that writes
//     none. Sorting descending on a number would float those to the bottom
//     anyway, but only by accident of arithmetic; they get their own section so
//     the caller can say what they are instead of implying they are stale.
//  3. **Ties keep the manual order.** The caller passes items in tree order and
//     the sort is stable, so equal timestamps — and the whole undated section —
//     read as the sidebar reads.

import type { OverviewSort } from '../types';

/** What ordering needs to know about a session. Deliberately not `MetaSession`:
 *  the three facts, so this is testable without a digest or a React tree. */
export interface Rankable {
  id: string;
  lastPromptTs: number;     // ms epoch, 0 = unknown
  lastAssistantTs: number;  // ms epoch, 0 = unknown
  running: boolean;
}

/** The timestamp a given sort reads. 0 for the manual order, which reads none. */
export function sortTs(s: Rankable, sort: OverviewSort): number {
  if (sort === 'prompt') return s.lastPromptTs || 0;
  if (sort === 'answer') return s.lastAssistantTs || 0;
  return 0;
}

export interface Sections<T> {
  /** At work now — pinned above the sorted list, in the caller's order. */
  running: T[];
  /** The answer to the question, newest first. */
  dated: T[];
  /** No such message ever: never started, no transcript, unsupported harness. */
  undated: T[];
}

/**
 * Split into the three sections above and sort the middle one, newest first.
 *
 * `manual` is the identity: everything lands in `dated` untouched, so a caller
 * that renders the sections in order still gets the tree's own arrangement.
 */
export function rankSessions<T extends Rankable>(items: T[], sort: OverviewSort): Sections<T> {
  if (sort === 'manual') return { running: [], dated: items.slice(), undated: [] };
  const running: T[] = [];
  const dated: T[] = [];
  const undated: T[] = [];
  for (const it of items) {
    if (it.running) running.push(it);
    else if (sortTs(it, sort) > 0) dated.push(it);
    else undated.push(it);
  }
  // Stable (ES2019+): equal timestamps stay in the order they arrived, which is
  // the tree's.
  dated.sort((a, b) => sortTs(b, sort) - sortTs(a, sort));
  return { running, dated, undated };
}

/** What the sorted block is sorted BY, spelled out above it in the feed. */
export function sortLabel(sort: OverviewSort): string {
  return sort === 'prompt' ? 'by your last message' : sort === 'answer' ? 'by the last reply' : '';
}
