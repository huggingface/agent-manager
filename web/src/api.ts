import type { Cli, Group, MoveTarget, Session, Tree } from './types';

const HEADERS = { 'content-type': 'application/json' };
const json = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export const getClis = (): Promise<Cli[]> => fetch('/api/clis').then(json);
export const getTree = (): Promise<Tree> => fetch('/api/tree').then(json);

// path: '.' = the workspaces root; anything else is a workspace-relative dir.
const normalizePath = (path?: string) => (path && path.trim() ? path : '.');
// Quickstart: create at the workspaces root, boot the CLI, and type the prompt
// as soon as it's up — all server-side, no waiting in the UI.
export const quickStart = (cli: string, prompt: string, name = '', path = '.'): Promise<Session> =>
  fetch('/api/sessions', { method: 'POST', headers: HEADERS, body: JSON.stringify({ cli, name: name || undefined, path: path || '.', prompt: prompt || undefined }) }).then(json);

export const createSession = (name: string, cli: string, groupId?: string, path?: string): Promise<Session> =>
  fetch('/api/sessions', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name, cli, groupId, path: normalizePath(path) }) }).then(json);

export const listFolders = (p = ''): Promise<{ path: string; folders: string[] }> =>
  fetch(`/api/folders?path=${encodeURIComponent(p)}`).then(json);

export const stopSession = (id: string) =>
  fetch(`/api/sessions/${id}/stop`, { method: 'POST' }).then(json);

export const deleteSession = (id: string) =>
  fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(json);

export const renameSession = (id: string, name: string) =>
  fetch(`/api/sessions/${id}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ name }) }).then(json);

export const createGroup = (name: string): Promise<Group> =>
  fetch('/api/groups', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name }) }).then(json);

export const renameGroup = (id: string, name: string) =>
  fetch(`/api/groups/${id}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ name }) }).then(json);

// Generic group patch: pane order (sessionIds) and/or tile layout (null = auto).
export const updateGroup = (id: string, patch: { sessionIds?: string[]; layout?: { cols: number; rows: number } | null }) =>
  fetch(`/api/groups/${id}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify(patch) }).then(json);

export const deleteGroup = (id: string) =>
  fetch(`/api/groups/${id}`, { method: 'DELETE' }).then(json);

export const move = (ref: string, to: MoveTarget) =>
  fetch('/api/move', { method: 'POST', headers: HEADERS, body: JSON.stringify({ ref, to }) }).then(json);

export const getInfo = () => fetch('/api/info').then(json);

export const dismissWelcome = () => fetch('/api/welcome/seen', { method: 'POST' }).then(json);

export const setDemo = (active: boolean): Promise<{ ok: boolean; active: boolean }> =>
  fetch('/api/demo', { method: 'POST', headers: HEADERS, body: JSON.stringify({ active }) }).then(json);

export const relaunchSpace = (): Promise<{ ok: boolean; reason?: string }> =>
  fetch('/api/relaunch', { method: 'POST' }).then(json);

// ---- app self-update from the upstream repo ----
export interface UpdateCheck {
  ok: boolean; reason?: string; source?: string; sourceUrl?: string;
  current?: string | null; latest?: string | null; behind?: boolean; canUpdate?: boolean;
}
export const checkUpdate = (): Promise<UpdateCheck> => fetch('/api/update/check').then(json);
export const runUpdate = (): Promise<{ ok: boolean; reason?: string; upToDate?: boolean }> =>
  fetch('/api/update', { method: 'POST' }).then(json);

export interface AmConfig {
  artifacts: { enabled: boolean; space: string; visibility: 'public' | 'private' };
  jobs: { askAboveUsd: number };
  archive: { after: 'week' | 'month' | 'never' };
  defaultArtifactsSpace?: string;
}
export const getConfig = (): Promise<AmConfig> => fetch('/api/config').then(json);
export const saveConfig = (c: AmConfig) =>
  fetch('/api/config', { method: 'PUT', headers: HEADERS, body: JSON.stringify(c) }).then(json);

export interface SecretsData { detected: string[]; notes: Record<string, string>; }
export const getSecrets = (): Promise<SecretsData> => fetch('/api/secrets').then(json);
export const saveSecrets = (notes: Record<string, string>) =>
  fetch('/api/secrets', { method: 'PUT', headers: HEADERS, body: JSON.stringify({ notes }) }).then(json);

export interface QuotaWindow { usedPercent?: number; resetsAt?: number; windowMinutes?: number; }
export interface ProviderUsage {
  tokensToday?: number; costToday?: number; tokensWeek?: number; costWeek?: number; totalCost?: number;
  quota?: { fiveHour?: QuotaWindow; weekly?: QuotaWindow; opus?: QuotaWindow; updatedAt?: number; source?: 'live' | 'snapshot' } | null;
}
export interface Usage { providers: Record<string, ProviderUsage>; generatedAt: string; }
export const getUsage = (provider?: string): Promise<Usage> => fetch(provider ? `/api/usage?provider=${provider}` : '/api/usage').then(json);

// ---- overview (meta) ----
export interface TurnEntry { answer: string; answerMd: string; ts: number; }
export interface MetaDigest {
  lastPromptText: string; lastPromptRaw?: string; lastPromptTs: number;
  lastAssistantText: string; lastAssistantMd: string; lastAssistantTs: number;
  sinceTurns: number; sinceToolCalls: number; sinceTools: Record<string, number>; sinceFiles: string[];
  sinceTokens: number;
  running?: boolean;        // task in flight (codex task_started/task_complete)
  turnsLog?: TurnEntry[];   // newest-first history of completed exchanges
}
export interface MetaSession extends Session { digest: MetaDigest | null }
export const getMeta = (): Promise<{ sessions: MetaSession[]; generatedAt: string }> =>
  fetch('/api/meta').then(json);
// Targeted digest for one session (progressive tile fill); digest is null when
// this CLI only resolves through the bulk pass.
export const getMetaOne = (id: string): Promise<{ id: string; digest: MetaDigest | null }> =>
  fetch(`/api/meta/${id}`).then(json);
export const sendInput = (id: string, text: string): Promise<{ ok: boolean; started?: boolean }> =>
  fetch(`/api/sessions/${id}/input`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ text }) }).then(json);

// ---- push notifications ----
export const getPushKey = (): Promise<{ publicKey: string; devices: number }> =>
  fetch('/api/push/key').then(json);
export const subscribePush = (subscription: PushSubscription) =>
  fetch('/api/push/subscribe', { method: 'POST', headers: HEADERS, body: JSON.stringify({ subscription }) }).then(json);
export const unsubscribePush = (endpoint: string) =>
  fetch('/api/push/unsubscribe', { method: 'POST', headers: HEADERS, body: JSON.stringify({ endpoint }) }).then(json);
export const sendTestNotification = (): Promise<{ ok: boolean; sent: number; devices: number }> =>
  fetch('/api/notify', { method: 'POST', headers: HEADERS, body: JSON.stringify({ title: 'Agent Manager', body: 'Test notification — agents can reach this device.' }) }).then(json);

// ---- trace analytics ----
export interface TraceStats {
  turns: number; prompts: number; toolCalls: number; tools: Record<string, number>;
  web: number; tokensIn: number; tokensOut: number; cacheRead: number;
  firstTs: number; lastTs: number; files: number;
}
export interface SessionTraces extends TraceStats { id: string; name: string; cli: string; path: string | null; }
export interface Traces { sessions: SessionTraces[]; totals: TraceStats; generatedAt: string; }
export const getTraces = (): Promise<Traces> => fetch('/api/traces').then(json);

// ---- files ----
export interface FileEntry { name: string; dir: boolean; size: number; }
export interface FileListing { path: string; root: string; entries: FileEntry[]; }

export const listFiles = (id: string, p = ''): Promise<FileListing> =>
  fetch(`/api/files/${id}?path=${encodeURIComponent(p)}`).then(json);

export const uploadFile = (id: string, p: string, file: File) =>
  fetch(`/api/files/${id}/upload?path=${encodeURIComponent(p)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
  }).then(json);

