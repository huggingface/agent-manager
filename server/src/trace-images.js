// Images in a transcript, by reference rather than by value.
//
// A transcript embeds every image it ever showed the model as base64: Claude's
// `{type:'image', source:{type:'base64', data}}` (pasted, or inside a tool
// result), Codex's `{type:'input_image', image_url:'data:image/png;base64,…'}`.
// The reader used to hand those to the browser as data URLs inside the
// conversation JSON, so a session that looked at a dozen full-HD screenshots
// answered with tens of MB, on every open and every refresh, before a single
// image was on screen.
//
// Now a conversation carries `{type:'image', ref, mediaType, bytes, width?,
// height?}` and the browser fetches the bytes when it draws the image. The ref
// is `<byte offset of the record, base 36>.<hash of the image data>`:
//
//   - the OFFSET is the location index. Resolving a ref seeks to that offset and
//     reads one line, so serving an image never re-parses the transcript, and
//     there is no separate index to build, cache or invalidate;
//   - the HASH is what makes it safe and cacheable. A ref is served only if the
//     record at that offset, in the trace this route resolved for this session,
//     holds an image with exactly that hash. A client cannot name a path, and
//     cannot name bytes it did not already know; a rewritten file that put
//     something else at the same offset no longer matches. Same ref, same
//     bytes — so the response can be cached as immutable.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';

// `data:<type>[;param…];base64,<data>` → { b64, mediaType }, or null. Written
// out by hand rather than as a regular expression, like the rest of the code
// that reads model-written text (codex-code-mode.js): the header is short and
// bounded, and the data itself is only sliced, never scanned.
function parseDataUrl(url) {
  if (url.length < 5 || url.slice(0, 5).toLowerCase() !== 'data:') return null;
  const comma = url.indexOf(',', 5);
  if (comma === -1 || comma > 256) return null;
  const params = url.slice(5, comma).toLowerCase().split(';');
  if (params.length < 2 || params[params.length - 1] !== 'base64') return null;
  const b64 = url.slice(comma + 1);
  const type = params[0].trim();
  return b64 ? { b64, mediaType: type.includes('/') ? type : null } : null;
}

/**
 * The base64 image a transcript content item embeds, as `{ b64, mediaType }`,
 * or null. Covers both harnesses' shapes; anything else (an http URL, a file
 * reference) is not data we hold.
 */
export function embeddedImage(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.type === 'image' && c.source && typeof c.source.data === 'string' && c.source.data
    && (c.source.type === undefined || c.source.type === 'base64')) {
    return { b64: c.source.data, mediaType: typeof c.source.media_type === 'string' ? c.source.media_type : null };
  }
  if (c.type === 'input_image' || c.type === 'image') {
    const url = typeof c.image_url === 'string' ? c.image_url : typeof c.image_url?.url === 'string' ? c.image_url.url : null;
    return url ? parseDataUrl(url) : null;
  }
  return null;
}

const hashOf = (b64) => createHash('sha256').update(b64).digest('hex').slice(0, 24);
const REF = /^([0-9a-z]{1,11})\.([0-9a-f]{24})$/;

const decodedBytes = (b64) => {
  const s = b64.replace(/\s+$/, '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
};

// What the bytes are, from their magic numbers. The declared type is what the
// harness believed; this is what the browser would see.
export function sniffImageType(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 12) === 'ftypavif') return 'image/avif';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^﻿/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

