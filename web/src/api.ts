import type { Cli, Group, MoveTarget, RemoteInfo, RemoteMessage, Session, Tree } from './types';

const HEADERS = { 'content-type': 'application/json' };
// The browser is the single human operator. Stamp every state-changing request
// in one place so new API helpers cannot accidentally create unattributed work.
const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const method = String(init?.method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-am-origin', 'operator');
  return globalThis.fetch(input, { ...init, headers });
};
// Like `json`, but keeps the server's own words — these routes fail for reasons
// worth reading ("already exists here").
const jsonOrError = async (r: Response) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
};

const json = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export const getClis = (): Promise<Cli[]> => fetch('/api/clis').then(json);
export const getTree = (): Promise<Tree> => fetch('/api/tree').then(json);

// Hide a group (or one agent) from the Overview. `ref` is a tree ref — `g:<id>`
// or `s:<id>`. Persisted server-side, so it holds on every device.
export const setOverviewHidden = (ref: string, hidden: boolean): Promise<{ hidden: string[] }> =>
  fetch('/api/overview/hidden', { method: 'POST', headers: HEADERS, body: JSON.stringify({ ref, hidden }) }).then(json);

// path: '.' = the workspaces root; anything else is a workspace-relative dir.
const normalizePath = (path?: string) => (path && path.trim() ? path : '.');
// Quickstart: create at the workspaces root, boot the CLI, and type the prompt
// as soon as it's up — all server-side, no waiting in the UI.
export const quickStart = (cli: string, prompt: string, name = '', path = '.'): Promise<Session> =>
  fetch('/api/sessions', { method: 'POST', headers: HEADERS, body: JSON.stringify({ cli, name: name || undefined, path: path || '.', prompt: prompt || undefined }) }).then(json);

// The name this cli would get if created now. Used to prefill the create
// panel; the panel only SENDS a name when the operator edits it, so the server
// still decides for an untouched field.
export const nextName = (cli: string): Promise<{ cli: string; name: string }> =>
  fetch(`/api/next-name?cli=${encodeURIComponent(cli)}`).then(json);

export const createSession = (name: string, cli: string, groupId?: string, path?: string): Promise<Session> =>
  fetch('/api/sessions', { method: 'POST', headers: HEADERS, body: JSON.stringify({ name, cli, groupId, path: normalizePath(path) }) }).then(json);

export const listFolders = (p = ''): Promise<{ path: string; folders: string[] }> =>
  fetch(`/api/folders?path=${encodeURIComponent(p)}`).then(json);

export const stopSession = (id: string) =>
  fetch(`/api/sessions/${id}/stop`, { method: 'POST' }).then(json);

// Put a session away: it stops, and it leaves the working list. The server
// refuses to delete anything that has not been through here first.
export const archiveSession = (id: string) =>
  fetch(`/api/sessions/${id}/archive`, { method: 'POST' }).then(json);

export const unarchiveSession = (id: string) =>
  fetch(`/api/sessions/${id}/unarchive`, { method: 'POST' }).then(json);

// Pinning: keeps a session or a whole group above the sidebar's rule, and out of
// the idle window's reach. One call per direction rather than a toggle, so a
// double click or a stale row cannot flip it to the opposite of what was on
// screen.
export const pinSession = (id: string, pinned: boolean) =>
  fetch(`/api/sessions/${id}/${pinned ? 'pin' : 'unpin'}`, { method: 'POST' }).then(json);

export const pinGroup = (id: string, pinned: boolean) =>
  fetch(`/api/groups/${id}/${pinned ? 'pin' : 'unpin'}`, { method: 'POST' }).then(json);

// Keeps the server's own words: refusing to delete a session that is not
// archived is an ordinary, explainable answer, not a failure.
export const deleteSession = (id: string) =>
  fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then(jsonOrError);

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

// Present only when a backup is unwell; null the rest of the time, so the
// dashboard shows nothing in the normal case.
export interface BackupHealth {
  failing: boolean; stale: boolean; failures: number;
  at: number | null; jobId: string | null; stage: string | null;
  message: string | null; reason: string | null;
  lastSuccessAt: number | null; jobsUrl: string;
}
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
  // After a restart, sessions that were running come back if you prompted them
  // within `days` (or had work still in flight).
  revive: { enabled: boolean; days: 1 | 3 | 7 };
  backup: { every: BackupEvery; dataset: string; exclude: string[] };
  defaultArtifactsSpace?: string;
}
export const getConfig = (): Promise<AmConfig> => fetch('/api/config').then(json);
export const saveConfig = (c: AmConfig) =>
  fetch('/api/config', { method: 'PUT', headers: HEADERS, body: JSON.stringify(c) }).then(json);