export const downloadUrl = (id: string, p: string) =>
  `/api/files/${id}/download?path=${encodeURIComponent(p)}`;

// Folder edits carry a reason when they fail ("already exists", "that folder is
// …"), and the file browser shows it inline — so these use fileErr, not json.
const fileErr = async (r: Response) => {
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `${r.status}`);
  return body;
};

export const createFolder = (id: string, parent: string, name: string) =>
  fetch(`/api/files/${id}/mkdir?path=${encodeURIComponent(parent)}&name=${encodeURIComponent(name)}`,
    { method: 'POST' }).then(fileErr);

export const renameEntry = (id: string, p: string, name: string) =>
  fetch(`/api/files/${id}/rename?path=${encodeURIComponent(p)}&name=${encodeURIComponent(name)}`,
    { method: 'POST' }).then(fileErr);

export const deleteEntry = (id: string, p: string) =>
  fetch(`/api/files/${id}/entry?path=${encodeURIComponent(p)}`, { method: 'DELETE' }).then(fileErr);

// ---- session sharing (docs/session-sharing.md) ----
export interface ShareInfo {
  namespace: string | null;
  canShare: boolean;
  reason: 'no-hf-token' | 'unsupported-cli' | 'no-transcript' | null;
  lastShare: { repo: string; sha: string | null; visibility: string; at: string } | null;
}
export interface ShareResult {
  repo: string;
  visibility: 'public' | 'gated';
  url: string;
  sha: string | null;
  trace: string;
  stats: { prompts: number; turns: number; toolCalls: number };
  redaction: Record<string, number>;
  dropped: Record<string, number>;
  granted: string[];
  grantErrors: { user: string; error: string }[];
}
// Thrown when the redaction gate refuses a public share (HTTP 409). Carries the
// rule names so the dialog can say exactly what tripped instead of "failed".
export class RedactionBlocked extends Error {
  hits: Record<string, number>;
  constructor(message: string, hits: Record<string, number>) {
    super(message);
    this.name = 'RedactionBlocked';
    this.hits = hits;
  }
}

export const getShareInfo = (id: string): Promise<ShareInfo> => fetch(`/api/sessions/${id}/share`).then(json);

