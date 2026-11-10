// The sidebar's status column: one mark per session row, herdr-style (#242).
//
// One pure function decides what a row shows, so the precedence lives in one
// place and is unit-tested (web/test/rowStatus.test.mjs) instead of being
// spelled out in JSX. It reads only `state` and `inputRequired` from the tree:
// shared Codex sessions already have both replaced by the server's
// sessionRuntime.presentation, while `running` / `terminalRunning` mean
// different things for different transports and are not used here.
import type { InputRequired, SessionState } from '../types';
import { isPassive, isRemote, REMOTE_STATE_LABEL } from '../types';

export type RowStatusKind =
  | 'stopped'   // no mark; the row is dimmed
  | 'blocked'   // needs input (permission / question / confirmation)
  | 'working'   // spinner
  | 'done'      // finished, with a reply the operator has not read yet
  | 'idle'      // alive and finished, nothing unread
  | 'shell'     // a quiet shell: no agent state to report
  | 'none';     // files / trace panels, or a state we do not know

export interface RowStatus {
  kind: RowStatusKind;
  /** Hover and screen-reader text; empty when there is nothing to say. */
  label: string;
}

export interface RowStatusInput {
  cli: string;
  state?: SessionState | null;
  inputRequired?: Pick<InputRequired, 'kind'> | null;
}

const ALIVE: ReadonlySet<string> = new Set(['waiting', 'idle']);

/**
 * Precedence, highest first: stopped, blocked, working, done, idle.
 *
 * - A working agent never shows done: streaming output changes the reply hash,
 *   so "unread" is true for the whole of a turn and working has to mask it.
 * - A quiet shell shows `·`, never done or idle: shells have no reply tracking
 *   and no agent state. A shell producing output still gets the spinner.
 * - Files and trace panels show nothing.
 * - A remote agent keeps its own wording (listening / not connected).
 */
export function rowStatus(s: RowStatusInput, unread = false): RowStatus {
  if (isPassive(s.cli)) return { kind: 'none', label: '' };
  const remote = isRemote(s.cli);
  const state = s.state;
  if (state === 'stopped') return { kind: 'stopped', label: remote ? REMOTE_STATE_LABEL.stopped : 'stopped' };
  if (s.inputRequired) return { kind: 'blocked', label: `needs input: ${s.inputRequired.kind}` };
  if (state === 'working') return { kind: 'working', label: 'working' };
  if (!state || !ALIVE.has(state)) return { kind: 'none', label: '' };
  if (s.cli === 'shell') return { kind: 'shell', label: 'shell, quiet' };
  if (unread) return { kind: 'done', label: 'done: new reply not yet read' };
  return { kind: 'idle', label: remote ? REMOTE_STATE_LABEL[state] : 'idle' };
}

/**
 * The row's own classes for a status: a stopped row is dimmed (it has no mark
 * to say so), and the two states asking for the operator brighten the name.
 */
export const rowStatusClass = ({ kind }: RowStatus): string =>
  kind === 'stopped' ? ' row-stopped' : kind === 'blocked' || kind === 'done' ? ' row-attn' : '';

/** The marks the legend explains, in the order the legend shows them. */
export const LEGEND: { kind: RowStatusKind; label: string }[] = [
  { kind: 'working', label: 'working' },
  { kind: 'blocked', label: 'needs input' },
  { kind: 'done', label: 'done' },
  { kind: 'idle', label: 'idle' },
  { kind: 'shell', label: 'shell' },
];
