import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { visibility } from './visibility.js';
import { shareNamespace } from './share.js';

// Bucket backup: a periodic, Hub-side copy of this Space's bucket.
// Design and rationale: docs/bucket-backup.md (§3 verified behaviour, §5 pipeline).
//
// Two steps, neither of which runs here:
//
//   1. bucket → bucket, server-side by Xet hash. No bytes move (13,482 files in
//      20s, measured) and a restore from it is equally instant. Overwritten each
//      run — it is the "get the Space back" copy.
//   2. the same bucket, mounted READ-ONLY inside the Job, → a private dataset
//      repo. This is the version history a bucket cannot give: buckets are
//      mutable and non-versioned, so without this an overwritten file is simply
//      gone (§10.1).
//
// Both steps run in a SCHEDULED HF JOB, which is the whole point: the work
// happens on the Hub, so backups continue while this Space is asleep, cost it no
// I/O at all, and never touch the FUSE mount whose cold walk runs to minutes.
// This app has wedged once on synchronous work; a job that fires every hour
// should not be the next cause, and the safest way to achieve that is for the
// hour to not belong to us.
//
// Why a dataset for history and a bucket for the mirror, rather than one of
// them: bucket storage is accounted in logical bytes — two identical snapshots
// measured as exactly 2× — while a git repo stores each distinct blob once and
// skips empty commits entirely. So history is far cheaper in the dataset, and
// instant restore is only possible from the bucket (§9).

const STATE_FILE = path.join(DATA_DIR, 'backup-state.json');
const SPACE_ID = process.env.SPACE_ID || '';
const spaceName = () => SPACE_ID.split('/')[1] || 'agent-manager';

// 50 minutes: a run that hangs must die before the next hour fires, so a stuck
// backup can never stack up behind itself.
const JOB_TIMEOUT = '3000s';
const JOB_IMAGE = 'python:3.12';

export const CRON = {
  hour: '0 * * * *',
  '6h': '0 */6 * * *',
  day: '0 3 * * *', // small hours, when a bucket is least likely to be mid-write
};
export const cronFor = (every) => CRON[every] || null;

// A bucket/dataset id arrives from PUT /api/config and ends up in a Job's
// argument list. Anything outside this charset is refused rather than escaped —
// there is no legitimate repo called `; rm -rf /`.
const ID_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
export const validRepoId = (s) => typeof s === 'string' && s.length <= 96 && ID_RE.test(s);

