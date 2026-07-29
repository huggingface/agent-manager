export type SessionState = 'working' | 'waiting' | 'idle' | 'stopped';

export interface Session {
  id: string;
  name: string;
  cli: string;
  // Workspace-relative folder the agent runs in. Independent of `name` —
  // renaming never moves anything on disk. ''/null = the workspace root.
  path: string | null;
  createdAt: string;
  everStarted: boolean;
  running: boolean;
  state: SessionState;
  // Only on `cli: 'trace'` panes: what the read-only trace view is pointed at.
  // A regular agent session needs no such record — it reads its own transcript.
  traceSource?: { kind: 'session' | 'bundle'; ref: string } | null;
}

export interface Cli {
  id: string;
  label: string;
  color: string;
  available: boolean;
  ready?: boolean;
  version?: string | null;
  setup?: string | null; // how to configure it (shown on the "needs setup" hint)
}

// Pane arrangement for a group's tiles. Absent/null = auto (grow with agents).
export interface GridSpec { cols: number; rows: number }

export interface Group {
  id: string;
  name: string;
  sessionIds: string[];
  layout?: GridSpec | null;
  createdAt?: string;
}

export interface Tree {
  order: string[]; // refs: "g:<id>" | "s:<id>"
  groups: Group[];
  sessions: Session[];
}

export const STATE_LABEL: Record<SessionState, string> = {
  working: 'working',
  waiting: 'your turn',
  idle: 'idle',
  stopped: 'stopped',
};

// Mirrors PASSIVE_CLIS in server/src/config.js: panels, not processes. They have
// no trace clock, no Overview card, and never count as a group's agents.
export const PASSIVE_CLIS = ['files', 'trace'];
export const isPassive = (cli: string) => PASSIVE_CLIS.includes(cli);

export type OverviewFilter = 'all' | 'waiting' | 'working' | 'quiet';

export type MoveTarget =
  | { kind: 'into'; groupId: string }
  | { kind: 'pair'; sessionId: string }
  | { kind: 'before' | 'after'; ref: string };
