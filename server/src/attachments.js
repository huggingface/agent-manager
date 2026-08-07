import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STATE_DIR } from './config.js';

export const ATTACHMENT_LIMIT = 100 * 1024 * 1024;
// A single prompt is capped separately at five files. This lifetime cap keeps
// a forgotten session from growing without bound while still leaving room for
// many ordinary attachment turns.
export const SESSION_ATTACHMENT_LIMIT = 500 * 1024 * 1024;
export const SESSION_ATTACHMENT_COUNT_LIMIT = 200;
export const ATTACHMENT_ID = /^att_[a-f0-9]{24}$/;
export const IMAGE_MIMES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const ATTACHMENTS_DIR = path.join(STATE_DIR, 'attachments');
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});
const MIME_BY_EXTENSION = Object.freeze({
  ...Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([mime, extension]) => [extension, mime])),
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  svg: 'image/svg+xml',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  rtf: 'application/rtf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  epub: 'application/epub+zip',
});
const ATTACHMENT_FILE = /^att_[a-f0-9]{24}(?:[-.]|$)/;
const uploadWindows = new Map();
const uploadLocks = new Map();

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sessionDir(sessionId) {
  // Session ids are server-generated slugs. Keep this check here as a second
  // boundary: a future caller must not turn an attachment lookup into a path
  // join with an arbitrary browser value.
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(sessionId))) {
    throw httpError(400, 'session cannot accept files');
  }
  return path.join(ATTACHMENTS_DIR, sessionId);
}

function checkUploadRate(sessionId) {
  const now = Date.now();
  const recent = (uploadWindows.get(sessionId) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 20) throw httpError(429, 'too many file uploads — try again in a minute');
  recent.push(now);
  uploadWindows.set(sessionId, recent);
}

// Serialize writes within one session so concurrent uploads cannot each pass a
// stale quota check. Different sessions still stream in parallel.
async function withUploadLock(sessionId, task) {
  const previous = uploadLocks.get(sessionId) || Promise.resolve();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => hold);
  uploadLocks.set(sessionId, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (uploadLocks.get(sessionId) === tail) uploadLocks.delete(sessionId);
  }
}

