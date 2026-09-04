export type FileLinkContext = { session?: string; root?: string; base?: string; unavailable?: boolean };
export type FileLinkRequest = { file: string; session?: string; root?: string; line?: number; column?: number; unavailable?: boolean };
export type FileLinkTarget = { root: string; path: string; absolute: string };

// Parse only file references, never reinterpret a network or executable URL.
// Decode URL paths once; literal paths in code spans/terminals stay literal.
export function parseFileReference(value: string, encoded = true): { file: string; line?: number; column?: number } | null {
  let file = value.trim();
  if (!file || file.startsWith('#') || file.startsWith('//') || /[\x00-\x1f]/.test(file)) return null;
  if (/^(?:https?|javascript|vbscript|data|mailto|tel|ftp|vscode):/i.test(file)) return null;
  if (/^file:\/\//i.test(file)) {
    try {
      const url = new URL(file);
      if (url.hostname && url.hostname !== 'localhost') return null;
      file = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(file) && !/^[^/\s]+:\d+(?::\d+)?$/.test(file)) return null;
  const suffix = file.match(/(?:#L(\d+)(?:C(\d+)|-L?\d+)?|:(\d+)(?::(\d+))?)$/i);
  const line = suffix ? Number(suffix[1] || suffix[3]) : undefined;
  const column = suffix && (suffix[2] || suffix[4]) ? Number(suffix[2] || suffix[4]) : undefined;
  if (suffix) file = file.slice(0, -suffix[0].length);
  // Other fragments belong to rendered Markdown, but are not file names.
  if (encoded) {
    file = file.split('#')[0].split('?')[0];
    try { file = decodeURIComponent(file); } catch { return null; }
  }
  if (!file || /[\x00-\x1f\\]/.test(file)) return null;
  return { file, ...(line && Number.isSafeInteger(line) ? { line } : {}), ...(column && Number.isSafeInteger(column) ? { column } : {}) };
}

export function looksLikeFile(value: string): boolean {
  const ref = parseFileReference(value, false);
  return !!ref && !/\s/.test(value) && (
    /^(?:\.{0,2}\/|workspace\/)/.test(ref.file)
    || /(?:^|\/)[\w.@+-]+\.[a-zA-Z][\w-]{0,15}$/.test(ref.file)
  );
}

export function fileRequest(value: string, context: FileLinkContext = {}, encoded = true): FileLinkRequest | null {
  const ref = parseFileReference(value, encoded);
  if (!ref) return null;
  const { session, root, base, unavailable } = context;
  if (root && !ref.file.startsWith('/')) {
    // Keep .. segments for the server's root check; do not silently clamp them.
    return { ...ref, file: base ? `${base}/${ref.file}` : ref.file, root, ...(unavailable ? { unavailable } : {}) };
  }
  return { ...ref, file: base && !ref.file.startsWith('/') ? `${base}/${ref.file}` : ref.file,
    ...(session ? { session } : {}), ...(unavailable ? { unavailable } : {}) };
}

export function fileLinkHash(request: FileLinkRequest): string {
  const params = new URLSearchParams({ file: request.file });
  for (const key of ['root', 'session', 'line', 'column', 'unavailable'] as const) {
    if (request[key] !== undefined) params.set(key, String(request[key]));
  }
  return '#' + params;
}

export function requestFromHash(hash: string): FileLinkRequest | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const file = params.get('file');
  if (!file) return null;
  const positive = (key: string) => {
    const n = Number(params.get(key));
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  return { file, root: params.get('root') || undefined, session: params.get('session') || undefined,
    line: positive('line'), column: positive('column'), unavailable: params.get('unavailable') === 'true' || undefined };
}

export function fileLinkUrl(request: FileLinkRequest): string {
  return location.pathname + location.search + fileLinkHash(request);
}

export function fileResourceUrl(action: 'resolve' | 'preview' | 'raw' | 'download', request: FileLinkRequest): string {
  const params = new URLSearchParams({ file: request.file });
  if (request.root) params.set('root', request.root);
  if (request.session) params.set('session', request.session);
  return `/api/file-links/${action}?${params}`;
}

export async function resolveFileLink(request: FileLinkRequest, signal: AbortSignal): Promise<FileLinkTarget> {
  if (request.unavailable) throw new Error('File unavailable here: this conversation has no local working folder.');
  const response = await fetch(fileResourceUrl('resolve', request), { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not locate this file.');
  return body;
}

export function activateFileLink(_event: MouseEvent, request: FileLinkRequest) {
  const anchor = document.createElement('a');
  anchor.href = fileLinkUrl(request); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}
