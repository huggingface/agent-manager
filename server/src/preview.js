// File previews for the Files pane: what kind of thing a file is, how to serve
// it inline, and how to read the head of a text file without loading a gigabyte
// into the process that is also pumping every terminal's PTY data.
import fs from 'node:fs';
import path from 'node:path';

// Text is read in full up to this size; beyond it the preview is truncated and
// says so. Generous enough for real source files, small enough to stay cheap
// on the object-storage bucket workspaces live on.
export const TEXT_MAX = 512 * 1024;

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// Extensions we render as markdown rather than as plain text.
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const HTML_EXT = new Set(['.html', '.htm']);

// Anything textual we're willing to show in the code viewer. Extension-based so
// a 200 MB .csv doesn't get sniffed byte-by-byte; unknown extensions fall back
// to a binary sniff below.
const TEXT_EXT = new Set([
  '.txt', '.text', '.log', '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.properties', '.csv', '.tsv', '.xml', '.svgz', '.rst', '.org',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.less',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc',
  '.cpp', '.hpp', '.cs', '.m', '.mm', '.php', '.pl', '.lua', '.r', '.jl', '.scala', '.clj',
  '.ex', '.exs', '.erl', '.hs', '.ml', '.zig', '.nim', '.dart', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql',
  '.dockerfile', '.gitignore', '.gitattributes', '.editorconfig', '.patch', '.diff',
  '.lock', '.mod', '.sum', '.makefile', '.mk', '.cmake', '.gradle', '.tf', '.tfvars',
]);

// Files with no extension that are text by convention.
const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'license', 'licence', 'readme', 'notice', 'authors',
  'changelog', 'contributing', 'codeowners', 'procfile', 'brewfile', 'justfile',
  'rakefile', 'gemfile', 'pipfile', '.gitignore', '.gitattributes', '.editorconfig',
  '.bashrc', '.zshrc', '.profile', '.bash_profile', '.npmrc', '.nvmrc', '.env',
]);

const MIME = {
  ...IMAGE_MIME,
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
};

const ext = (name) => path.extname(name).toLowerCase();

// The viewer kind for a name alone (no disk access): 'image' | 'markdown' |
// 'html' | 'pdf' | 'text' | null. null = "ask the bytes" (see kindOfFile).
export function kindOfName(name) {
  const e = ext(name);
  const base = name.toLowerCase();
  if (IMAGE_MIME[e]) return 'image';
  if (MARKDOWN_EXT.has(e)) return 'markdown';
  if (HTML_EXT.has(e)) return 'html';
  if (e === '.pdf') return 'pdf';
  if (TEXT_EXT.has(e) || TEXT_NAMES.has(base) || TEXT_NAMES.has(base.replace(/^\./, ''))) return 'text';
  return null;
}

// A NUL byte in the head is the classic "this is not text" tell — same heuristic
// git uses. Also bail on a high share of other control bytes.
function looksBinary(buf) {
  if (buf.includes(0)) return true;
  let odd = 0;
  for (const b of buf) if (b < 9 || (b > 13 && b < 32)) odd++;
  return buf.length > 0 && odd / buf.length > 0.1;
}

// Kind for a file on disk: extension first, then a 4 KB sniff for the
// extensionless and the unknown, so `mysteryfile` still previews as text.
export function kindOfFile(file) {
  const byName = kindOfName(path.basename(file));
  if (byName) return byName;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    return looksBinary(buf.subarray(0, n)) ? 'binary' : 'text';
  } catch {
    return 'binary';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Content type for serving a file inline. Text-ish things become text/plain so
// the browser never sniffs something scriptable out of them; html/pdf/images
// keep their real type because the viewer relies on it. Bytes we couldn't read
// as anything are octet-stream — text/plain would be a lie the UI repeats.
export function mimeOf(name, kind) {
  if (kind === 'binary') return 'application/octet-stream';
  return MIME[ext(name)] || 'text/plain; charset=utf-8';
}

// Read at most `max` bytes of a file as UTF-8. When truncated, cut back to the
// last newline so the viewer never shows half a line (or half a code point).
export function readTextHead(file, max = TEXT_MAX) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const want = Math.min(size, max);
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, 0);
    let text = buf.subarray(0, n).toString('utf8');
    const truncated = size > n;
    if (truncated) {
      const cut = text.lastIndexOf('\n');
      if (cut > 0) text = text.slice(0, cut);
    }
    return { text, truncated, bytes: n };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}
