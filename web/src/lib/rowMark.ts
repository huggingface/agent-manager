// What the sidebar's logo frame says about a session (#242).
//
// The frame only draws when something is going on or wants the operator: a
// spinner while busy, red when the CLI is waiting on a dialog, the accent
// colour for a reply not yet read. A running agent that has nothing new shows
// a bare logo, and one that is not running fades its whole row. Elsewhere
// (pane headers, Overview) the frame keeps the plain SessionState vocabulary.
import type { Session } from '../types';

export type RowMark = 'working' | 'blocked' | 'unread' | 'read' | 'off';

/**
 * Precedence, highest first: not running, needs input, busy, unread, read.
 *
 * Busy masks unread on purpose: a streaming answer changes its hash on every
 * poll, so an agent mid-turn would otherwise flicker between the two. Its
 * unread state is untouched and shows as soon as the turn ends.
 *
 * `settling` is an agent that just stopped working whose reply the read
 * tracking has not caught up with yet (see `leftWorking`). It keeps the spinner
 * for that moment so the frame goes straight from working to done (or to read)
 * instead of dropping to a bare logo first.
 */
export function rowMark(s: Pick<Session, 'state' | 'inputRequired'>, unread: boolean, settling = false): RowMark {
  if (s.state === 'stopped') return 'off';
  if (s.inputRequired) return 'blocked';
  if (s.state === 'working' || settling) return 'working';
  return unread ? 'unread' : 'read';
}


/**
 * The sessions that were working in `prev` and are not any more.
 *
 * The tree (state) and /api/meta (read tracking) are polled separately, so the
 * tree routinely says an agent has finished before meta has seen its reply.
 * The caller holds these as settling and fetches meta at once.
 */
export function leftWorking(
  prev: ReadonlyMap<string, Session['state']>,
  sessions: Pick<Session, 'id' | 'state'>[],
): string[] {
  return sessions.filter((s) => prev.get(s.id) === 'working' && s.state !== 'working').map((s) => s.id);
}