// ---- durable scheduled prompts ----
export type CronState = 'running' | 'stopped';
export interface CronJob {
  id: string;
  name: string;
  agent: { name: string; cli: string };
  prompt: string;
  schedule: { cron: string; tz: string };
  runOnRestart: boolean;
  state: CronState;
  createdAt: string;
  updatedAt: string;
  next: string | null;
  last?: {
    at: string;
    status: 'ok' | 'failed';
    durationMs: number;
    trigger?: 'schedule' | 'restart' | 'manual';
    error?: string;
  };
}
export type CronDraft = Pick<CronJob, 'name' | 'agent' | 'prompt' | 'schedule' | 'runOnRestart'>;
export const getCrons = (): Promise<{ crons: CronJob[] }> => fetch('/api/crons').then(jsonOrError);
export const createCron = (job: CronDraft): Promise<CronJob> =>
  fetch('/api/crons', { method: 'POST', headers: HEADERS, body: JSON.stringify(job) }).then(jsonOrError);
export const updateCron = (id: string, patch: Partial<CronDraft & { state: CronState }>): Promise<CronJob> =>
  fetch(`/api/crons/${encodeURIComponent(id)}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify(patch) }).then(jsonOrError);
export const runCron = (id: string): Promise<{ ok: boolean; agentCreated: boolean }> =>
  fetch(`/api/crons/${encodeURIComponent(id)}/run`, { method: 'POST' }).then(jsonOrError);
export const deleteCron = (id: string): Promise<{ ok: boolean }> =>
  fetch(`/api/crons/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(jsonOrError);

// ---- bucket backup: a Job on the Hub does the copying (docs/bucket-backup.md) ----
export type BackupEvery = 'never' | '1h' | '3h' | '24h';
export interface BackupStatus {
  every: BackupEvery;
  source: string | null;
  staging: string;
  dataset: string;
  defaults: { dataset: string; staging: string };
  hasToken: boolean;
  canRunNow: boolean;
  running: boolean;
  unavailable: string | null;
  // stage is null when the Hub did not answer — never guessed.
  last: { at: number; jobId: string | null; stage: string | null } | null;
  // One static URL lists every run by its `name=` label, so the row never
  // needs a job id to link to them.
  jobName: string;
  jobsUrl: string;
  // The tokens as stored, and the globs they expand to.
  exclude: string[];
  excludeDefaults: string[];
  excludeIsDefault: boolean;
  health: BackupHealth | null;
  failures: number;
  lastFailure: { at: number; jobId: string; stage: string; message: string | null; reason: string | null } | null;
  lastSuccessAt: number | null;
  nextDue: number | null;
  datasetPrivate: boolean | null;
  error: string | null;
}
export const backupStatus = (): Promise<BackupStatus> => fetch('/api/backup/status').then(json);
// jsonOrError, not json: the refusals worth showing ("a backup is already
// running") are in the body, and json() throws them away for a bare status.
export const runBackup = (): Promise<{ job?: string }> =>
  fetch('/api/backup/run', { method: 'POST' }).then(jsonOrError);

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
// ---------- remote agents ----------
// The pane polls this at the app's usual 2 s cadence. since=0 returns the tail;
// a cursor returns only the delta.
export const getRemoteLog = (id: string, since = 0): Promise<RemoteInfo & { messages: RemoteMessage[] }> =>
  fetch(`/api/sessions/${id}/remote?since=${since}`).then(json);

// The operator's turn goes through the same route a local agent's does, so the
// server's deliver() shim decides what "typing at it" means.
export const sayToRemote = (id: string, text: string) => sendInput(id, text);

// text/plain, and free of secrets by design — safe to put on a clipboard.
export const getRemotePrompt = (name: string): Promise<string> =>
  fetch(`/api/remote/${encodeURIComponent(name)}/prompt`).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.text();
  });

export const setRemotePaused = (id: string, paused: boolean): Promise<RemoteInfo> =>
  fetch(`/api/sessions/${id}/remote/paused`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ paused }) }).then(json);

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  bytes: number;
  path: string;
  previewUrl: string;
  insertText: string;
}

