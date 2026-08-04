import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVERY_MS, INTERVALS, intervalMs, validRepoId, jobArgs, JOB_SCRIPT, JOB_FLAVOR,
  hasToken, unavailableReason, runNowBlockedBy,
} from '../src/backup.js';

// "Back up now" must not require a schedule: taking one backup before a risky
// change is the main reason to want the button at all.
test('on demand works with the schedule off, but not without a token', () => {
  const saved = { t: process.env.HF_TOKEN, h: process.env.HUGGING_FACE_HUB_TOKEN, s: process.env.AM_BACKUP_SOURCE };
  try {
    process.env.HF_TOKEN = 'hf_test';
    process.env.AM_BACKUP_SOURCE = 'ns/bucket';
    // Off is a reason the TIMER stays quiet, never a reason to refuse on demand.
    assert.equal(unavailableReason({ backup: { every: 'never' } }), 'switched off');
    assert.equal(runNowBlockedBy(), null);

    // The prerequisites are still prerequisites.
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    assert.match(runNowBlockedBy(), /HF_TOKEN/);
    process.env.HF_TOKEN = 'hf_test';
    delete process.env.AM_BACKUP_SOURCE;
    assert.match(runNowBlockedBy(), /no bucket/);
  } finally {
    for (const [k, v] of [['HF_TOKEN', saved.t], ['HUGGING_FACE_HUB_TOKEN', saved.h], ['AM_BACKUP_SOURCE', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// The operator pays for every run, so the tier is pinned rather than inherited
// from the Hub's default — which could change under us and quietly make hourly
// backups more expensive.
test('the job hardware is pinned to the cheapest tier', () => {
  assert.equal(JOB_FLAVOR, 'cpu-basic');
  const args = jobArgs({ source: 'ns/b', mirror: '', dataset: 'ns/d' });
  assert.equal(args[args.indexOf('--flavor') + 1], 'cpu-basic');
});

// The interval enum is the operator-facing contract: off, 1h, 3h, 24h.
test('the interval enum is exactly off/1h/3h/24h', () => {
  assert.deepEqual(INTERVALS, ['never', '1h', '3h', '24h']);
  assert.equal(intervalMs('1h'), 3_600_000);
  assert.equal(intervalMs('3h'), 3 * 3_600_000);
  assert.equal(intervalMs('24h'), 24 * 3_600_000);
  // 'never' has no interval, so "is it due?" can never be true.
  assert.equal(intervalMs('never'), 0);
  assert.equal(intervalMs('nonsense'), 0);
  assert.equal(intervalMs(undefined), 0);
});

// A run must be dead before the next one is due, or a hung backup stacks up
// behind itself.
test('the job timeout is shorter than the shortest interval', () => {
  const args = jobArgs({ source: 'ns/b', mirror: '', dataset: 'ns/d' });
  const secs = Number(args[args.indexOf('--timeout') + 1].replace('s', ''));
  assert.ok(secs * 1000 < EVERY_MS['1h'], `timeout ${secs}s must be under 1h`);
});

test('validRepoId accepts real ids and rejects shell metacharacters', () => {
  for (const ok of ['lvwerra/agent-manager-data', 'org/a.b-c_d', 'a1/b2']) {
    assert.ok(validRepoId(ok), `${ok} should be valid`);
  }
  for (const bad of [
    'no-slash', '/leading', 'trailing/', 'a/b/c', '-dash/start', 'a/$(whoami)',
    'a/b;rm -rf /', 'a/b`id`', 'a/b|c', 'a/b c', 'a/b\nc', '', null, undefined, 42,
    `x/${'y'.repeat(200)}`,
  ]) {
    assert.equal(validRepoId(bad), false, `${String(bad)} should be rejected`);
  }
});

// The security property of this module: operator-supplied strings travel as
// argv/env, never as shell syntax. If someone later interpolates a config value
// into JOB_SCRIPT, this fails.
test('config values reach the job as env vars, not shell text', () => {
  const args = jobArgs({ source: 'ns/src', mirror: 'ns/mir', dataset: 'ns/ds' });
  assert.ok(args.includes('AM_SOURCE=ns/src'));
  assert.ok(args.includes('AM_MIRROR=ns/mir'));
  assert.ok(args.includes('AM_DATASET=ns/ds'));
  const script = args[args.length - 1];
  assert.equal(script, JOB_SCRIPT);
  for (const id of ['ns/src', 'ns/mir', 'ns/ds']) {
    assert.ok(!script.includes(id), 'ids must not be interpolated into the script');
  }
});

// A backup must never be able to write to the bucket it is reading.
test('the source bucket is mounted read-only', () => {
  const args = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds' });
  const vol = args[args.indexOf('-v') + 1];
  assert.equal(vol, 'hf://buckets/ns/src:/live:ro');
});

test('a backup is one detached job launch', () => {
  const args = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds' });
  assert.deepEqual(args.slice(0, 3), ['jobs', 'run', '--detach']);
  assert.ok(args.includes('--secrets') && args.includes('HF_TOKEN'));
});

// The upload has to create the dataset private and re-verify privacy every run:
// the copy carries live agent credentials (docs/bucket-backup.md §4).
test('the job script gates on privacy and creates private', () => {
  assert.match(JOB_SCRIPT, /--private/);
  assert.match(JOB_SCRIPT, /refusing to back up/);
  assert.match(JOB_SCRIPT, /dataset_info/);
  assert.match(JOB_SCRIPT, /bucket_info/);
  assert.match(JOB_SCRIPT, /set -euo pipefail/);
});

// Without a token there is no way to launch a Job or write to the Hub, so the
// feature must report itself unavailable rather than failing every interval.
test('no HF_TOKEN means unavailable, with the token as the stated reason', () => {
  const saved = [process.env.HF_TOKEN, process.env.HUGGING_FACE_HUB_TOKEN, process.env.AM_BACKUP_SOURCE];
  try {
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    process.env.AM_BACKUP_SOURCE = 'ns/bucket';
    assert.equal(hasToken(), false);
    assert.match(unavailableReason({ backup: { every: '1h' } }), /HF_TOKEN/);

    process.env.HF_TOKEN = 'hf_test';
    assert.equal(hasToken(), true);
    // With a token, a bucket and an interval, nothing stands in the way.
    assert.equal(unavailableReason({ backup: { every: '1h' } }), null);
    // Off is off, whatever else is true.
    assert.equal(unavailableReason({ backup: { every: 'never' } }), 'switched off');
    assert.equal(unavailableReason({}), 'switched off');
    // No bucket to read means nothing to back up.
    delete process.env.AM_BACKUP_SOURCE;
    assert.match(unavailableReason({ backup: { every: '1h' } }), /no bucket/);
  } finally {
    [process.env.HF_TOKEN, process.env.HUGGING_FACE_HUB_TOKEN, process.env.AM_BACKUP_SOURCE] = saved;
    for (const [k, v] of [['HF_TOKEN', saved[0]], ['HUGGING_FACE_HUB_TOKEN', saved[1]], ['AM_BACKUP_SOURCE', saved[2]]]) {
      if (v === undefined) delete process.env[k];
    }
  }
});
