import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-attachments-'));
process.env.DATA_DIR = root;

const {
  ATTACHMENT_LIMIT, SESSION_ATTACHMENT_LIMIT, detectImageMime, formatAttachmentDelivery,
  formatAttachmentPrelude, pruneAttachmentDirs, receiveImage, removeSessionAttachments, resolveImage,
  resolveImages,
} = await import('../src/attachments.js');
const { cliById } = await import('../src/config.js');
const { commandFor } = await import('../src/runner.js');

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

  const mislabeled = await receiveImage(Readable.from([png]), 'codex-123abc', 'image/jpeg');
  assert.equal(mislabeled.mime, 'image/png');
  const untyped = await receiveImage(Readable.from([png]), 'codex-123abc', '');
  assert.equal(untyped.mime, 'image/png');
  await assert.rejects(
    receiveImage(Readable.from([png.subarray(0, 24)]), 'codex-123abc', 'image/png'),
    (error) => error.statusCode === 415 && /malformed/.test(error.message),
  );
  await assert.rejects(
    receiveImage(Readable.from([]), 'codex-123abc', 'image/png'),
    (error) => error.statusCode === 413,
  );
  await assert.rejects(
    receiveImage(Readable.from([Buffer.alloc(ATTACHMENT_LIMIT + 1)]), 'large-123abc', 'image/png'),
    (error) => error.statusCode === 413 && /25 MB/.test(error.message),
  );
  assert.equal(fs.readdirSync(path.join(root, 'state', 'attachments', 'large-123abc')).some((name) => name.endsWith('.part')), false);

  const aborted = new Readable({
    read() {
      this.push(png.subarray(0, 20));
      this.destroy(new Error('request aborted'));
    },
  });
  await assert.rejects(receiveImage(aborted, 'aborted-123abc', 'image/png'), /request aborted/);
  assert.equal(fs.readdirSync(path.join(root, 'state', 'attachments', 'aborted-123abc')).some((name) => name.endsWith('.part')), false);

  const quotaDir = path.join(root, 'state', 'attachments', 'quota-123abc');
  fs.mkdirSync(quotaDir, { recursive: true });
  const quotaFile = path.join(quotaDir, 'existing.bin');
  fs.writeFileSync(quotaFile, '');
  fs.truncateSync(quotaFile, SESSION_ATTACHMENT_LIMIT);
  await assert.rejects(
    receiveImage(Readable.from([png]), 'quota-123abc', 'image/png'),
    (error) => error.statusCode === 413 && /500 MB/.test(error.message),
  );

  const raceQuotaDir = path.join(root, 'state', 'attachments', 'race-quota-123abc');
  fs.mkdirSync(raceQuotaDir, { recursive: true });
  const raceQuotaFile = path.join(raceQuotaDir, 'existing.bin');
  fs.writeFileSync(raceQuotaFile, '');
  fs.truncateSync(raceQuotaFile, SESSION_ATTACHMENT_LIMIT - png.length);
  const raced = await Promise.allSettled([
    receiveImage(Readable.from([png]), 'race-quota-123abc', 'image/png'),
    receiveImage(Readable.from([png]), 'race-quota-123abc', 'image/png'),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => result.status === 'rejected'
    && result.reason.statusCode === 413).length, 1);

  const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
    receiveImage(Readable.from([png]), 'parallel-123abc', 'application/octet-stream')));
  assert.equal(new Set(concurrent.map((image) => image.id)).size, concurrent.length);

  const formatted = formatAttachmentDelivery('codex', 'Compare this', [stored]);
  assert.match(formatted, /Compare this/);
  assert.match(formatted, /Attached screenshots:/);
  assert.match(formatted, new RegExp(stored.id));
  assert.match(formatAttachmentDelivery('gemini', '', [stored]), /Please inspect the attached screenshot\./);
  assert.deepEqual(formatAttachmentPrelude('hermes', [stored]), [`/image ${JSON.stringify(stored.path)}`]);
  assert.deepEqual(formatAttachmentPrelude('codex', [stored]), []);
  assert.equal(
    cliById('codex').withPrompt("'compare  both'", ["'/tmp/first image.png'", "'/tmp/second.png'"]),
    "codex -i '/tmp/first image.png' -i '/tmp/second.png' 'compare  both'",
  );
  assert.equal(
    commandFor({
      id: 'codex-first-image', cli: 'codex', everStarted: false,
      pendingPrompt: 'compare  both', pendingImagePaths: ['/tmp/first image.png'],
    }),
    "exec codex -i '/tmp/first image.png' 'compare  both'",
  );

  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const oldPart = path.join(path.dirname(stored.path), '.crashed.part');
  fs.writeFileSync(oldPart, 'partial');
  fs.utimesSync(oldPart, old, old);
  const orphan = path.join(root, 'state', 'attachments', 'orphan-123abc');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'old'), 'old');
  fs.utimesSync(path.join(orphan, 'old'), old, old);
  fs.utimesSync(orphan, old, old);
  await pruneAttachmentDirs(['codex-123abc']);
  assert.equal(fs.existsSync(oldPart), false);
  assert.equal(fs.existsSync(orphan), false);

  await removeSessionAttachments('codex-123abc');
  assert.equal(fs.existsSync(path.dirname(stored.path)), false);
  console.log('attachment tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