export interface AttachmentUploadProgress { loaded: number; total: number }
export interface AttachmentUploadOptions {
  onProgress?: (progress: AttachmentUploadProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;

const attachmentUploadError = (request: XMLHttpRequest) => {
  let detail = '';
  try {
    const body = JSON.parse(request.responseText || '{}');
    if (typeof body?.error === 'string') detail = body.error;
  } catch { /* An ingress/proxy error can be HTML. Classify it by status below. */ }
  if (detail) return detail;
  if (request.status === 413) return 'The server or its proxy rejected this file as too large (HTTP 413). Try a smaller file.';
  if (request.status === 408 || request.status === 504) return `The upload timed out (HTTP ${request.status}). Check the connection and retry.`;
  if (request.status === 429) return 'Too many uploads at once (HTTP 429). Wait a minute, then retry.';
  if (request.status >= 500) return `The upload server failed (HTTP ${request.status}). Retry in a moment.`;
  return `Upload failed (HTTP ${request.status}${request.statusText ? ` ${request.statusText}` : ''}).`;
};

/** XMLHttpRequest is intentional: fetch has no browser upload-progress API. */
export const uploadAttachment = (
  id: string,
  file: File,
  { onProgress, signal, timeoutMs = ATTACHMENT_UPLOAD_TIMEOUT_MS }: AttachmentUploadOptions = {},
): Promise<Attachment> => new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  let settled = false;
  const finish = (task: () => void) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', abort);
    task();
  };
  const abort = () => request.abort();
  if (signal?.aborted) {
    finish(() => reject(new Error('Upload was canceled before it completed.')));
    return;
  }
  request.open('POST', `/api/sessions/${encodeURIComponent(id)}/attachments`);
  request.timeout = timeoutMs;
  request.setRequestHeader('x-am-origin', 'operator');
  request.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'Attachment'));
  if (file.type) request.setRequestHeader('content-type', file.type);
  request.upload.onprogress = (event) => onProgress?.({
    loaded: event.loaded,
    total: event.lengthComputable && event.total ? event.total : file.size,
  });
  // Some browsers coalesce every progress event for a fast/small body. The
  // upload-side load event still fires before the response, so 100% means
  // "bytes sent, awaiting server confirmation", not prematurely "stored".
  request.upload.onload = () => onProgress?.({ loaded: file.size, total: file.size });
  request.onload = () => {
    if (request.status < 200 || request.status >= 300) {
      finish(() => reject(new Error(attachmentUploadError(request))));
      return;
    }
    try {
      const attachment = JSON.parse(request.responseText) as Attachment;
      finish(() => resolve(attachment));
    } catch {
      finish(() => reject(new Error('The upload completed, but the server returned an unreadable response. Retry the file.')));
    }
  };
  request.onerror = () => finish(() => reject(new Error(
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'Upload stopped because this device is offline. Reconnect and retry.'
      : 'Upload connection was interrupted before the server confirmed the file. Check the connection and retry.',
  )));
  request.onabort = () => finish(() => reject(new Error('Upload was canceled before it completed.')));
  request.ontimeout = () => finish(() => reject(new Error(
    `Upload timed out after ${Math.round(timeoutMs / 60_000)} minutes. Check the connection and retry.`,
  )));
  signal?.addEventListener('abort', abort, { once: true });
  onProgress?.({ loaded: 0, total: file.size });
  request.send(file);
});

export const deleteAttachment = (sessionId: string, attachmentId: string): Promise<{ ok: boolean }> =>
  fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
  }).then(jsonOrError);

export const discardUnstartedSession = (id: string): Promise<{ ok: boolean }> =>
  fetch(`/api/sessions/${encodeURIComponent(id)}?ifNeverStarted=1`, { method: 'DELETE' }).then(jsonOrError);

export const insertAttachments = (
  id: string,
  attachmentIds: string[],
): Promise<{ ok: boolean; mode: 'inserted' | 'attached'; repeated?: boolean }> =>
  fetch(`/api/sessions/${id}/attachments/insert`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ attachmentIds }),
  }).then(jsonOrError);

export const sendInput = (id: string, text: string, attachmentIds: string[] = []): Promise<{ ok: boolean; started?: boolean }> =>
  fetch(`/api/sessions/${id}/input`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ text, attachmentIds }) }).then(jsonOrError);

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

/** The transcript file behind a session or trace pane. A URL, not a fetch: the
 *  browser saves it, so a 6 MB transcript never lands in a JS string first. */
export const traceDownloadUrl = (id: string) => `/api/trace/${encodeURIComponent(id)}/download`;

