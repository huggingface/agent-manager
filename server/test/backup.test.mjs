import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRON, cronFor, validRepoId, jobArgs, fingerprint, reconcile, JOB_SCRIPT,
} from '../src/backup.js';

// The interval enum is the operator-facing contract; every value the config
// accepts must map to a cron, and 'never' must map to nothing at all.
test('cronFor covers the config enum and only that', () => {
  for (const every of ['hour', '6h', 'day']) {
    assert.ok(cronFor(every), `${every} should have a cron`);
    assert.match(cronFor(every), /^[\d*\/ ,-]+$/);
  }
  assert.equal(cronFor('never'), null);
  assert.equal(cronFor('nonsense'), null);
  assert.equal(cronFor(undefined), null);
  assert.equal(Object.keys(CRON).length, 3);
});

// A run must be dead before the next one is due, or a hung backup stacks up
// behind itself.
test('the job timeout is shorter than the shortest interval', () => {
  const args = jobArgs({ source: 'ns/b', mirror: '', dataset: 'ns/d', cron: CRON.hour, name: 'x' });
  const secs = Number(args[args.indexOf('--timeout') + 1].replace('s', ''));
  assert.ok(secs < 3600, `timeout ${secs}s must be under the hourly cadence`);
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
  const args = jobArgs({ source: 'ns/src', mirror: 'ns/mir', dataset: 'ns/ds', cron: CRON.hour, name: 'am-backup-x' });
  assert.ok(args.includes('-e'));
  assert.ok(args.includes('AM_SOURCE=ns/src'));
  assert.ok(args.includes('AM_MIRROR=ns/mir'));
  assert.ok(args.includes('AM_DATASET=ns/ds'));
  // The script is one argument, and it names only env vars.
  const script = args[args.length - 1];
  assert.equal(script, JOB_SCRIPT);
  for (const id of ['ns/src', 'ns/mir', 'ns/ds']) {
    assert.ok(!script.includes(id), 'ids must not be interpolated into the script');
  }
});

// A backup must never be able to write to the bucket it is reading.
test('the source bucket is mounted read-only', () => {
  const args = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds', cron: CRON.day, name: 'x' });
  const vol = args[args.indexOf('-v') + 1];
  assert.equal(vol, 'hf://buckets/ns/src:/live:ro');
  assert.ok(vol.endsWith(':ro'));
});

test('no cron means a one-off detached job, not a schedule', () => {
  const once = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds' });
  assert.deepEqual(once.slice(0, 3), ['jobs', 'run', '--detach']);
  const sched = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds', cron: CRON.hour });
  assert.deepEqual(sched.slice(0, 4), ['jobs', 'scheduled', 'run', CRON.hour]);
});

// The upload has to create the dataset private, and re-verify privacy every run:
// the mirror carries live agent credentials (docs/bucket-backup.md §4).
test('the job script gates on privacy and creates private', () => {
  assert.match(JOB_SCRIPT, /--private/);
  assert.match(JOB_SCRIPT, /refusing to back up/);
  assert.match(JOB_SCRIPT, /dataset_info/);
  assert.match(JOB_SCRIPT, /bucket_info/);
  assert.match(JOB_SCRIPT, /set -euo pipefail/);
});

// There is no "update" verb for a scheduled Job, so any change is a
// delete-then-create. Missing a change would silently keep backing up to the
// old destination.
test('reconcile replaces on any change and removes when disabled', () => {
  const fp = (o) => ({ fingerprint: fingerprint(o), suspend: false });
  const base = { cron: CRON.hour, source: 'ns/s', mirror: 'ns/m', dataset: 'ns/d' };

  assert.equal(reconcile(null, fp(base)), 'create');
  assert.equal(reconcile(fp(base), fp(base)), 'keep');
  assert.equal(reconcile(fp(base), null), 'delete');
  assert.equal(reconcile(null, null), 'keep');

  for (const changed of [
    { ...base, cron: CRON.day },
    { ...base, source: 'ns/other' },
    { ...base, mirror: '' },
    { ...base, dataset: 'ns/other' },
  ]) {
    assert.equal(reconcile(fp(base), fp(changed)), 'replace', JSON.stringify(changed));
  }

  // A suspended schedule is not a working backup — bring it back.
  assert.equal(reconcile({ fingerprint: fingerprint(base), suspend: true }, fp(base)), 'replace');
});

test('fingerprint distinguishes an empty mirror from a named one', () => {
  const a = fingerprint({ cron: CRON.hour, source: 'ns/s', mirror: '', dataset: 'ns/d' });
  const b = fingerprint({ cron: CRON.hour, source: 'ns/s', mirror: 'ns/m', dataset: 'ns/d' });
  assert.notEqual(a, b);
});