// Width and height from the header alone, when the header says so cheaply.
// Only for laying out a placeholder: a wrong guess costs a reflow, nothing else.
function dimensions(buf, type) {
  try {
    if (type === 'image/png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'image/gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/webp' && buf.length >= 30) {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* a truncated header is just an unknown size */ }
  return null;
}

// Enough of the image to read its header: 64 KB decoded covers every PNG, GIF
// and WebP header and the SOF of almost every JPEG (EXIF thumbnails come first).
const HEAD_B64 = 87_380;

/**
 * The block the reader gets for one embedded image found in the record at
 * byte `offset`. Never contains the data.
 */
export function imageBlock(offset, img) {
  const head = Buffer.from(img.b64.slice(0, HEAD_B64 - (HEAD_B64 % 4)), 'base64');
  const sniffed = sniffImageType(head);
  const size = sniffed ? dimensions(head, sniffed) : null;
  return {
    type: 'image',
    ref: `${Math.max(0, Math.trunc(offset) || 0).toString(36)}.${hashOf(img.b64)}`,
    mediaType: sniffed || img.mediaType || 'image/png',
    bytes: decodedBytes(img.b64),
    ...(size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : {}),
  };
}

// Every embedded image in one parsed record, wherever it sits.
function* imagesIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  const img = embeddedImage(value);
  if (img) { yield img; return; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    if (v && typeof v === 'object') yield* imagesIn(v, depth + 1);
  }
}

// The record that starts at `offset`, or null if no record starts there.
const LINE_CHUNK = 1024 * 1024;
const LINE_MAX = 256 * 1024 * 1024;
async function recordAt(file, offset) {
  const fh = await fsp.open(file, 'r');
  try {
    // A record starts at 0 or right after a newline; anything else is a
    // position inside some other record.
    if (offset > 0) {
      const prev = Buffer.alloc(1);
      const { bytesRead } = await fh.read(prev, 0, 1, offset - 1);
      if (bytesRead !== 1 || prev[0] !== 0x0a) return null;
    }
    const parts = [];
    let at = offset;
    for (let total = 0; total < LINE_MAX;) {
      const buf = Buffer.alloc(LINE_CHUNK);
      const { bytesRead } = await fh.read(buf, 0, LINE_CHUNK, at);
      if (!bytesRead) break;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      parts.push(buf.subarray(0, nl === -1 ? bytesRead : nl));
      if (nl !== -1) break;
      at += bytesRead; total += bytesRead;
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return null; }
  } finally { await fh.close(); }
}

// Recently opened records, so the dozen images one Codex script output carries
// cost one read of that (multi-MB) line rather than a dozen. A hit is still
// matched by hash, so a stale entry can only miss, never serve wrong bytes.
const recent = new Map(); // `${file}\0${offset}` -> Map<hash, img>
let recentChars = 0;
const RECENT_MAX_CHARS = 48 * 1024 * 1024;
function remember(key, images) {
  const chars = [...images.values()].reduce((n, i) => n + i.b64.length, 0);
  if (chars > RECENT_MAX_CHARS) return;
  while (recent.size && (recent.size >= 8 || recentChars + chars > RECENT_MAX_CHARS)) {
    const [oldest, val] = recent.entries().next().value;
    recentChars -= [...val.values()].reduce((n, i) => n + i.b64.length, 0);
    recent.delete(oldest);
  }
  recent.set(key, images); recentChars += chars;
}

// What may go out, and as what. An SVG is served too — the route's CSP sandbox
// keeps it from running as a document — but only when it really is one.
const SERVABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/svg+xml']);

/**
 * The bytes behind `ref` in `file`: `{ body, type }`, or an error with
 * `code: 'no-image'` (unknown or stale ref) / `'not-an-image'`.
 */
export async function readImageRef(file, ref) {
  const m = REF.exec(String(ref || ''));
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!m) throw fail('no-image', 'not an image ref');
  const offset = parseInt(m[1], 36);
  const hash = m[2];
  const key = `${file}\0${offset}`;
  let img = recent.get(key)?.get(hash);
  if (!img) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !Number.isSafeInteger(offset) || offset >= st.size) throw fail('no-image', 'no such image in this trace');
    const record = await recordAt(file, offset);
    if (!record) throw fail('no-image', 'no such image in this trace');
    const found = new Map();
    for (const i of imagesIn(record)) found.set(hashOf(i.b64), i);
    remember(key, found);
    img = found.get(hash);
  }
  if (!img) throw fail('no-image', 'no such image in this trace');
  const body = Buffer.from(img.b64, 'base64');
  const type = sniffImageType(body);
  if (!type || !SERVABLE.has(type)) throw fail('not-an-image', 'this embedded data is not an image');
  return { body, type };
}

export const __recentForTest = () => recent;
