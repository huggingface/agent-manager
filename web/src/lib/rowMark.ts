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
 */
export function rowMark(s: Pick<Session, 'state' | 'inputRequired'>, unread: boolean): RowMark {
  if (s.state === 'stopped') return 'off';
  if (s.inputRequired) return 'blocked';
  if (s.state === 'working') return 'working';
  return unread ? 'unread' : 'read';
}

