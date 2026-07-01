export type SessionState = 'working' | 'waiting' | 'idle' | 'stopped';

export interface Session {
  id: string;
  name: string;
  cli: string;
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
}

export interface Group {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt?: string;
}

export interface Tree {
  order: string[]; // refs: "g:<id>" | "s:<id>"
  groups: Group[];
  sessions: Session[];
}

// "waiting" and "idle" are shown identically (grey, "idle").
export const STATE_LABEL: Record<SessionState, string> = {
  working: 'working',
  waiting: 'idle',
  idle: 'idle',
  stopped: 'stopped',
};

export type MoveTarget =
  | { kind: 'into'; groupId: string }
  | { kind: 'pair'; sessionId: string }
  | { kind: 'before' | 'after'; ref: string };
