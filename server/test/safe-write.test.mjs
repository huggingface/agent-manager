// Workspace upload publication: create-only, explicit conditional replacement,
// and exact-byte preservation on every failure path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { receiveWorkspaceFile } from '../src/safe-write.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-safe-write-'));
const target = path.join(root, 'report.txt');
const parts = () => fs.readdirSync(root).filter((name) => name.endsWith('.part'));
const body = (text) => Readable.from([Buffer.from(text)]);

async function expectCollision(text = 'not written') {
  try {
    await receiveWorkspaceFile(body(text), target, { displayPath: 'reports/report.txt' });
    assert.fail('expected a collision');
  } catch (error) {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'file-exists');
    assert.equal(error.path, 'reports/report.txt');
    assert.equal(error.name, 'report.txt');
    assert.match(error.revision, /^sha256:/);
    assert.match(error.replaceToken, /^[a-f0-9]{64}$/);
    return error;
  }
}

try {
  fs.writeFileSync(target, 'ORIGINAL');
  const first = await expectCollision();
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'create-only collision keeps existing bytes');

  const aborted = new Readable({
    read() { this.push('PARTIAL'); this.destroy(new Error('connection interrupted')); },
  });
  await assert.rejects(receiveWorkspaceFile(aborted, target, {
    displayPath: 'reports/report.txt', replaceToken: first.replaceToken,
  }), /connection interrupted/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'aborted replacement keeps existing bytes');
  assert.deepEqual(parts(), [], 'aborted replacement removes only its temporary');

  await receiveWorkspaceFile(body('REPLACED'), target, {
    displayPath: 'reports/report.txt', replaceToken: first.replaceToken,
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'REPLACED');

  const stale = await expectCollision();
  fs.writeFileSync(target, 'AGENT-WROTE-THIS');
  await assert.rejects(receiveWorkspaceFile(body('STALE-CHOICE'), target, {
    displayPath: 'reports/report.txt', replaceToken: stale.replaceToken,
  }), (error) => error.statusCode === 409 && error.code === 'replacement-stale'
    && /^[a-f0-9]{64}$/.test(error.replaceToken));
  assert.equal(fs.readFileSync(target, 'utf8'), 'AGENT-WROTE-THIS', 'stale confirmation preserves newer bytes');

  const duringUpload = await expectCollision();
  let continued;
  const slowReplacement = new Readable({
    read() {
      if (continued) return;
      continued = true;
      this.push('FIRST-UPLOAD-CHUNK');
      setTimeout(() => {
        fs.writeFileSync(target, 'AGENT-WROTE-DURING-UPLOAD');
        this.push('SECOND-UPLOAD-CHUNK'); this.push(null);
      }, 20);
    },
  });
  await assert.rejects(receiveWorkspaceFile(slowReplacement, target, {
    displayPath: 'reports/report.txt', replaceToken: duringUpload.replaceToken,
  }), (error) => error.statusCode === 409 && error.code === 'replacement-stale');
  assert.equal(fs.readFileSync(target, 'utf8'), 'AGENT-WROTE-DURING-UPLOAD',
    'a change during upload wins over the stale replacement stream');

  const beforePublish = await expectCollision();
  await assert.rejects(receiveWorkspaceFile(body('WILL-NOT-LAND'), target, {
    displayPath: 'reports/report.txt', replaceToken: beforePublish.replaceToken,
    publishReplacement: async () => { throw new Error('injected publication failure'); },
  }), /injected publication failure/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'AGENT-WROTE-DURING-UPLOAD', 'failed publish preserves existing bytes');
  assert.deepEqual(parts(), []);

  const createTarget = path.join(root, 'created.txt');
  const creates = await Promise.allSettled([
    receiveWorkspaceFile(body('FIRST'), createTarget, { displayPath: 'created.txt' }),
    receiveWorkspaceFile(body('SECOND'), createTarget, { displayPath: 'created.txt' }),
  ]);
  assert.equal(creates.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(creates.filter((result) => result.status === 'rejected'
    && result.reason.code === 'file-exists').length, 1);
  assert.ok(['FIRST', 'SECOND'].includes(fs.readFileSync(createTarget, 'utf8')));

  const token = (await (async () => {
    try { await receiveWorkspaceFile(body('x'), target, { displayPath: 'report.txt' }); }
    catch (error) { return error.replaceToken; }
  })());
  const replacements = await Promise.allSettled([
    receiveWorkspaceFile(body('REPLACE-A'), target, { displayPath: 'report.txt', replaceToken: token }),
    receiveWorkspaceFile(body('REPLACE-B'), target, { displayPath: 'report.txt', replaceToken: token }),
  ]);
  assert.equal(replacements.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(replacements.filter((result) => result.status === 'rejected'
    && result.reason.code === 'replacement-stale').length, 1);

  const collisionTempTarget = path.join(root, 'safe.txt');
  const occupied = path.join(root, '.safe.txt.am-upload-aaaaaaaaaaaaaaaa.part');
  fs.writeFileSync(occupied, 'UNRELATED-SENTINEL');
  const random = [Buffer.alloc(8, 0xaa), Buffer.alloc(8, 0xbb)];
  await receiveWorkspaceFile(body('SAFE'), collisionTempTarget, {
    displayPath: 'safe.txt', randomBytes: () => random.shift(),
  });
  assert.equal(fs.readFileSync(collisionTempTarget, 'utf8'), 'SAFE');
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'UNRELATED-SENTINEL', 'exclusive temp collision leaves unrelated bytes alone');
  assert.equal(fs.existsSync(path.join(root, '.safe.txt.am-upload-bbbbbbbbbbbbbbbb.part')), false);

  const tempLinkTarget = path.join(root, 'temp-link-sentinel.txt');
  const tempLink = path.join(root, '.temp-symlink.txt.am-upload-cccccccccccccccc.part');
  fs.writeFileSync(tempLinkTarget, 'TEMP-LINK-SENTINEL');
  fs.symlinkSync(tempLinkTarget, tempLink);
  const tempRandom = [Buffer.alloc(8, 0xcc), Buffer.alloc(8, 0xdd)];
  await receiveWorkspaceFile(body('SAFE-PAST-LINK'), path.join(root, 'temp-symlink.txt'), {
    displayPath: 'temp-symlink.txt', randomBytes: () => tempRandom.shift(),
  });
  assert.equal(fs.readFileSync(tempLinkTarget, 'utf8'), 'TEMP-LINK-SENTINEL',
    'exclusive temporary creation never follows a pre-existing symlink');
  assert.equal(fs.lstatSync(tempLink).isSymbolicLink(), true, 'cleanup never removes an unowned temporary-path symlink');

  const outside = path.join(root, 'outside.txt');
  const linked = path.join(root, 'linked.txt');
  fs.writeFileSync(outside, 'OUTSIDE');
  fs.symlinkSync(outside, linked);
  await assert.rejects(receiveWorkspaceFile(body('FOLLOWED'), linked, { displayPath: 'linked.txt' }),
    (error) => error.code === 'unsafe-destination');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
  fs.unlinkSync(linked);
  fs.symlinkSync(path.join(root, 'missing.txt'), linked);
  await assert.rejects(receiveWorkspaceFile(body('FOLLOWED'), linked, { displayPath: 'linked.txt' }),
    (error) => error.code === 'unsafe-destination');
  assert.equal(fs.existsSync(path.join(root, 'missing.txt')), false);

  console.log('safe workspace write tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
