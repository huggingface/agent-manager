import type { Tree } from '../types';

/**
 * Which agents the operator has hidden from the Overview.
 *
 * `tree.hidden` holds REFS — `g:<id>` for a whole group, `s:<id>` for one agent —
 * and every consumer needs the same thing from them: the set of session ids that
 * should not appear. One function, because three of them ask:
 *
 *  · Overview's `visible()`, the single gate for tiles, list and the ranked feed;
 *  · the sidebar's `N waiting` badge, which sits on the overview row and so must
 *    count what the overview would actually show;
 *  · the bottom bar's `N hidden` button, which counts AGENTS rather than refs —
 *    "1 hidden" for a six-agent group would understate what is missing.
 *
 * Written independently in each place, those three would drift, and the badge
 * disagreeing with the feed is the exact bug hiding is supposed to avoid.
 */
export function hiddenSessionIds(tree: Tree): Set<string> {
  const ids = new Set<string>();
  if (!tree.hidden?.length) return ids;
  const refs = new Set(tree.hidden);
  for (const g of tree.groups) if (refs.has(`g:${g.id}`)) for (const id of g.sessionIds) ids.add(id);
  for (const s of tree.sessions) if (refs.has(`s:${s.id}`)) ids.add(s.id);
  return ids;
}
