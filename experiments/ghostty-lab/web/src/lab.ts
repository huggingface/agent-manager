export const CTRL = '\x00\x00LAB:';

export type PanelInfo = {
  id: string;
  mode: 'classic' | 'ghostty';
  label: string;
  sub: string;
  dir: string;
  notes: string[];
  alive?: boolean;
  held?: boolean;
};

export type Config = {
  cols: number;
  rows: number;
  tmux: boolean;
  ghostty: { ok: boolean; error?: string; packageVersion?: string; ghosttyVersion?: string; platform?: string; arch?: string };
  panels: PanelInfo[];
};

export type Marks = Record<string, number>;

// fixed: grid pinned, font scales to it, PTY never resized (the design's claim
// that a viewer can zoom without touching the session).
// reflow: font pinned, grid follows the container, PTY resized — what production
// does today, and the only mode that actually exercises reflow.
export type FitMode = 'fixed' | 'reflow';

export type PanelState = {
  state: 'working' | 'waiting' | 'idle' | 'stopped';
  method: string;
  readMs: number;
  ageSecs?: number | null;
  bells?: number;
  avgSampleMs?: number;
  samples?: number;
};

export type ResizeStat = {
  from: string;
  to: string;
  settleMs: number;
  bytes: number;
};

export type ServerInfo = {
  snapshotMs: number;
  ansiMs: number;
  ansiBytes: number;
  htmlBytes: number;
  replayBytes: number;
  replayTruncated: boolean;
  cols: number;
  rows: number;
  heldForMs: number;
  bytesFed: number;
  avgFeedUs: number;
};

export type Run = {
  at: number;
  panel: string;
  marks: Marks;
  server?: ServerInfo;
};

// The interesting number is "how long from opening the lab until the screen is
// actually back", so every mark is relative to panel mount, not to socket open.
export const MARK_LABELS: Record<string, string> = {
  engine: 'engine ready',
  ws: 'socket open',
  first: 'first frame',
  preview: 'server preview',
  paint: 'screen back',
};

export const MARK_ORDER = ['engine', 'ws', 'first', 'preview', 'paint'];

const RUNS_KEY = 'ghostty-lab-runs';
const MAX_RUNS = 24;

export function loadRuns(): Run[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    return raw ? (JSON.parse(raw) as Run[]) : [];
  } catch {
    return [];
  }
}

export function saveRun(run: Run) {
  try {
    const runs = [run, ...loadRuns()].slice(0, MAX_RUNS);
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch {
    /* private mode, quota — the lab still works without history */
  }
}

export function clearRuns() {
  try { localStorage.removeItem(RUNS_KEY); } catch {}
}

export const ms = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n)}ms`);

export function median(values: number[]): number | undefined {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const THEME = {
  background: '#0e1217',
  foreground: '#c6d0d8',
  cursor: '#43c98a',
  cursorAccent: '#0e1217',
  selectionBackground: '#2bb3bd44',
  green: '#43c98a',
  brightGreen: '#5fe0a0',
  cyan: '#5fd0d8',
  brightCyan: '#7fe3ea',
  blue: '#6ea8fe',
  brightBlue: '#8cbcff',
  red: '#e0726a',
  yellow: '#e0a948',
};

export const FONT_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
