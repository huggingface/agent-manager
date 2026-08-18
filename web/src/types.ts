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
  // Only on `cli: 'remote'` panes: the slug that is both the folder and the API
  // address, plus the off switch and whatever the agent said about itself.
  remote?: { name: string; paused?: boolean; peer?: RemotePeer | null } | null;
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
  // Refs the operator hid from the OVERVIEW — same vocabulary as `order`, so one
  // list covers a whole group and a single agent. Server-side and deliberate:
  // unlike archiving it never expires and does not care what state the agent is
  // in. The sidebar ignores it entirely; that is the way back. See
  // server/src/hidden.js.
  hidden: string[];
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

// A remote agent: a conversation with an agent running on another machine. It is
// an agent (card, digest, light) but has no process here, so it is NOT passive
// and NOT a terminal — see docs/remote-agents.md.
export const isRemote = (cli: string) => cli === 'remote';

// Harnesses whose traces the Hub renders natively, so a share ships the file
// verbatim (mirrors SHAREABLE_CLIS in server/src/share.js). The others need
// converters first, and a button that always fails is worse than no button.
export const SHAREABLE_CLIS = ['claude', 'codex', 'hermes', 'opencode', 'openclaw'];
export const isShareable = (cli: string) => SHAREABLE_CLIS.includes(cli);

// The three states mean something different when the agent is elsewhere: there
// is no process to be "stopped", only a connection that is or isn't there.
export const REMOTE_STATE_LABEL: Record<SessionState, string> = {
  working: 'working',
  waiting: 'listening',
  idle: 'listening',
  stopped: 'not connected',
};

export interface RemoteMessage {
  seq: number;
  role: 'user' | 'agent' | 'system';
  from: string;
  at?: string;
  text: string;
}

export interface RemotePeer {
  harness: string | null;
  cwd: string | null;
  host: string | null;
  at: string;
}

export interface RemoteInfo {
  name: string;
  paused: boolean;
  peer: RemotePeer | null;
  connected: boolean;
  polls: number;
  lastSeenAt: number | null;
  seq: number;
  // Highest seq a poll actually handed to the agent — the pane's ✓ comes from
  // this and claims nothing beyond it.
  deliveredThrough: number;
  state: SessionState;
}

// Which bucket an agent falls in — one per meaningful state, plus `all`. This is
// the granular representation and it stays granular: bucket() in
// components/Overview.tsx puts a session in one, and the working/waiting split is
// load-bearing well outside the filter (atWork(), the card's "running" line, the
// sorted feed's pinned block).
export type OverviewFilter = 'all' | 'waiting' | 'working' | 'quiet';

// What the Overview's bottom bar OFFERS. A chip is something you can click; a
// bucket is a state an agent can be in, and the two are NOT one-to-one: `started`
// covers the same agents as `done` and `running` together, the way `all` covers
// everything. Chips may overlap because exactly one is ever selected.
//
// Deliberately a separate type rather than two more OverviewFilter members: on
// one type `started` and `working` would both be selectable spellings of an
// overlapping set, and every consumer of the granular value (atWork(), the card's
// "running" line, the pinned at-work block) would have to know which spelling it
// was handed. Here the widening lives in one function and nothing downstream
// changes.
export type OverviewChip = 'all' | 'done' | 'running' | 'started' | 'stopped';

// The buckets a chip covers. Pure, and the only place the widening happens.
export const chipBuckets = (chip: OverviewChip): OverviewFilter[] =>
  chip === 'done' ? ['waiting']
  : chip === 'running' ? ['working']
  : chip === 'started' ? ['waiting', 'working']
  : chip === 'stopped' ? ['quiet']
  : ['waiting', 'working', 'quiet'];

// How the Overview is ordered. `manual` is the tree's own arrangement — groups
// as capsules, agents where you put them; the other two flatten that and rank
// every agent by a timestamp from its digest. See web/src/lib/overviewSort.ts.
export type OverviewSort = 'manual' | 'prompt' | 'answer';

export type MoveTarget =
  | { kind: 'into'; groupId: string }
  | { kind: 'pair'; sessionId: string }
  | { kind: 'before' | 'after'; ref: string };