function run(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('hf', args, { timeout, env: process.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        err.stdout = String(stdout || '');
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

// The bucket mounted at /data, as discovered by visibility.js from
// GET /api/spaces/{id} → runtime.volumes[]. AM_BACKUP_SOURCE overrides it for
// local runs, where there is no Space and so no volume to discover.
export function sourceBucket() {
  if (process.env.AM_BACKUP_SOURCE) return process.env.AM_BACKUP_SOURCE;
  const v = visibility();
  return (v.buckets && v.buckets[0]) || null;
}

export async function defaultsFor() {
  const ns = await shareNamespace().catch(() => '');
  if (!ns) return { mirror: '', dataset: '' };
  return { mirror: `${ns}/${spaceName()}-backup`, dataset: `${ns}/${spaceName()}-backup` };
}

// The script the Job runs. No interpolation: every value arrives as an env var
// (`-e`), so a config string can never become shell syntax.
export const JOB_SCRIPT = `set -euo pipefail
# Plain package, no [cli] extra: 1.26.0 dropped it ("does not provide the extra
# 'cli'") and ships the CLI in the base install. Asking for it only earns a
# warning in the run logs.
pip install -q huggingface_hub

# A backup carries every saved login on the bucket — agent OAuth tokens, the Web
# Push private key, session-secret (docs/bucket-backup.md §4). So a public
# destination is a stop, not a warning. Re-checked HERE, on every run, because a
# repo can be flipped public long after it was created.
python - <<'PY'
import os, sys
from huggingface_hub import HfApi
api = HfApi()
ds, mirror = os.environ["AM_DATASET"], os.environ.get("AM_MIRROR", "")
try:
    if api.dataset_info(ds).private is not True:
        sys.exit(f"refusing to back up: dataset {ds} is not private")
except Exception as e:
    # Not existing yet is fine — the upload below creates it private.
    if "404" not in str(e) and "RepositoryNotFound" not in type(e).__name__:
        raise
if mirror and api.bucket_info(mirror).private is not True:
    sys.exit(f"refusing to back up: bucket {mirror} is not private")
PY

# 1. Server-side mirror: hashes move, not bytes.
if [ -n "\${AM_MIRROR:-}" ]; then
  hf cp "hf://buckets/\$AM_SOURCE/" "hf://buckets/\$AM_MIRROR/latest/"
fi

# 2. Version history, read from the bucket mounted read-only at /live — the
#    Hub's copy, not any Space's disk. Unchanged files transfer nothing and
#    produce no commit; --delete mirrors removals into the new commit while the
#    previous commit keeps them recoverable.
hf upload "\$AM_DATASET" /live . --repo-type dataset --private --delete "*" \\
  --commit-message "Bucket snapshot \$(date -u +%Y-%m-%dT%H:%MZ)"
`;

// Job arguments, as an array (never a shell string). Exported for the tests:
// asserting on this is how we know a config value cannot reach a shell.
export function jobArgs({ source, mirror, dataset, cron = null, name }) {
  const spec = [
    '--secrets', 'HF_TOKEN',
    '-e', `AM_SOURCE=${source}`,
    '-e', `AM_MIRROR=${mirror || ''}`,
    '-e', `AM_DATASET=${dataset}`,
    '-v', `hf://buckets/${source}:/live:ro`,
    '--timeout', JOB_TIMEOUT,
    JOB_IMAGE, 'bash', '-c', JOB_SCRIPT,
  ];
  if (name) spec.unshift('--name', name);
  return cron
    ? ['jobs', 'scheduled', 'run', cron, ...spec]
    : ['jobs', 'run', '--detach', ...spec];
}

// What the config asks for, as one comparable string. If this changes, the
// schedule is replaced — there is no "update" verb for a scheduled Job, only
// run/delete, so a change means delete-then-create.
export const fingerprint = ({ cron, source, mirror, dataset }) =>
  [cron, source, mirror || '-', dataset].join('|');

export function reconcile(existing, desired) {
  if (!desired) return existing ? 'delete' : 'keep';
  if (!existing) return 'create';
  if (existing.fingerprint !== desired.fingerprint) return 'replace';
  if (existing.suspend) return 'replace';
  return 'keep';
}

async function listSchedules() {
  try { return JSON.parse(await run(['jobs', 'scheduled', 'ls', '--json'])) || []; } catch { return []; }
}

async function findSchedule(id) {
  if (!id) return null;
  return (await listSchedules()).find((s) => s.id === id) || null;
}

/**
 * Make the Hub match the operator's config: create, replace, or remove the
 * scheduled Job. Called on boot and after PUT /api/config. Never throws — a
 * backup that cannot be scheduled records why and leaves the app alone.
 */
export async function ensureSchedule(cfg) {
  const state = loadState();
  const every = cfg?.backup?.every || 'never';
  const cron = cronFor(every);
  const existing = await findSchedule(state.scheduledJobId);
  const existingRec = existing ? { fingerprint: state.fingerprint, suspend: !!existing.suspend } : null;

  if (!cron) {
    if (existing) await run(['jobs', 'scheduled', 'delete', existing.id]).catch(() => {});
    saveState({ ...state, scheduledJobId: null, fingerprint: null, every: 'never', error: null });
    return { action: existing ? 'deleted' : 'none' };
  }

  const source = sourceBucket();
  if (!source) {
    saveState({ ...state, error: 'no bucket is mounted on this Space — nothing to back up' });
    return { action: 'blocked', error: 'no bucket mounted' };
  }
  const d = await defaultsFor();
  const mirror = (cfg.backup.mirror || d.mirror || '').trim();
  const dataset = (cfg.backup.dataset || d.dataset || '').trim();
  for (const [label, id] of [['source', source], ['dataset', dataset], ['mirror', mirror]]) {
    if (label === 'mirror' && !id) continue;
    if (!validRepoId(id)) {
      const error = `refusing to schedule: ${label} "${id}" is not a valid repo id`;
      saveState({ ...state, error });
      return { action: 'blocked', error };
    }
  }

  const desired = { fingerprint: fingerprint({ cron, source, mirror, dataset }) };
  const action = reconcile(existingRec, desired);
  if (action === 'keep') return { action };

  // The mirror bucket has to exist and be private before anything is copied
  // into it. The dataset is created private by the upload itself.
  if (mirror) {
    await run(['buckets', 'create', mirror, '--private', '--exist-ok']).catch(() => {});
  }

  if (action === 'replace' && existing) {
    await run(['jobs', 'scheduled', 'delete', existing.id]).catch(() => {});
  }
  const name = `am-backup-${spaceName()}`.slice(0, 40);
  const out = await run(jobArgs({ source, mirror, dataset, cron, name }), { timeout: 180_000 });
  const id = (out.match(/id=(\S+)/) || [])[1] || null;
  saveState({
    ...state, scheduledJobId: id, fingerprint: desired.fingerprint,
    every, source, mirror, dataset, error: null, scheduledAt: new Date().toISOString(),
  });
  return { action, id };
}

/** Kick a backup now: trigger the schedule if there is one, else a one-off Job. */
export async function runBackupNow(cfg) {
  const state = loadState();
  if (state.scheduledJobId) {
    await run(['jobs', 'scheduled', 'trigger', state.scheduledJobId], { timeout: 120_000 });
    return { triggered: state.scheduledJobId };
  }
  const source = sourceBucket();
  if (!source) throw new Error('no bucket is mounted on this Space — nothing to back up');
  const d = await defaultsFor();
  const mirror = (cfg?.backup?.mirror || d.mirror || '').trim();
  const dataset = (cfg?.backup?.dataset || d.dataset || '').trim();
  if (!validRepoId(dataset)) throw new Error(`not a valid dataset id: ${dataset}`);
  if (mirror) await run(['buckets', 'create', mirror, '--private', '--exist-ok']).catch(() => {});
  const out = await run(jobArgs({ source, mirror, dataset }), { timeout: 180_000 });
  return { job: (out.match(/id=(\S+)/) || [])[1] || null };
}

/**
 * Status for the settings row. Reports the schedule as the HUB sees it, not as
 * we last left it — a backup nobody can verify the state of is a backup nobody
 * trusts, and the destination's privacy is the one thing that must be visible.
 */
export async function backupStatus(cfg) {
  const state = loadState();
  const every = cfg?.backup?.every || 'never';
  const source = sourceBucket();
  const d = await defaultsFor();
  const mirror = (cfg?.backup?.mirror || d.mirror || '').trim();
  const dataset = (cfg?.backup?.dataset || d.dataset || '').trim();
  const sched = await findSchedule(state.scheduledJobId);

  let priv = null;
  if (every !== 'never' && dataset) {
    priv = await datasetPrivate(dataset);
  }

  return {
    every,
    source,
    mirror,
    dataset,
    defaults: d,
    scheduled: sched
      ? { id: sched.id, cron: sched.schedule, suspended: !!sched.suspend,
          lastRun: sched.last_run && sched.last_run !== 'N/A' ? sched.last_run : null,
          nextRun: sched.next_run || null }
      : null,
    datasetPrivate: priv,   // null = unknown/not created yet
    error: state.error || null,
  };
}

// One small authed read; the settings row needs the CURRENT answer, because a
// repo holding credentials can be flipped public at any time.
async function datasetPrivate(dataset) {
  try {
    const out = await run(['datasets', 'info', dataset, '--json'], { timeout: 30_000 });
    const j = JSON.parse(out);
    return j.private === true;
  } catch (e) {
    if (/404|not found|RepositoryNotFound/i.test(e.stderr || e.message || '')) return null;
    return null;
  }
}