// ---- files ----
// 'trace' is content-detected, not name-detected: a transcript is a .jsonl like
// any other until /preview reads a line of it (see the route).
export type FileKind = 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'binary' | 'trace';
export interface FileEntry { name: string; dir: boolean; size: number; mtime: number; kind?: FileKind; }
export interface FileListing { path: string; root: string; entries: FileEntry[]; }
export interface FilePreview {
  path: string; name: string; size: number; mtime: number; kind: FileKind; mime: string;
  /** Content tag a save is checked against — null for files too big to edit. */
  tag?: string | null;
  text?: string; truncated?: boolean; reason?: string;
  /** kind==='trace': which harness wrote it (claude, codex, …). */
  harness?: string | null;
}

export const listFiles = (id: string, p = ''): Promise<FileListing> =>
  fetch(`/api/files/${id}?path=${encodeURIComponent(p)}`).then(json);

export const previewFile = (id: string, p: string): Promise<FilePreview> =>
  fetch(`/api/files/${id}/preview?path=${encodeURIComponent(p)}`).then(json);

// One page of a transcript sitting in the workspace, shaped exactly like the
// Trace pane's own pages so the same viewer renders it.
export const getFileTracePage = async (id: string, p: string, offset = 0, limit = 200): Promise<TracePage> => {
  const r = await fetch(`/api/files/${id}/trace?path=${encodeURIComponent(p)}&offset=${offset}&limit=${limit}`);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new TraceUnavailable(d.error || 'could not read this trace', d.code || 'no-trace');
  }
  return r.json();
};

export const rawUrl = (id: string, p: string) =>
  `/api/files/${id}/raw?path=${encodeURIComponent(p)}`;

