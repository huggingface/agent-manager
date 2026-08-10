// What an agent is called when it is shown on its own: `[Group] name`.
//
// The sidebar and the Overview already draw the group as a frame around its
// agents, so they say it once and leave the rows bare. A pane header has no
// such frame — four tiles named `claude-code-N` are indistinguishable — so it
// spells the group out.
//
// The prefix is context and the name is the thing you are looking for. Fitting
// the two into a narrow header is CSS's job (`.ph-group` shrinks and then hides
// before `.ph-name` gives up a pixel); what this module owns is the plain
// string, which goes in the header's tooltip and is deliberately NOT shortened
// — the tooltip is where you go when the header ran out of room.

/**
 * The group's display name, or null when the session sits loose in the tree.
 *
 * Ungrouped is an absence here, not a word: `/api/tree` gives the app groups
 * with their `sessionIds`, so a loose session is simply one no group lists and
 * the caller has nothing to pass. Every empty shape collapses to the same bare
 * name — there is no `[None] foo`. (The roster that agents read, `/api/agents`,
 * spells the same absence as `group: null`.)
 */
export function groupLabel(name?: string | null): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed : null;
}

/** `[Group] name`, whole; a bare name when the session has no group. */
export function sessionTitle(name: string, group?: string | null): string {
  const g = groupLabel(group);
  return g ? `[${g}] ${name}` : name;
}
