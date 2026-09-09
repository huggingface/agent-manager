import type { MetaSession } from '../api';

/**
 * The text the Overview already has in memory for one agent.
 *
 * This deliberately stays on the digest: filtering the fleet must not turn one
 * keystroke into a transcript read for every session. It covers identity plus
 * the current request's prompt, replies, tools and files. Older history belongs
 * to a future indexed search, not a synchronous scan from the Overview.
 */
export function overviewSearchText(s: MetaSession, group = ''): string {
  const d = s.digest;
  return [
    s.name,
    group,
    d?.lastPromptRaw,
    d?.lastPromptText,
    d?.lastAssistantMd,
    d?.lastAssistantText,
    ...Object.keys(d?.sinceTools ?? {}),
    ...(d?.sinceFiles ?? []),
    ...(d?.turnsLog ?? []).flatMap((turn) => [turn.answerMd, turn.answer]),
  ].filter(Boolean).join('\n').normalize('NFKC').toLowerCase();
}

/** Case-insensitive substring matching; every whitespace-separated term must land. */
export function matchesOverviewSearch(s: MetaSession, group: string, query: string): boolean {
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = overviewSearchText(s, group);
  return terms.every((term) => text.includes(term));
}
