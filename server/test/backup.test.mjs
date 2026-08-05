import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVERY_MS, INTERVALS, intervalMs, validRepoId, jobArgs, JOB_SCRIPT, JOB_FLAVOR,
  hasToken, unavailableReason, runNowBlockedBy, jobName, jobsUrl, isActiveStage, parseJobId,
  normalizeExclude, MAX_EXCLUDES, DEFAULT_EXCLUDE, excludeFromConfig,
} from '../src/backup.js';

// The rule that is not obvious and cost a Hub round-trip to learn: `**/x/**` does
// NOT match a top-level `x/`, so a bare folder token needs BOTH patterns. Verified
// against the Hub — with only the `**/` form, the copy at the bucket root still
// went up.
test('a config that never set a skip list gets the default, an emptied one stays empty', () => {
  // The whole point of the split: `undefined` is "never asked", `[]` is a choice.
  assert.deepEqual(excludeFromConfig(undefined), [...DEFAULT_EXCLUDE]);
  assert.deepEqual(excludeFromConfig(null), [...DEFAULT_EXCLUDE]);
  // An emptied list must NOT refill itself, or clearing the field in Settings
  // would come back on the next read and the operator could never turn it off.
  assert.deepEqual(excludeFromConfig([]), []);
  // A set list is passed through the same validation as anything else.
  assert.deepEqual(excludeFromConfig(['  env  ', '/env/']), ['env']);
  assert.deepEqual(excludeFromConfig(['a', 'rm -rf /']), ['a']);
  // Junk in the config file falls back to nothing rather than to the default:
  // it IS a set value, just not a usable one.
  assert.deepEqual(excludeFromConfig('node_modules'), []);
});

test('the default skip list is caches only — never .git, never ambiguous build dirs', () => {
  // .git is the most common folder in the bucket and the one most worth keeping.
  // A size-ranked heuristic would pick it first, so pin it explicitly.
  for (const keep of ['.git', 'dist', 'build', 'target', 'src', 'data', '.config', '.ssh']) {
    assert.ok(!DEFAULT_EXCLUDE.includes(keep), `${keep} must not be skipped by default`);
  }
  // The names actually found in this Space's bucket are covered.
  for (const junk of ['node_modules', '.venv', '__pycache__', '.cache', '.npm/_cacache']) {
    assert.ok(DEFAULT_EXCLUDE.includes(junk), `${junk} should be skipped by default`);
  }
  // Every default has to survive the validator it will be fed through, fit the
  // cap, and be unique — a default that silently drops would be invisible.
  assert.deepEqual(normalizeExclude([...DEFAULT_EXCLUDE]), [...DEFAULT_EXCLUDE]);
  assert.ok(DEFAULT_EXCLUDE.length <= MAX_EXCLUDES);
  assert.equal(new Set(DEFAULT_EXCLUDE).size, DEFAULT_EXCLUDE.length);
  // Frozen: it is handed out by reference-copy, and a caller mutating the
  // module's own array would poison every later read.
  assert.throws(() => DEFAULT_EXCLUDE.push('dist'));
  excludeFromConfig(undefined).push('dist');
  assert.ok(!DEFAULT_EXCLUDE.includes('dist'));
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
  const args = jobArgs({ source: 'ns/src', dataset: 'ns/ds', staging: 'ns/snap' });
  assert.ok(args.includes('AM_SOURCE=ns/src'));
  assert.ok(args.includes('AM_STAGING=ns/snap'));
  assert.ok(args.includes('AM_DATASET=ns/ds'));
  const script = args[args.length - 1];
  assert.equal(script, JOB_SCRIPT);
  for (const id of ['ns/src', 'ns/snap', 'ns/ds']) {
    assert.ok(!script.includes(id), 'ids must not be interpolated into the script');
  }
});

// The bucket used to be mounted read-only so a backup could not write to what it
// was reading. Nothing is mounted now, which is the stronger version of the same
// property — and it is why a run no longer pays 8 ms per file to walk it.
test('nothing is mounted, so a backup cannot touch the source at all', () => {
  const args = jobArgs({ source: 'ns/src', dataset: 'ns/ds', staging: 'ns/snap' });
  assert.equal(args.indexOf('-v'), -1);
  assert.ok(!args.some((a) => typeof a === 'string' && a.includes('/live')));
  assert.ok(!JOB_SCRIPT.includes('/live'));
});

test('a backup is one detached job launch', () => {
  const args = jobArgs({ source: 'ns/src', dataset: 'ns/ds', staging: 'ns/snap' });
  assert.deepEqual(args.slice(0, 3), ['jobs', 'run', '--detach']);
  assert.ok(args.includes('--secrets') && args.includes('HF_TOKEN'));
});

