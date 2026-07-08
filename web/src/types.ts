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

export type OverviewFilter = 'all' | 'waiting' | 'working' | 'quiet';

export type MoveTarget =
  | { kind: 'into'; groupId: string }
  | { kind: 'pair'; sessionId: string }
  | { kind: 'before' | 'after'; ref: string };