export const uploadFile = (id: string, p: string, file: File) =>
  fetch(`/api/files/${id}/upload?path=${encodeURIComponent(p)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
  }).then(json);

// Create an empty folder / an empty file inside `parent`. The server refuses a
// name that already exists rather than overwriting it.
export const createFolder = (id: string, parent: string, name: string) =>
  fetch(`/api/files/${id}/mkdir`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ path: parent, name }) })
    .then(jsonOrError);

export const createFile = (id: string, parent: string, name: string) =>
  fetch(`/api/files/${id}/touch`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ path: parent, name }) })
    .then(jsonOrError);

// Rename in place. The server takes a NAME, so this can never also move it.
export const renameEntry = (id: string, p: string, name: string): Promise<{ path: string }> =>
  fetch(`/api/files/${id}/rename`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ path: p, name }) })
    .then(jsonOrError);

// Move an entry into another folder, keeping its name. `to` is the destination
// folder ('' = the pane's root).
export const moveEntry = (id: string, p: string, to: string): Promise<{ path: string }> =>
  fetch(`/api/files/${id}/move`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ path: p, to }) })
    .then(jsonOrError);

// Delete a file, or a folder and everything under it.
export const deleteEntry = (id: string, p: string) =>
  fetch(`/api/files/${id}/entry?path=${encodeURIComponent(p)}`, { method: 'DELETE' }).then(jsonOrError);

export const downloadUrl = (id: string, p: string) =>
  `/api/files/${id}/download?path=${encodeURIComponent(p)}`;

// Save an edited text file. `base` is the content tag the editor loaded: the
// server refuses the write if the file's bytes moved on since (an agent edited
// it too). Deliberately NOT mtime — the bucket mount rewrites that on its own
// when it syncs an object, which made every save look like a conflict.
export const writeFile = async (id: string, p: string, text: string, base: string | null): Promise<{ size: number; mtime: number; tag: string | null }> => {
  const q = base ? `&base=${encodeURIComponent(base)}` : '';
  const r = await fetch(`/api/files/${id}/write?path=${encodeURIComponent(p)}${q}`, {
    method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text,
  });
  // Unlike the rest of the API, a failed save has something worth reading in it
  // ("changed on disk since you opened it") — surface it instead of a number.
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
};

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
  /**
   * A prompt typed while the agent was mid-turn, read from Claude Code's queue
   * records because it is written nowhere else (server/src/traces.js). The
   * reader says so on the band: the records cannot tell a prompt that was
   * consumed from one that was cancelled, so it reports what it knows — that
   * this was typed and queued — rather than claiming it was answered.
   */
  queued?: boolean;
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

// ---- windows: how the reader actually reads ----
// A conversation is read from its END. `tail` is the last stretch of it,
// `before` the stretch in front of one you already hold, `after` whatever has
// been written since — each answered from a byte range of the transcript
// instead of a parse of the whole thing. Cursors are opaque: hand back the
// `start`/`end` the server gave you.
export type TraceReq = { at: 'tail' } | { at: 'before' | 'after'; cursor: number };

export interface TraceCursor {
  /** byte offsets for a .jsonl, message indices for the SQLite harnesses */
  mode: 'bytes' | 'index';
  start: number;
  end: number;
  atStart: boolean;
  atEnd: boolean;
  /** the trace grew more than one window while we were away: replace, don't splice */
  gap?: boolean;
  /** one line here is bigger than a window: nothing older can be reached */
  blocked?: boolean;
}

export interface TraceWindow extends Omit<TracePage, 'total' | 'offset' | 'limit' | 'userTurns'> {
  /** null when the window doesn't span the whole trace — ask for the summary */
  total: number | null;
  userTurns: number[] | null;
  window: TraceCursor;
}

/** Whole-trace facts a single window cannot know. One full parse, off the paint path. */
export type TraceSummary = Omit<TracePage, 'turns' | 'offset' | 'limit'>;

const traceRange = (req: TraceReq) => (req.at === 'tail' ? 'tail=1' : `${req.at}=${req.cursor}`);

const traceFetch = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
  const r = await fetch(url, { signal });
  if (r.status === 404) {
    const d = await r.json().catch(() => ({}));
    throw new TraceUnavailable(d.error || 'no trace for this session yet', d.code || 'no-trace');
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
  return r.json();
};

const windowSize = (bytes?: number, min?: number) =>
  `${bytes ? `&bytes=${bytes}` : ''}${min ? `&min=${min}` : ''}`;

export const getTraceWindow = (id: string, req: TraceReq, bytes?: number, min?: number, signal?: AbortSignal): Promise<TraceWindow> =>
  traceFetch(`/api/trace/${id}?${traceRange(req)}${windowSize(bytes, min)}`, signal);

export const getTraceSummary = (id: string, signal?: AbortSignal): Promise<TraceSummary> =>
  traceFetch(`/api/trace/${id}?summary=1`, signal);

export const getFileTraceWindow = (id: string, p: string, req: TraceReq, bytes?: number, min?: number, signal?: AbortSignal): Promise<TraceWindow> =>
  traceFetch(`/api/files/${id}/trace?path=${encodeURIComponent(p)}&${traceRange(req)}${windowSize(bytes, min)}`, signal);

// ---- sub-agents ----
// The roster comes from the `subagents/` directory beside the transcript, not
// from the transcript: a parent here reaches 292 MB while its whole roster is a
// directory listing plus 187 bytes per agent. `spawnedAt` is the sidecar's
// mtime and `lastWroteAt` the transcript's — the second one says when it last
// wrote, and nothing about whether it is alive (measured silence inside a live
// sub-agent: p99 112s, max 601s).
export interface SubAgentEntry {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  /** codex has no per-call id; its parent's records name the task instead */
  taskName?: string | null;
  parentAgentId: string | null;
  depth: number | null;
  spawnedAt: number | null;
  lastWroteAt: number | null;
  bytes: number;
  hasTranscript: boolean;
}

export interface SubAgentRoster {
  id: string;
  supported: boolean;
  reason?: string;
  dir: string | null;
  agents: SubAgentEntry[];
}

export const getSubAgents = (id: string, signal?: AbortSignal): Promise<SubAgentRoster> =>
  traceFetch(`/api/agents/${id}/subagents`, signal);

/** A sub-agent's own transcript, in the same shape as any other trace. */
export const getSubAgentTrace = (id: string, agentId: string, bytes?: number, signal?: AbortSignal): Promise<TraceWindow> =>
  traceFetch(`/api/agents/${id}/subagents/${encodeURIComponent(agentId)}?tail=1${windowSize(bytes)}`, signal);

export const getFileTraceSummary = (id: string, p: string, signal?: AbortSignal): Promise<TraceSummary> =>
  traceFetch(`/api/files/${id}/trace?path=${encodeURIComponent(p)}&summary=1`, signal);

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

// ---- the API log (Settings → API log) ----
// Written by operationMiddleware: every mutating call, plus the one read that is
// an event between two agents — a `wait` that resolved. Payloads are summarised
// at write time, never stored: a prompt is {present, chars, sha256} and nothing
// else, so this view can say who asked whom and how long the ask was, never what
// it said.
export interface OperationSummary { present?: boolean; chars?: number; sha256?: string; bytes?: number; }
export interface Operation {
  id: string;
  at: string;
  origin: { id: string; type: string; name?: string; cli?: string } | null;
  target?: { id: string; name?: string; cli?: string };
  method: string;
  path: string;
  query?: Record<string, unknown>;
  request?: unknown;
  status: number;
  ok: boolean;
  durationMs: number;
  result?: unknown;
}
export const getOperations = (limit = 500): Promise<{ operations: Operation[]; generatedAt: string }> =>
  fetch(`/api/operations?limit=${limit}`).then(json);
