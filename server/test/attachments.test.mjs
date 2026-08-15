import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-attachments-'));
process.env.DATA_DIR = root;

const {
  ATTACHMENT_LIMIT, SESSION_ATTACHMENT_LIMIT, detectImageMime, formatAttachmentDelivery,
  formatAttachmentPrelude, pruneAttachmentDirs, receiveAttachment, removeAttachment, removeSessionAttachments,
  resolveAttachment, resolveAttachments,
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
const receive = (bytes, sessionId, contentType = 'application/octet-stream', fileName = 'attachment') =>
  receiveAttachment(Readable.from([bytes]), sessionId, { contentType, fileName });

try {
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
  assert.equal(detectImageMime(gif), 'image/gif');
  assert.equal(detectImageMime(webp), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('<svg/>')), null);

  const stored = await receive(png, 'codex-123abc', 'image/png', 'screen.png');
  assert.match(stored.id, /^att_[a-f0-9]{24}$/);
  assert.equal(stored.mime, 'image/png');
  assert.equal(stored.bytes, png.length);
  assert.equal(fs.readFileSync(stored.path).compare(png), 0);
  assert.deepEqual(resolveAttachment('codex-123abc', stored.id), stored);
  assert.deepEqual(resolveAttachments('codex-123abc', [stored.id]), [stored]);

  // Attachments created by the image-only implementation remain resolvable
  // after the generalized filename format ships.
  const legacyId = `att_${'1'.repeat(24)}`;
  const legacyPath = path.join(path.dirname(stored.path), `${legacyId}.png`);
  fs.writeFileSync(legacyPath, png);
  const legacy = resolveAttachment('codex-123abc', legacyId);
  assert.equal(legacy.kind, 'image');
  assert.equal(legacy.mime, 'image/png');
  assert.equal(legacy.path, legacyPath);

  assert.throws(() => resolveAttachment('other-123abc', stored.id), /not found/);
  assert.throws(() => resolveAttachment('codex-123abc', '../sessions.json'), /not found/);
  assert.throws(() => resolveAttachments('codex-123abc', Array(6).fill(stored.id)), /at most five/);

  const mislabeled = await receive(png, 'codex-123abc', 'image/jpeg', 'wrong.jpg');
  assert.equal(mislabeled.mime, 'image/png');
  assert.equal(mislabeled.name, 'wrong.png');
  const untyped = await receive(png, 'codex-123abc', '', 'Screenshot');
  assert.equal(untyped.mime, 'image/png');
  assert.equal(untyped.name, 'Screenshot.png');

  const docx = await receive(Buffer.from('PK\u0003\u0004opaque office data'), 'codex-123abc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    encodeURIComponent('../../Quarterly Report.docx'));
  assert.equal(docx.kind, 'file');
  assert.equal(docx.name, 'Quarterly Report.docx');
  assert.equal(docx.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(path.basename(docx.path), new RegExp(`^${docx.id}-Quarterly Report\\.docx$`));
  assert.match(docx.insertText, /^File: /);
  assert.deepEqual(resolveAttachment('codex-123abc', docx.id), docx);

  const pdf = await receive(Buffer.from('%PDF-1.7\nopaque pdf data'), 'codex-123abc',
    'application/pdf', 'notes.pdf');
  assert.equal(pdf.kind, 'file');
  assert.equal(pdf.mime, 'application/pdf');
  const svg = await receive(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'codex-123abc',
    'image/svg+xml', 'diagram.svg');
  assert.equal(svg.kind, 'file');
  assert.equal(svg.mime, 'image/svg+xml');
  const opaque = await receive(Buffer.from('unknown-format'), 'codex-123abc',
    'application/x-custom-format', 'model.blend');
  assert.equal(opaque.kind, 'file');
  assert.equal(opaque.mime, 'application/octet-stream');
  const discarded = await receive(Buffer.from('discard me'), 'discard-123abc',
    'application/octet-stream', 'discard.bin');
  await removeAttachment('discard-123abc', discarded.id);
  assert.throws(() => resolveAttachment('discard-123abc', discarded.id), /not found/);
  await assert.rejects(
    receive(png.subarray(0, 24), 'codex-123abc', 'image/png', 'broken.png'),
    (error) => error.statusCode === 415 && /malformed/.test(error.message),
  );
  await assert.rejects(
    receive(Buffer.alloc(0), 'codex-123abc', 'application/octet-stream', 'empty.bin'),
    (error) => error.statusCode === 413,
  );
  const tooLarge = Readable.from((function* chunks() {
    let remaining = ATTACHMENT_LIMIT + 1;
    while (remaining > 0) {
      const size = Math.min(1024 * 1024, remaining);
      remaining -= size;
      yield Buffer.alloc(size);
    }
  }()));
  await assert.rejects(
    receiveAttachment(tooLarge, 'large-123abc', { contentType: 'application/octet-stream', fileName: 'large.bin' }),
    (error) => error.statusCode === 413 && /100 MB/.test(error.message),
  );
  assert.equal(fs.readdirSync(path.join(root, 'state', 'attachments', 'large-123abc')).some((name) => name.endsWith('.part')), false);

  const aborted = new Readable({
    read() {
      this.push(png.subarray(0, 20));
      this.destroy(new Error('request aborted'));
    },
  });
  await assert.rejects(receiveAttachment(aborted, 'aborted-123abc', {
    contentType: 'image/png', fileName: 'aborted.png',
  }), /request aborted/);
  assert.equal(fs.readdirSync(path.join(root, 'state', 'attachments', 'aborted-123abc')).some((name) => name.endsWith('.part')), false);

  const quotaDir = path.join(root, 'state', 'attachments', 'quota-123abc');
  fs.mkdirSync(quotaDir, { recursive: true });
  const quotaFile = path.join(quotaDir, 'existing.bin');
  fs.writeFileSync(quotaFile, '');
  fs.truncateSync(quotaFile, SESSION_ATTACHMENT_LIMIT);
  await assert.rejects(
    receive(png, 'quota-123abc', 'image/png', 'quota.png'),
    (error) => error.statusCode === 413 && /500 MB/.test(error.message),
  );

  const raceQuotaDir = path.join(root, 'state', 'attachments', 'race-quota-123abc');
  fs.mkdirSync(raceQuotaDir, { recursive: true });
  const raceQuotaFile = path.join(raceQuotaDir, 'existing.bin');
  fs.writeFileSync(raceQuotaFile, '');
  fs.truncateSync(raceQuotaFile, SESSION_ATTACHMENT_LIMIT - png.length);
  const raced = await Promise.allSettled([
    receive(png, 'race-quota-123abc', 'image/png', 'first.png'),
    receive(png, 'race-quota-123abc', 'image/png', 'second.png'),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => result.status === 'rejected'
    && result.reason.statusCode === 413).length, 1);

  const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
    receive(png, 'parallel-123abc', 'application/octet-stream', 'parallel.png')));
  assert.equal(new Set(concurrent.map((image) => image.id)).size, concurrent.length);

  const formatted = formatAttachmentDelivery('codex', 'Compare this', [stored]);
  assert.match(formatted, /Compare this/);
  assert.match(formatted, /Attached files:/);
  assert.match(formatted, new RegExp(stored.id));
  assert.match(formatAttachmentDelivery('gemini', '', [stored]), /Please inspect the attached screenshot\./);
  assert.match(formatAttachmentDelivery('codex', '', [docx]), /Please inspect the attached file\./);
  assert.deepEqual(formatAttachmentPrelude('hermes', [stored]), [`/image ${JSON.stringify(stored.path)}`]);
  assert.deepEqual(formatAttachmentPrelude('hermes', [docx, stored]), [`/image ${JSON.stringify(stored.path)}`]);
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
