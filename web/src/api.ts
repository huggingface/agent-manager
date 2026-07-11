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
export const quickStart = (cli: string, prompt: string): Promise<Session> =>
  fetch('/api/sessions', { method: 'POST', headers: HEADERS, body: JSON.stringify({ cli, path: '.', prompt }) }).then(json);

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
export const getUsage = (): Promise<Usage> => fetch('/api/usage').then(json);

// ---- overview (meta) ----
export interface TurnEntry { answer: string; answerMd: string; ts: number; }
export interface MetaDigest {
  lastPromptText: string; lastPromptTs: number;
  lastAssistantText: string; lastAssistantMd: string; lastAssistantTs: number;
  sinceTurns: number; sinceToolCalls: number; sinceTools: Record<string, number>; sinceFiles: string[];
  sinceTokens: number;
  running?: boolean;        // task in flight (codex task_started/task_complete)
  turnsLog?: TurnEntry[];   // newest-first history of completed exchanges
}
export interface MetaSession extends Session { digest: MetaDigest | null }
export const getMeta = (): Promise<{ sessions: MetaSession[]; generatedAt: string }> =>
  fetch('/api/meta').then(json);
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

// ---- skills ----
export interface SkillFile { name: string; size: number; }
export const listSkills = (): Promise<SkillFile[]> => fetch('/api/skills').then(json);
export const getSkill = (name: string): Promise<{ name: string; content: string }> =>
  fetch(`/api/skills/${encodeURIComponent(name)}`).then(json);
export const saveSkill = (name: string, content: string) =>
  fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content }).then(json);
export const deleteSkill = (name: string) =>
  fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json);
