// Is the Space's data going to survive a restart? (src/storage.js)
// Persistent means DATA_DIR is /data AND /data is a real mount; off a Space the
// disk is the operator's own and always counts. Pure: /proc/mounts is injected.
//
// Run with: node --test test/storage.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPoints, storageStatus } from '../src/storage.js';

const SPACE = { SPACE_ID: 'you/agent-manager' };
// /proc/mounts on a live Space with a bucket attached, trimmed.
const WITH_BUCKET = [
  'overlay / overlay rw,relatime,lowerdir=/a,upperdir=/b,workdir=/c 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  'hf-mount /data fuse rw,nosuid,nodev,relatime,user_id=1000,group_id=1000,allow_other 0 0',
  '',
].join('\n');
const WITHOUT_BUCKET = WITH_BUCKET.split('\n').filter((l) => !l.includes(' /data ')).join('\n');
const status = (dataDir, mounts, env = SPACE) => storageStatus({ env, dataDir, readMounts: () => mounts });

test('a Space with a bucket mounted at /data is persistent', () => {
  assert.deepEqual(status('/data', WITH_BUCKET), { persistent: true, dataDir: '/data', reason: 'mounted' });
  assert.equal(status('/data/', WITH_BUCKET).persistent, true, 'a trailing slash is the same folder');
});

test('a Space that fell back to $HOME/data is not', () => {
  // entrypoint.sh: /data not writable -> DATA_DIR=$HOME/data. Even with a
  // mount elsewhere, that folder is the container's disk.
  assert.deepEqual(status('/home/node/data', WITH_BUCKET), { persistent: false, dataDir: '/home/node/data', reason: 'fallback' });
});

test('/data that is only a writable folder is not', () => {
  assert.deepEqual(status('/data', WITHOUT_BUCKET), { persistent: false, dataDir: '/data', reason: 'not-mounted' });
  // A mount BELOW /data is not a mount AT /data.
  assert.equal(status('/data', WITHOUT_BUCKET + 'hf-mount /data/sub fuse rw 0 0\n').reason, 'not-mounted');
  assert.equal(status('/data', WITHOUT_BUCKET + 'hf-mount /data2 fuse rw 0 0\n').reason, 'not-mounted');
});

test('an in-memory mount at /data is not', () => {
  assert.equal(status('/data', WITHOUT_BUCKET + 'tmpfs /data tmpfs rw 0 0\n').reason, 'volatile-mount');
});

test('unreadable /proc/mounts is not proof of a bucket', () => {
  const s = storageStatus({ env: SPACE, dataDir: '/data', readMounts: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  assert.deepEqual(s, { persistent: false, dataDir: '/data', reason: 'mounts-unreadable' });
});

test('off a Space the disk counts as persistent, whatever is mounted', () => {
  for (const dir of ['/data', '/home/me/am/data', '/tmp/x']) {
    assert.deepEqual(status(dir, WITHOUT_BUCKET, {}), { persistent: true, dataDir: dir, reason: 'not-a-space' });
  }
  assert.equal(status('/data', WITHOUT_BUCKET, { SPACE_ID: '' }).reason, 'not-a-space');
});

test('mount points: fields parsed, octal escapes undone', () => {
  const m = mountPoints('a /data fuse rw 0 0\nb /mnt/with\\040space ext4 rw 0 0\n\n');
  assert.equal(m.get('/data'), 'fuse');
  assert.equal(m.get('/mnt/with space'), 'ext4');
  assert.equal(m.size, 2);
});
