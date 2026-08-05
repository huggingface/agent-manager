import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-attachments-'));
process.env.DATA_DIR = root;

const {
  detectImageMime, formatAttachmentDelivery, pruneAttachmentDirs, receiveImage, removeSessionAttachments,
  resolveImage, resolveImages,
} = await import('../src/attachments.js');

const png = Buffer.alloc(45);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(13, 8); Buffer.from('IHDR').copy(png, 12);
png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
Buffer.from('IEND').copy(png, 37);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
const gif = Buffer.alloc(14);
Buffer.from('GIF89a', 'ascii').copy(gif); gif.writeUInt16LE(1, 6); gif.writeUInt16LE(1, 8); gif[13] = 0x3b;
const webp = Buffer.alloc(20);
Buffer.from('RIFF', 'ascii').copy(webp); webp.writeUInt32LE(12, 4);
Buffer.from('WEBPVP8 ', 'ascii').copy(webp, 8);

try {
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
  assert.equal(detectImageMime(gif), 'image/gif');
  assert.equal(detectImageMime(webp), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('<svg/>')), null);

  const stored = await receiveImage(Readable.from([png]), 'codex-123abc', 'image/png');
  assert.match(stored.id, /^att_[a-f0-9]{24}$/);
  assert.equal(stored.mime, 'image/png');
  assert.equal(stored.bytes, png.length);
  assert.equal(fs.readFileSync(stored.path).compare(png), 0);
  assert.deepEqual(resolveImage('codex-123abc', stored.id), stored);
  assert.deepEqual(resolveImages('codex-123abc', [stored.id]), [stored]);

  assert.throws(() => resolveImage('other-123abc', stored.id), /not found/);
  assert.throws(() => resolveImage('codex-123abc', '../sessions.json'), /not found/);
  assert.throws(() => resolveImages('codex-123abc', Array(6).fill(stored.id)), /at most five/);

  await assert.rejects(
    receiveImage(Readable.from([png]), 'codex-123abc', 'image/jpeg'),
    (error) => error.statusCode === 415,
  );
  await assert.rejects(
    receiveImage(Readable.from([png.subarray(0, 24)]), 'codex-123abc', 'image/png'),
    (error) => error.statusCode === 415 && /malformed/.test(error.message),
  );
  await assert.rejects(
    receiveImage(Readable.from([]), 'codex-123abc', 'image/png'),
    (error) => error.statusCode === 413,
  );

  const formatted = formatAttachmentDelivery('codex', 'Compare this', [stored]);
  assert.match(formatted, /Compare this/);
  assert.match(formatted, /Attached screenshots:/);
  assert.match(formatted, new RegExp(stored.id));
  assert.match(formatAttachmentDelivery('gemini', '', [stored]), /Please inspect the attached screenshot\./);

  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const oldPart = path.join(path.dirname(stored.path), '.crashed.part');
  fs.writeFileSync(oldPart, 'partial');
  fs.utimesSync(oldPart, old, old);
  const orphan = path.join(root, 'state', 'attachments', 'orphan-123abc');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'old'), 'old');
  fs.utimesSync(path.join(orphan, 'old'), old, old);
  fs.utimesSync(orphan, old, old);
  pruneAttachmentDirs(['codex-123abc']);
  assert.equal(fs.existsSync(oldPart), false);
  assert.equal(fs.existsSync(orphan), false);

  removeSessionAttachments('codex-123abc');
  assert.equal(fs.existsSync(path.dirname(stored.path)), false);
  console.log('attachment tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
