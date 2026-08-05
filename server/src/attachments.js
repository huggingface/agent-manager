import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STATE_DIR } from './config.js';

export const ATTACHMENT_LIMIT = 25 * 1024 * 1024;
export const ATTACHMENT_ID = /^att_[a-f0-9]{24}$/;
export const IMAGE_MIMES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const ATTACHMENTS_DIR = path.join(STATE_DIR, 'attachments');
const EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});
const uploadWindows = new Map();

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
    throw httpError(400, 'session cannot accept images');
  }
  return path.join(ATTACHMENTS_DIR, sessionId);
}

function checkUploadRate(sessionId) {
  const now = Date.now();
  const recent = (uploadWindows.get(sessionId) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 20) throw httpError(429, 'too many image uploads — try again in a minute');
  recent.push(now);
  uploadWindows.set(sessionId, recent);
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

const responseShape = (sessionId, id, mime, bytes, filePath) => ({
  id,
  kind: 'image',
  name: path.basename(filePath),
  mime,
  bytes,
  path: filePath,
  previewUrl: `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${id}/raw`,
  insertText: `Screenshot: ${filePath} `,
});

/** Stream one browser image into the session-owned attachment store. */
export async function receiveImage(readable, sessionId, contentType) {
  const declared = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (!IMAGE_MIMES.includes(declared)) throw httpError(415, 'use PNG, JPEG, GIF, or WebP');
  checkUploadRate(sessionId);

  const dir = sessionDir(sessionId);
  await fs.promises.mkdir(dir, { recursive: true });
  const id = `att_${crypto.randomBytes(12).toString('hex')}`;
  const temporary = path.join(dir, `.${id}.${crypto.randomBytes(4).toString('hex')}.part`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > ATTACHMENT_LIMIT) return callback(httpError(413, 'image is larger than 25 MB'));
      callback(null, chunk);
    },
  });

  try {
    await pipeline(readable, limiter, fs.createWriteStream(temporary, { flags: 'wx' }));
    if (bytes === 0) throw httpError(413, 'image is empty');

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
    if (!detected || detected !== declared) {
      throw httpError(415, detected
        ? `image bytes are ${detected}, not ${declared}`
        : 'file is not a supported raster image');
    }
    if (!imageEnvelopeIsValid(detected, headerBytes, tailBytes, bytes)) {
      throw httpError(415, 'image is truncated or malformed');
    }

    const finalPath = path.join(dir, `${id}.${EXTENSIONS[detected]}`);
    await fs.promises.rename(temporary, finalPath);
    return responseShape(sessionId, id, detected, bytes, finalPath);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Resolve an untrusted attachment id within exactly one session. */
export function resolveImage(sessionId, attachmentId) {
  if (!ATTACHMENT_ID.test(String(attachmentId))) throw httpError(404, 'attachment not found');
  const dir = sessionDir(sessionId);
  for (const [mime, extension] of Object.entries(EXTENSIONS)) {
    const filePath = path.join(dir, `${attachmentId}.${extension}`);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      return responseShape(sessionId, attachmentId, mime, stat.size, filePath);
    } catch {}
  }
  throw httpError(404, 'attachment not found');
}

export function resolveImages(sessionId, attachmentIds) {
  if (!Array.isArray(attachmentIds)) throw httpError(400, 'attachmentIds must be an array');
  if (attachmentIds.length > 5) throw httpError(400, 'at most five images may be attached');
  if (new Set(attachmentIds).size !== attachmentIds.length) throw httpError(400, 'duplicate attachment id');
  return attachmentIds.map((id) => resolveImage(sessionId, id));
}

export function removeSessionAttachments(sessionId) {
  uploadWindows.delete(sessionId);
  fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

/** Remove only old orphan stores; recent crash leftovers keep a seven-day grace. */
export function pruneAttachmentDirs(sessionIds, now = Date.now()) {
  const live = new Set(sessionIds);
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = fs.readdirSync(ATTACHMENTS_DIR, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ATTACHMENTS_DIR, entry.name);
    // A process death can happen between exclusive temp creation and rename.
    // Normal request failures remove these immediately; this is the crash
    // backstop, with the same grace period as orphan session directories.
    try {
      for (const name of fs.readdirSync(dir)) {
        const part = path.join(dir, name);
        if (name.endsWith('.part') && fs.lstatSync(part).isFile() && fs.statSync(part).mtimeMs < cutoff) {
          fs.unlinkSync(part);
        }
      }
    } catch {}
    if (live.has(entry.name)) continue;
    let newest = 0;
    try {
      newest = Math.max(fs.statSync(dir).mtimeMs, ...fs.readdirSync(dir).map((name) => fs.lstatSync(path.join(dir, name)).mtimeMs));
    } catch { continue; }
    if (newest < cutoff) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const quotePath = (filePath) => JSON.stringify(filePath);

/** Keep CLI-version-specific formatting out of request handlers and React. */
export function formatAttachmentDelivery(cli, text, images) {
  const prompt = String(text || '').trim()
    || `Please inspect the attached screenshot${images.length === 1 ? '' : 's'}.`;
  if (!images.length) return prompt;
  const paths = images.map((image) => image.path);
  if (cli === 'gemini') {
    return `${prompt}\n\n${paths.map((filePath) => `@${quotePath(filePath)}`).join('\n')}`;
  }
  return `${prompt}\n\nAttached screenshots:\n${paths.map((filePath) => `- ${quotePath(filePath)}`).join('\n')}`;
}