// The upload has to create the dataset private and re-verify privacy every run:
// the copy carries live agent credentials (docs/bucket-backup.md §4).
test('the job script gates on privacy and states it when creating', () => {
  assert.match(JOB_SCRIPT, /private=True/);
  assert.match(JOB_SCRIPT, /refusing to back up/);
  assert.match(JOB_SCRIPT, /dataset_info/);
  assert.match(JOB_SCRIPT, /bucket_info/);
  assert.match(JOB_SCRIPT, /set -euo pipefail/);
  // The source is gated too: reading a public bucket into a dataset is still a
  // copy of something that should not have been readable.
  assert.ok(JOB_SCRIPT.includes('must_be_private("bucket", SRC)'));
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

// ---------------------------------------------------------------------------
// The pipeline: what the Job is asked to do, and what it must refuse.
// ---------------------------------------------------------------------------

test('the Job gets tokens, a staging bucket, and no mount', () => {
  const args = jobArgs({ source: 'ns/src', dataset: 'ns/ds', staging: 'ns/snap', exclude: ['node_modules', '.cache'] });
  assert.ok(args.includes('-e'));
  assert.ok(args.includes('AM_STAGING=ns/snap'));
  assert.ok(args.includes('AM_DATASET=ns/ds'));
  // Tokens, not globs: the Job matches them against the API listing itself.
  assert.ok(args.includes('AM_EXCLUDE=node_modules .cache'));
  // Nothing is mounted any more — the mount is the thing that cost 14m51s.
  assert.equal(args.filter((a) => a === '-v').length, 0);
  assert.ok(!args.some((a) => typeof a === 'string' && a.includes(':/live')));
  // And no config value is ever spliced into a shell string.
  assert.equal(args.at(-3), 'bash');
  assert.equal(args.at(-2), '-c');
  assert.equal(args.at(-1), JOB_SCRIPT);
});

test('no mirror survives anywhere in the launch', () => {
  const args = jobArgs({ source: 'ns/src', dataset: 'ns/ds', staging: 'ns/snap' });
  assert.ok(!args.some((a) => typeof a === 'string' && a.includes('AM_MIRROR')));
  assert.ok(!JOB_SCRIPT.includes('AM_MIRROR'));
});

test('every destination is created explicitly private, then re-read', () => {
  // The bug this replaces: a comment claiming `hf upload` creates a repo private.
  // It creates it PUBLIC, so the assertion has to be in the code, not a comment.
  assert.ok(JOB_SCRIPT.includes('private=True'), 'creates must state visibility');
  assert.ok(!/creates it private/.test(JOB_SCRIPT), 'the wrong comment must be gone');
  for (const rid of ['SRC', 'DATASET', 'STAGING']) {
    assert.ok(JOB_SCRIPT.includes(`must_be_private("bucket", ${rid})`)
      || JOB_SCRIPT.includes(`must_be_private("dataset", ${rid})`), `${rid} is gated`);
  }
  assert.ok(JOB_SCRIPT.includes('is not private'), 'a non-private destination stops the run');
});

test('the staging bucket is always torn down', () => {
  // A staging bucket left behind is a second full copy of the operator's data.
  assert.ok(JOB_SCRIPT.includes('delete_bucket(STAGING)'));
  assert.ok(/finally:\s*\n\s*cleanup\(\)/.test(JOB_SCRIPT), 'cleanup runs even on a crash');
});

test('the commit is gated on a scrub that verified itself', () => {
  assert.ok(JOB_SCRIPT.includes('refusing to commit: secrets still present'));
  // The verify must come before the commit, or it proves nothing.
  assert.ok(JOB_SCRIPT.indexOf('secrets still present') < JOB_SCRIPT.indexOf('upload_folder'));
  // Tight patterns: a loose one rewrote ordinary prose containing "sk-".
  assert.ok(JOB_SCRIPT.includes('(?<![A-Za-z0-9_-])'), 'secret patterns are boundary-anchored');
  assert.ok(!JOB_SCRIPT.includes('sk-(?:proj-)?[A-Za-z0-9_-]{24,}'), 'the loose pattern is gone');
});

test('credential files are matched by exact name, not substring', () => {
  // "/credentials" is not a substring of "/.credentials.json" — that gap put a
  // credentials file into a probe commit.
  assert.ok(JOB_SCRIPT.includes('CRED_NAMES'));
  assert.ok(JOB_SCRIPT.includes('.credentials.json'));
  assert.ok(JOB_SCRIPT.includes('rsplit("/", 1)[-1] in CRED_NAMES'));
});

test('an empty scope refuses rather than committing nothing', () => {
  assert.ok(JOB_SCRIPT.includes('the scope matched no files'));
});

// ---------------------------------------------------------------------------
// The default skip list: reproducibility is the only criterion.
// ---------------------------------------------------------------------------

test('defaults skip only what a command can put back', () => {
  for (const t of ['node_modules', '.venv', '.cache', '__pycache__', '.lake/packages',
                   '.elan/toolchains', '.npm/_cacache', '.tmp']) {
    assert.ok(DEFAULT_EXCLUDE.includes(t), `${t} should be skipped by default`);
  }
});

test('defaults never drop work: no .git, no worktrees, no size rule', () => {
  // .git holds unpushed commits and staged changes: they exist nowhere else.
  assert.ok(!DEFAULT_EXCLUDE.includes('.git'));
  assert.ok(!DEFAULT_EXCLUDE.some((t) => t.includes('.git')));
  // Ambiguous build names stay opt-in — a source folder is called `build` often.
  for (const t of ['dist', 'build', 'target']) assert.ok(!DEFAULT_EXCLUDE.includes(t));
  // And nothing anywhere decides by file size.
  assert.ok(!/size\s*>/.test(JOB_SCRIPT), 'no size threshold in the pipeline');
  assert.ok(!JOB_SCRIPT.includes('CAP'), 'no size cap survives');
});

test('restore-defaults has something to restore to, and knows when it does not', async () => {
  // excludeIsDefault is what hides the button when pressing it would do nothing.
  const trimmed = normalizeExclude(DEFAULT_EXCLUDE.slice(0, 3));
  assert.notDeepEqual(trimmed, [...DEFAULT_EXCLUDE]);
  assert.deepEqual(excludeFromConfig(undefined), [...DEFAULT_EXCLUDE]);
  assert.deepEqual(excludeFromConfig([]), [], 'an emptied list stays empty');
});
