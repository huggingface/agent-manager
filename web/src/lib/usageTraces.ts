import type { SessionTraces } from '../api';

export type TraceSortKey = 'agent' | 'turns' | 'prompts' | 'tools' | 'web' | 'tokensIn' | 'tokensOut' | 'lastTs';
export type TraceSortDirection = 'asc' | 'desc';
export interface TraceSort { key: TraceSortKey; direction: TraceSortDirection }

export const DEFAULT_TRACE_SORT: TraceSort = { key: 'lastTs', direction: 'desc' };

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export const firstTraceSortDirection = (key: TraceSortKey): TraceSortDirection =>
  key === 'agent' ? 'asc' : 'desc';

export const hasRecordedTokens = (session: SessionTraces) =>
  session.tokensIn !== 0 || session.tokensOut !== 0 || session.cacheRead !== 0;

const nameThenId = (a: SessionTraces, b: SessionTraces) =>
  names.compare(a.name, b.name) || names.compare(a.id, b.id);

const numericValue = (session: SessionTraces, key: Exclude<TraceSortKey, 'agent'>) => {
  if (key === 'tools') return session.toolCalls;
  return session[key];
};

export function visibleTraceSessions(sessions: readonly SessionTraces[], sort: TraceSort): SessionTraces[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return sessions.filter(hasRecordedTokens).sort((a, b) => {
    if (sort.key === 'agent') return direction * nameThenId(a, b);

    if (sort.key === 'lastTs') {
      const aKnown = Number.isFinite(a.lastTs) && a.lastTs > 0;
      const bKnown = Number.isFinite(b.lastTs) && b.lastTs > 0;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (!aKnown) return nameThenId(a, b);
    }

    const value = numericValue(a, sort.key) - numericValue(b, sort.key);
    return value === 0 ? nameThenId(a, b) : direction * value;
  });
}
