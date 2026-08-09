// What an agent is called when it is shown on its own: `[Group] name`.
//
// The sidebar and the Overview already draw the group as a frame around its
// agents, so they say it once and leave the rows bare. The surfaces that show a
// single agent with no such frame — a pane header in a tiled group, the phone's
// title bar, the browser tab — have to spell the group out, or four panes named
// `claude-code-1` are indistinguishable.
//
// One rule everywhere: the group is context and the name is the thing you are
// looking for, so when there isn't room the group gives way first. A session
// with no group is titled by its bare name — never `[None] foo` or `[] foo`.

/**
 * The group's display name, or null when the session sits loose in the tree.
 *
 * Ungrouped is an absence here, not a word: the tree simply has no group that
 * lists the session, and `/api/agents` serialises that as `group: null`. So the
 * empty cases all collapse to the same bare name — there is no `[None] foo`.
 */
export function groupLabel(name?: string | null): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed : null;
}

// About what a browser shows of a tab title before it stops being readable.
// Past this the prefix would be all you can see, which is the failure this
// whole module exists to avoid.
export const TAB_BUDGET = 42;

// Shorter than "[abc…]" the prefix identifies nothing, so drop it instead.
const MIN_GROUP = 4;

/**
 * `[Group] name` as a single string, for the places that can only take one: the
 * browser tab and `title=` tooltips.
 *
 * Fits `budget` characters by shortening the group, then by dropping it. The
 * name comes back whole even when it exceeds the budget by itself — cutting
 * into the name is the one thing this must never do.
 */
export function sessionTitle(name: string, group?: string | null, budget = TAB_BUDGET): string {
  const g = groupLabel(group);
  if (!g) return name;
  const full = `[${g}] ${name}`;
  if (full.length <= budget) return full;
  const room = budget - name.length - 3; // the brackets and the separating space
  if (room < MIN_GROUP) return name;
  return `[${g.slice(0, room - 1)}…] ${name}`;
}
