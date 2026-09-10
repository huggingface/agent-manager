// What an empty Overview says.
//
// Three controls can empty the feed now — the state chip, the search box and
// the `unread` sort option — and two of them are named on screen. A feed that
// goes blank without saying which one did it reads as broken rather than empty,
// and the operator's next move is to reload rather than to widen the filter
// they just set.
//
// Pure, and here rather than inline in the component, because "no way to end up
// with an empty view that looks broken" is a claim worth a test.

export interface EmptyState {
  onlyUnread: boolean;
  chip: string;
  query: string;
  hiddenCount: number;
  showHidden: boolean;
}

/** Which named controls are currently narrowing the feed, in reading order. */
export function narrowedBy({ chip, query }: Pick<EmptyState, 'chip' | 'query'>): string[] {
  return [
    chip !== 'all' ? `state: ${chip}` : '',
    query.trim() ? 'the search box' : '',
  ].filter(Boolean);
}

export function emptyMessage(s: EmptyState): string {
  if (s.onlyUnread) {
    const narrowed = narrowedBy(s);
    // Naming them is the whole point: "nothing unread" is a true sentence that
    // still looks like a bug when a state chip the operator forgot about is
    // what removed the unread agent they can see in the sidebar.
    return narrowed.length
      ? `nothing unread under ${narrowed.join(' and ')}. clear ${narrowed.length > 1 ? 'them' : 'it'} to see the rest.`
      : 'nothing unread — every agent’s latest reply has been seen.';
  }
  if (s.query.trim()) return `no recent activity matches “${s.query.trim()}” with the current filters.`;
  if (!s.showHidden && s.hiddenCount > 0) return `nothing to show — ${s.hiddenCount} hidden. reveal them from the bar below.`;
  if (s.chip === 'all') return 'no agents yet — shells and file panes don’t appear here.';
  if (s.chip === 'started') return 'nothing started — no agent is running or waiting on you.';
  return 'nothing in this state.';
}
