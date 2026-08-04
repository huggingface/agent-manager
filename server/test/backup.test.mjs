import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVERY_MS, INTERVALS, intervalMs, validRepoId, jobArgs, JOB_SCRIPT, JOB_FLAVOR,
  hasToken, unavailableReason, runNowBlockedBy, jobName, jobsUrl, isActiveStage, parseJobId,
  normalizeExclude, excludePatterns, MAX_EXCLUDES,
} from '../src/backup.js';

// The rule that is not obvious and cost a Hub round-trip to learn: `**/x/**` does
// NOT match a top-level `x/`, so a bare folder token needs BOTH patterns. Verified
// against the Hub — with only the `**/` form, the copy at the bucket root still
// went up.
test('a bare folder token excludes it at the root AND nested', () => {
  assert.deepEqual(excludePatterns(['env']), ['env/**', '**/env/**']);
  assert.deepEqual(excludePatterns(['node_modules', '.venv']),
    ['node_modules/**', '**/node_modules/**', '.venv/**', '**/.venv/**']);
});

test('a path anchors at the root, and an explicit glob is left alone', () => {
  // A slash means "this exact place", so it is not also matched anywhere.
  assert.deepEqual(excludePatterns(['state/claude/cache']), ['state/claude/cache/**']);
  // Already a glob: passed through untouched, however odd.
  assert.deepEqual(excludePatterns(['**/*.pyc']), ['**/*.pyc']);
  assert.deepEqual(excludePatterns(['cache-*']), ['cache-*']);
  assert.deepEqual(excludePatterns([]), []);
  assert.deepEqual(excludePatterns(undefined), []);
});

test('normalizeExclude tidies input and refuses anything shell-shaped', () => {
  // Slashes at either end are noise; duplicates and blanks go.
  assert.deepEqual(normalizeExclude(['  env  ', '/env/', 'env', '', '   ']), ['env']);
  assert.deepEqual(normalizeExclude(['a', 'b']), ['a', 'b']);
  // Whitespace is what the Job's split relies on NOT being there.
  for (const bad of ['two words', 'tab\there', 'new\nline']) {
    assert.deepEqual(normalizeExclude([bad]), [], `${JSON.stringify(bad)} must be dropped`);
  }
  for (const bad of ['$(whoami)', '`id`', 'a;rm -rf /', 'a|b', 'a&b', "a'b", 'a"b', '<a', 'x'.repeat(65)]) {
    assert.deepEqual(normalizeExclude([bad]), [], `${bad} must be dropped`);
  }
  // Non-strings and non-arrays cannot crash it.
  assert.deepEqual(normalizeExclude([42, null, undefined, {}, 'ok']), ['ok']);
  assert.deepEqual(normalizeExclude('env'), []);
  // Unbounded lists are not a thing an operator needs.
  assert.equal(normalizeExclude(Array.from({ length: 100 }, (_, i) => `d${i}`)).length, MAX_EXCLUDES);
});

// The patterns cross into the Job as one space-joined env var and are split back
// apart by the shell. If either side of that contract changes, this fails.
test('patterns reach the Job as one env var the shell can split exactly', () => {
  const args = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds', exclude: ['env', 'node_modules'] });
  const env = args[args.indexOf('AM_EXCLUDE=env/** **/env/** node_modules/** **/node_modules/**')];
  assert.ok(env, `AM_EXCLUDE not passed as expected; got ${JSON.stringify(args.filter((a) => String(a).startsWith('AM_')))}`);
  // No pattern may contain whitespace, or the split inside the Job is wrong.
  for (const pat of excludePatterns(['env', 'node_modules'])) assert.ok(!/\s/.test(pat));
  // Nothing to skip is an empty value, not a missing variable.
  const none = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds' });
  assert.ok(none.includes('AM_EXCLUDE='));
  // And the script must build the args itself rather than have them interpolated.
  assert.match(JOB_SCRIPT, /read -ra AM_EXCLUDE_PATS/);
  assert.match(JOB_SCRIPT, /EXCLUDE_ARGS\+=\(--exclude "\$p"\)/);
  assert.ok(!JOB_SCRIPT.includes('node_modules/**'), 'patterns must not be baked into the script');
});

// The image installs huggingface_hub unpinned, so the CLI in the Space is not the
// one on a dev machine. A version whose launch output differs left jobId null,
// which killed overlap protection outright — so the parse must not depend on one
// output shape.
test('parseJobId survives any of the shapes the CLI prints', () => {
  const ID = '6a7245596b79c09949c227fc';
  assert.equal(parseJobId(`id=${ID} url=https://huggingface.co/jobs/lvwerra/${ID}`), ID);
  assert.equal(parseJobId(`https://huggingface.co/jobs/lvwerra/${ID}`), ID);
  assert.equal(parseJobId(ID), ID);
  assert.equal(parseJobId(`Job started\n${ID}\n`), ID);
  // Nothing id-shaped must never be mistaken for an id.
  assert.equal(parseJobId(''), null);
  assert.equal(parseJobId('Hint: pass --name to rename it'), null);
  assert.equal(parseJobId(undefined), null);
  assert.equal(parseJobId('id=short'), null);
});

// An unknown answer must never read as "running": that showed a finished run as
// in-progress, and would have blocked every later backup behind a job that no
// longer exists. Unrecognised stages count as finished, on purpose.
test('only known active stages count as running', () => {
  assert.equal(isActiveStage('RUNNING'), true);
  assert.equal(isActiveStage('SCHEDULING'), true);
  for (const s of ['COMPLETED', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED', 'DELETED',
                   'SOMETHING_NEW', '', null, undefined]) {
    assert.equal(isActiveStage(s), false, `${String(s)} must not count as running`);
  }
});

// The jobs link filters the Hub's job list by the label every run carries, so
// the name used to launch a Job and the name used to find it must not drift.
test('the jobs link filters by the same name the Job is launched with', () => {
  const args = jobArgs({ source: 'ns/src', mirror: '', dataset: 'ns/ds' });
  assert.equal(args[args.indexOf('--name') + 1], jobName());
  assert.equal(jobsUrl(), `https://huggingface.co/settings/jobs?label=name%3D${jobName()}`);
  // The label has to arrive encoded, or the Hub reads it as a second parameter.
  assert.ok(jobsUrl().includes('%3D'));
  assert.ok(!jobsUrl().includes('label=name='));
});

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