async function attachmentUsage(dir) {
  let entries = [];
  try { entries = await fs.promises.readdir(dir); } catch { return { bytes: 0, count: 0 }; }
  let bytes = 0;
  let count = 0;
  for (const name of entries) {
    try {
      const stat = await fs.promises.lstat(path.join(dir, name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      bytes += stat.size;
      if (ATTACHMENT_FILE.test(name)) count += 1;
    } catch {}
  }
  return { bytes, count };
}

export function detectImageMime(bytes) {
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG'
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function imageEnvelopeIsValid(mime, header, tail, totalBytes) {
  if (mime === 'image/png') {
    return totalBytes >= 45 && header.length >= 24
      && header.readUInt32BE(8) === 13
      && header.subarray(12, 16).toString('ascii') === 'IHDR'
      && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0
      && tail.length >= 12
      && tail.readUInt32BE(tail.length - 12) === 0
      && tail.subarray(tail.length - 8, tail.length - 4).toString('ascii') === 'IEND';
  }
  if (mime === 'image/jpeg') {
    return totalBytes >= 6 && tail.length >= 2
      && tail[tail.length - 2] === 0xff && tail[tail.length - 1] === 0xd9;
  }
  if (mime === 'image/gif') {
    return totalBytes >= 14 && header.length >= 10
      && header.readUInt16LE(6) > 0 && header.readUInt16LE(8) > 0
      && tail[tail.length - 1] === 0x3b;
  }
  if (mime === 'image/webp') {
    const chunk = header.subarray(12, 16).toString('ascii');
    return totalBytes >= 20 && header.length >= 16
      && ['VP8 ', 'VP8L', 'VP8X'].includes(chunk)
      && header.readUInt32LE(4) + 8 <= totalBytes;
  }
  return false;
}

const normalizedMime = (value) => {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  const canonical = mime === 'image/jpg' || mime === 'image/pjpeg' ? 'image/jpeg' : mime;
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(canonical)
    ? canonical : '';
};

const extensionOf = (name) => path.extname(name).slice(1).toLowerCase();
const mimeForName = (name) => {
  const known = MIME_BY_EXTENSION[extensionOf(name)];
  return (typeof known === 'string' ? known : '') || 'application/octet-stream';
};

function truncateUtf8(value, maxBytes) {
  let result = value;
  while (Buffer.byteLength(result) > maxBytes) result = result.slice(0, -1);
  return result;
}

function safeFileName(value) {
  let decoded = String(Array.isArray(value) ? value[0] : value || 'attachment');
  try { decoded = decodeURIComponent(decoded); } catch {}
  let name = path.basename(decoded.replace(/\\/g, '/'))
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim();
  if (!name || name === '.' || name === '..') name = 'attachment';
  if (Buffer.byteLength(name) > 180) {
    const candidate = path.extname(name);
    const extension = Buffer.byteLength(candidate) <= 24 ? candidate : '';
    const stem = extension ? name.slice(0, -extension.length) : name;
    name = `${truncateUtf8(stem, 180 - Buffer.byteLength(extension))}${extension}`;
  }
  return name || 'attachment';
}

function canonicalImageName(name, mime) {
  const extension = IMAGE_EXTENSIONS[mime];
  const current = path.extname(name);
  const stem = current ? name.slice(0, -current.length) : name;
  return `${stem || 'Screenshot'}.${extension}`;
}

const isImageMime = (mime) => IMAGE_MIMES.includes(mime);
const claimsNativeImage = (name, declared) =>
  isImageMime(normalizedMime(declared))
  || Object.values(IMAGE_EXTENSIONS).includes(extensionOf(name))
  || extensionOf(name) === 'jpeg';

const responseShape = (sessionId, id, mime, bytes, filePath, name = path.basename(filePath)) => {
  const kind = isImageMime(mime) ? 'image' : 'file';
  return {
    id,
    kind,
    name,
    mime,
    bytes,
    path: filePath,
    previewUrl: `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${id}/raw`,
    insertText: `${kind === 'image' ? 'Screenshot' : 'File'}: ${filePath} `,
  };
};

/** Stream one browser file into the session-owned attachment store. */
export async function receiveAttachment(readable, sessionId, { contentType = '', fileName = '' } = {}) {
  // Image metadata is advisory. Byte detection remains the security boundary
  // for formats rendered inline or passed to a CLI's native image interface.
  // Other formats are inert files: they are never executed, and the raw route
  // forces them to download rather than rendering browser-active content.
  const originalName = safeFileName(fileName);
  checkUploadRate(sessionId);
  return withUploadLock(sessionId, async () => {
    const dir = sessionDir(sessionId);
    await fs.promises.mkdir(dir, { recursive: true });
    const usage = await attachmentUsage(dir);
    if (usage.count >= SESSION_ATTACHMENT_COUNT_LIMIT) {
      throw httpError(413, `this session already has ${SESSION_ATTACHMENT_COUNT_LIMIT} files`);
    }
    const id = `att_${crypto.randomBytes(12).toString('hex')}`;
    const temporary = path.join(dir, `.${id}.${crypto.randomBytes(4).toString('hex')}.part`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > ATTACHMENT_LIMIT) return callback(httpError(413, 'file is larger than 100 MB'));
        if (usage.bytes + bytes > SESSION_ATTACHMENT_LIMIT) {
          return callback(httpError(413, 'this session has reached its 500 MB attachment limit'));
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(readable, limiter, fs.createWriteStream(temporary, { flags: 'wx' }));
      if (bytes === 0) throw httpError(413, 'file is empty');

      const handle = await fs.promises.open(temporary, 'r');
      const header = Buffer.alloc(32);
      const tail = Buffer.alloc(Math.min(16, bytes));
      let bytesRead = 0;
      let tailBytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(header, 0, header.length, 0));
        ({ bytesRead: tailBytesRead } = await handle.read(tail, 0, tail.length, Math.max(0, bytes - tail.length)));
      } finally {
        await handle.close();
      }
      const headerBytes = header.subarray(0, bytesRead);
      const tailBytes = tail.subarray(0, tailBytesRead);
      const detected = detectImageMime(headerBytes);
      if (detected && !imageEnvelopeIsValid(detected, headerBytes, tailBytes, bytes)) {
        throw httpError(415, 'image is truncated or malformed');
      }
      if (!detected && claimsNativeImage(originalName, contentType)) {
        throw httpError(415, 'file does not contain a valid PNG, JPEG, GIF, or WebP image');
      }

      const storedName = detected ? canonicalImageName(originalName, detected) : originalName;
      const mime = detected || mimeForName(storedName);
      const finalPath = path.join(dir, `${id}-${storedName}`);
      await fs.promises.rename(temporary, finalPath);
      return responseShape(sessionId, id, mime, bytes, finalPath, storedName);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  });
}

/** Resolve an untrusted attachment id within exactly one session. */
export function resolveAttachment(sessionId, attachmentId) {
  if (!ATTACHMENT_ID.test(String(attachmentId))) throw httpError(404, 'attachment not found');
  const dir = sessionDir(sessionId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    const isCurrent = name.startsWith(`${attachmentId}-`);
    const legacyExtension = name.startsWith(`${attachmentId}.`) ? extensionOf(name) : '';
    if (!isCurrent && !Object.values(IMAGE_EXTENSIONS).includes(legacyExtension)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const displayName = isCurrent ? name.slice(attachmentId.length + 1) : name;
      return responseShape(sessionId, attachmentId, mimeForName(displayName), stat.size, filePath, displayName);
    } catch {}
  }
  throw httpError(404, 'attachment not found');
}

export function resolveAttachments(sessionId, attachmentIds) {
  if (!Array.isArray(attachmentIds)) throw httpError(400, 'attachmentIds must be an array');
  if (attachmentIds.length > 5) throw httpError(400, 'at most five files may be attached');
  if (new Set(attachmentIds).size !== attachmentIds.length) throw httpError(400, 'duplicate attachment id');
  return attachmentIds.map((id) => resolveAttachment(sessionId, id));
}

export async function removeSessionAttachments(sessionId) {
  uploadWindows.delete(sessionId);
  await withUploadLock(sessionId, () => fs.promises.rm(sessionDir(sessionId), { recursive: true, force: true }));
}

/** Remove only old orphan stores; recent crash leftovers keep a seven-day grace. */
export async function pruneAttachmentDirs(sessionIds, now = Date.now()) {
  const live = new Set(sessionIds);
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = await fs.promises.readdir(ATTACHMENTS_DIR, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ATTACHMENTS_DIR, entry.name);
    // A process death can happen between exclusive temp creation and rename.
    // Normal request failures remove these immediately; this is the crash
    // backstop, with the same grace period as orphan session directories.
    try {
      for (const name of await fs.promises.readdir(dir)) {
        const part = path.join(dir, name);
        const stat = await fs.promises.lstat(part);
        if (name.endsWith('.part') && stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
          await fs.promises.unlink(part);
        }
      }
    } catch {}
    if (live.has(entry.name)) continue;
    let newest = 0;
    try {
      const names = await fs.promises.readdir(dir);
      const stats = await Promise.all(names.map((name) => fs.promises.lstat(path.join(dir, name))));
      newest = Math.max((await fs.promises.stat(dir)).mtimeMs, ...stats.map((stat) => stat.mtimeMs));
    } catch { continue; }
    if (newest < cutoff) await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

const quotePath = (filePath) => JSON.stringify(filePath);

/** TUI commands that attach native image context before the textual prompt. */
export function formatAttachmentPrelude(cli, attachments) {
  if (cli !== 'hermes') return [];
  return attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((image) => `/image ${quotePath(image.path)}`);
}

/** Keep CLI-version-specific formatting out of request handlers and React. */
export function formatAttachmentDelivery(cli, text, attachments) {
  const onlyImages = attachments.length > 0 && attachments.every((attachment) => attachment.kind === 'image');
  const prompt = String(text || '').trim() || (onlyImages
    ? `Please inspect the attached screenshot${attachments.length === 1 ? '' : 's'}.`
    : `Please inspect the attached file${attachments.length === 1 ? '' : 's'}.`);
  if (!attachments.length) return prompt;
  const paths = attachments.map((attachment) => attachment.path);
  if (cli === 'gemini') {
    return `${prompt}\n\n${paths.map((filePath) => `@${quotePath(filePath)}`).join('\n')}`;
  }
  return `${prompt}\n\nAttached files:\n${paths.map((filePath) => `- ${quotePath(filePath)}`).join('\n')}`;
}
