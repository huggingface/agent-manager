import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a backup requires the /data mount and uses its bucket, even when another bucket comes first', async () => {
  const saved = {
    space: process.env.SPACE_ID,
    token: process.env.HF_TOKEN,
    override: process.env.AM_BACKUP_SOURCE,
    fetch: globalThis.fetch,
  };
  process.env.SPACE_ID = 'owner/agent-manager';
  process.env.HF_TOKEN = 'test-token';
  delete process.env.AM_BACKUP_SOURCE;

  const volumes = [
    { type: 'bucket', source: 'owner/cache-bucket', mountPath: '/cache' },
  ];
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address.endsWith('/api/spaces/owner/agent-manager')) {
      return options.headers.authorization
        ? new Response(JSON.stringify({ id: 'owner/agent-manager', private: true, runtime: { volumes } }), { status: 200 })
        : new Response(JSON.stringify({ error: 'private' }), { status: 404 });
    }
    if (address.includes('/api/buckets/')) {
      return new Response(JSON.stringify({ error: 'private' }), { status: 404 });
    }
    throw new Error(`Unexpected URL: ${address}`);
  };

  let visibility;
  try {
    visibility = await import('../src/visibility.js');
    const backup = await import('../src/backup.js');
    await visibility.startVisibilityWatch();
    assert.equal(visibility.isLocked(), false);
    assert.deepEqual(visibility.mountedBuckets(), ['owner/cache-bucket']);
    assert.equal(backup.sourceBucket(), null);
    assert.match(backup.runNowBlockedBy(), /mounted at \/data/);

    // A changed credential re-discovers the current mounts.
    volumes.push({ type: 'bucket', source: 'owner/agent-manager-data', mountPath: '/data' });
    process.env.HF_TOKEN = 'test-token-rotated';
    await visibility.visibilityMonitor.check();
    assert.equal(visibility.isLocked(), false);
    assert.deepEqual(visibility.mountedBuckets(), ['owner/cache-bucket', 'owner/agent-manager-data']);
    assert.equal(backup.sourceBucket(), 'owner/agent-manager-data');
    assert.equal(backup.runNowBlockedBy(), null);
    assert.ok(backup.jobArgs({
      source: backup.sourceBucket(), dataset: 'owner/backup', staging: 'owner/staging',
    }).includes('AM_SOURCE=owner/agent-manager-data'));
  } finally {
    visibility?.visibilityMonitor.stop();
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [['SPACE_ID', saved.space], ['HF_TOKEN', saved.token], ['AM_BACKUP_SOURCE', saved.override]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
