export type ErrorData = {
  reason?: string; hint?: string; requestId?: string; retryAfter?: number;
  mtime?: number; tag?: string | null; currentTag?: string | null;
  hits?: Record<string, number>; details?: { field: string; message: string }[];
};

export class ApiError extends Error {
  legacy = false;
  constructor(message: string, public status: number | null, public code: string, public data: ErrorData = {}) {
    super(message);
    this.name = 'ApiError';
  }
}

const safeText = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 1024 && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const codes: Record<number, string> = { 400: 'bad-request', 403: 'forbidden', 404: 'not-found', 409: 'conflict', 413: 'payload-too-large', 415: 'unsupported-media-type', 429: 'rate-limited' };
const fallbackMessage = (status: number) => ({
  400: 'The request was not valid.', 403: 'This request is not allowed.', 404: 'The requested item was not found.',
  409: 'The request conflicts with the current state.', 413: 'The server or its proxy rejected this file as too large.',
  429: 'Too many requests. Wait a moment before trying again.', 408: 'The request timed out.', 504: 'The server timed out.',
}[status] || (status >= 500 ? 'The server could not complete the request.' : 'The request failed.')) + ` (HTTP ${status})`;

// One allowlist for fetch and XHR. Retain useful domain data, not arbitrary
// upstream objects, HTML, stacks or response bodies. Error text is never HTML.
export function httpError(status: number, body: unknown): ApiError {
  const b = record(body) ? body : {};
  const data: ErrorData = {};
  for (const key of ['reason', 'hint', 'requestId'] as const) if (safeText(b[key])) data[key] = b[key];
  for (const key of ['mtime', 'retryAfter'] as const) if (typeof b[key] === 'number' && Number.isFinite(b[key])) data[key] = b[key];
  for (const key of ['tag', 'currentTag'] as const) {
    const value = b[key];
    if (value === null || safeText(value)) data[key] = value as string | null;
  }
  if (record(b.hits)) data.hits = Object.fromEntries(Object.entries(b.hits).slice(0, 100)
    .filter(([key, value]) => safeText(key) && typeof value === 'number' && Number.isFinite(value))) as Record<string, number>;
  if (Array.isArray(b.details)) data.details = b.details.slice(0, 20)
    .filter((d): d is { field: string; message: string } => record(d) && safeText(d.field) && safeText(d.message))
    .map(({ field, message }) => ({ field, message }));
  const code = typeof b.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(b.code)
    ? b.code : codes[status] || (status >= 500 ? 'internal-error' : 'request-failed');
  const error = new ApiError(safeText(b.error) ? b.error : fallbackMessage(status), status, code, data);
  error.legacy = b.code === undefined && safeText(b.error);
  return error;
}

const ERROR_BYTES = 64 * 1024;
export function decodeJsonText<T = any>(text: string, status: number): T {
  const ok = status >= 200 && status < 300;
  let body: unknown;
  try { body = JSON.parse(!ok && text.length > ERROR_BYTES ? '' : text); }
  catch {
    if (!ok) throw httpError(status, null);
    if (!text.trim()) return undefined as T; // 204/205 and existing empty successes
    throw new ApiError('The server returned an unreadable response. Check the result before trying again.', status, 'unreadable-response');
  }
  if (!ok) throw httpError(status, body);
  return body as T; // ok:false is domain data, not an HTTP failure
}

async function errorText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ERROR_BYTES) { void reader.cancel().catch(() => {}); return ''; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function connectionError(error: unknown, status: number | null = null): Error {
  if (error instanceof ApiError) return error;
  // Reader owns its aborts and deadlines; preserve AbortError identity.
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof Error && error.name === 'TimeoutError') return new ApiError('The request timed out. Check the result before trying again.', status, 'timeout');
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return new ApiError(offline ? 'This device is offline.' : 'The connection was interrupted before the result was confirmed.', status, offline ? 'offline' : 'network-error');
}

export async function decodeResponse<T = any>(response: Response, format: 'json' | 'text' = 'json'): Promise<T> {
  let text: string;
  try { text = response.ok ? await response.text() : await errorText(response); }
  catch (error) { throw connectionError(error, response.status); }
  if (response.ok && format === 'text') return text as T;
  return decodeJsonText<T>(text, response.status);
}