export const shareSession = async (
  id: string,
  body: { visibility: 'public' | 'gated'; name?: string; grantTo?: string[] },
): Promise<ShareResult> => {
  const r = await fetch(`/api/sessions/${id}/share`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  if (r.status === 409) {
    const d = await r.json().catch(() => ({}));
    throw new RedactionBlocked(d.error || 'blocked by the redaction gate', d.hits || {});
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
  return r.json();
};

export interface ShareAccess { accepted: string[]; pending: string[] }
export const getShareAccess = (repo: string): Promise<ShareAccess> =>
  fetch(`/api/share/access?repo=${encodeURIComponent(repo)}`).then(json);
export const updateShareAccess = (repo: string, patch: { grant?: string[]; revoke?: string[] }): Promise<ShareAccess> =>
  fetch('/api/share/access', { method: 'POST', headers: HEADERS, body: JSON.stringify({ repo, ...patch }) }).then(json);

// ---- trace panel (docs/trace-panel-spec.md) ----
// Blocks, not fields: one renderer handles every harness, and a tool result can
// be filed next to its call even when parallel tools finish out of order.
export type TraceBlock =
  | { type: 'text'; text: string; more?: number }
  | { type: 'thinking'; text: string; more?: number }
  | { type: 'tool_use'; id?: string; name: string; text: string; more?: number }
  | { type: 'tool_result'; id?: string; text: string; more?: number; failed?: boolean }
  | { type: 'shell'; command: string; stdout?: string; stderr?: string; exitCode?: number }
  | { type: 'image'; src: string; mediaType?: string }
  | { type: 'compaction'; text: string };

export interface TraceTurn {
  role: 'user' | 'assistant' | 'system';
  kind?: 'final' | 'update';
  ts?: number;
  model?: string;
  usage?: { in: number; out: number; cacheRead?: number };
  blocks: TraceBlock[];
}

export interface TracePage {
  harness: string;
  harnessLabel: string;
  sessionId: string | null;
  title: string;
  model: string | null;
  cwd: string | null;
  firstTs: number;
  lastTs: number;
  usage: { in: number; out: number; cacheRead?: number } | null;
  // Bundles only: where this trace came from, and who shared it.
  source?: { repo: string | null; url: string | null; importedAt: string | null } | null;
  sharedBy?: string | null;
  // Something true about this trace that isn't a turn — e.g. reasoning the model
  // encrypted, which is absent rather than empty.
  note?: string | null;
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  // Indices of the operator's prompts across the WHOLE session, so the pane can
  // jump to one that hasn't been fetched yet.
  userTurns: number[];
  turns: TraceTurn[];
}

// A 404 here is an expected state (no transcript yet, unsupported CLI, a codex
// guardian rollout), so the reason travels with it for the pane to render.
export class TraceUnavailable extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TraceUnavailable';
    this.code = code;
  }
}

export const getTracePage = async (id: string, offset = 0, limit = 200): Promise<TracePage> => {
  const r = await fetch(`/api/trace/${id}?offset=${offset}&limit=${limit}`);
  if (r.status === 404) {
    const d = await r.json().catch(() => ({}));
    throw new TraceUnavailable(d.error || 'no trace for this session yet', d.code || 'no-trace');
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
  return r.json();
};

export interface TraceLocation {
  path: string;
  sessionId?: string | null;
  source: { kind: 'session' | 'bundle'; ref: string };
}
export const getTraceLocation = async (id: string): Promise<TraceLocation> => {
  const r = await fetch(`/api/trace/${id}/location`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
  return r.json();
};

// Receiving: pull a shared trace off the Hub so a pane can render it. Accepts a
// bare dataset id or a pasted dataset URL (the server normalizes).
export interface ImportedBundle {
  ref: string; repo: string; sha: string; files: string[]; bytes: number;
  manifest?: { harness?: { name?: string; id?: string }; session?: { name?: string }; origin?: { user?: string } } | null;
}
export const importTraceBundle = async (repo: string): Promise<ImportedBundle> => {
  const r = await fetch('/api/trace/import', { method: 'POST', headers: HEADERS, body: JSON.stringify({ repo }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
  return r.json();
};

export interface BundleEntry {
  ref: string; repo: string | null; url: string | null; importedAt: string | null;
  harness: string | null; name: string | null; from: string | null;
}
export const listTraceBundles = (): Promise<{ bundles: BundleEntry[] }> => fetch('/api/trace/bundles').then(json);

export const setTraceSource = (id: string, kind: 'session' | 'bundle', ref: string) =>
  fetch(`/api/trace/${id}/source`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ kind, ref }) }).then(json);

// ---- skills ----
export interface SkillFile { name: string; size: number; }
export const listSkills = (): Promise<SkillFile[]> => fetch('/api/skills').then(json);
export const getSkill = (name: string): Promise<{ name: string; content: string }> =>
  fetch(`/api/skills/${encodeURIComponent(name)}`).then(json);
export const saveSkill = (name: string, content: string) =>
  fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content }).then(json);
export const deleteSkill = (name: string) =>
  fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json);
