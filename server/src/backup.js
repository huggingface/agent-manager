import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { visibility } from './visibility.js';
import { shareNamespace } from './share.js';

// Bucket backup: every 1h/3h/24h, launch one HF Job that copies this Space's
// bucket to private Hub storage. Design: docs/bucket-backup.md
//
// The whole feature is one loop: if it is switched on and enough time has
// passed, launch a Job. Nothing else. The Job does two things, because a mirror
// alone is not a backup:
//
//   1. bucket → bucket, server-side by Xet hash. No bytes move (13,482 files in
//      20s, measured) and a restore from it is equally instant. Overwritten each
//      run — this is the "get the Space back" copy.
//   2. the same bucket, mounted READ-ONLY in the Job, → a private dataset repo.
//      Buckets are mutable and non-versioned, so without this an overwritten
//      file is simply gone. This is the "get yesterday's file back" copy.
//
// The copying happens on the Hub, not here: we launch the Job and forget it. So
// a backup costs this Space one API call, never reads /data (whose cold walk runs
// to minutes), and cannot wedge the event loop that pumps the terminals.
//
// Requires HF_TOKEN in the environment — there is no way to launch a Job or write
// to the Hub without one, so with no token the feature reports itself
// unavailable rather than failing every hour in the logs.

const STATE_FILE = path.join(DATA_DIR, 'backup-state.json');
const SPACE_ID = process.env.SPACE_ID || '';
const spaceName = () => SPACE_ID.split('/')[1] || 'agent-manager';

export const EVERY_MS = {
  '1h': 3_600_000,
  '3h': 10_800_000,
  '24h': 86_400_000,
};
export const INTERVALS = ['never', ...Object.keys(EVERY_MS)];
export const intervalMs = (every) => EVERY_MS[every] || 0;

// How often we ask "is a backup due?". Cheap: reads a file, compares two numbers.
const TICK_MS = 300_000; // 5 min
// A Job that hangs must die well inside the shortest interval so runs cannot
// stack up behind each other.
const JOB_TIMEOUT = '3000s'; // 50 min
const JOB_IMAGE = 'python:3.12';

export const hasToken = () => !!(process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN);

// A bucket/dataset id arrives from PUT /api/config and ends up in a Job's
// argument list. Anything outside this charset is refused rather than escaped —
// there is no legitimate repo called `; rm -rf /`.
const ID_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
export const validRepoId = (s) => typeof s === 'string' && s.length <= 96 && ID_RE.test(s);

function run(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('hf', args, { timeout, env: process.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2)); } catch {}
  return next;
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
  const base = `${ns}/${spaceName()}-backup`;
  return { mirror: base, dataset: base };
}

// The script the Job runs. No interpolation: every value arrives as an env var
// (`-e`), so a config string can never become shell syntax.
export const JOB_SCRIPT = `set -euo pipefail
# Plain package, no [cli] extra: 1.26.0 dropped it ("does not provide the extra
# 'cli'") and ships the CLI in the base install.
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
#    Hub's copy, not this Space's disk. Unchanged files transfer nothing and
#    produce no commit at all; --delete makes the newest commit match the bucket
#    while every earlier commit keeps deleted files recoverable.
hf upload "\$AM_DATASET" /live . --repo-type dataset --private --delete "*" \\
  --commit-message "Bucket snapshot \$(date -u +%Y-%m-%dT%H:%MZ)"
`;

// Job arguments, as an array (never a shell string). Exported for the tests:
// asserting on this is how we know a config value cannot reach a shell.
export function jobArgs({ source, mirror, dataset }) {
  return [
    'jobs', 'run', '--detach',
    '--name', `am-backup-${spaceName()}`.slice(0, 40),
    '--secrets', 'HF_TOKEN',
    '-e', `AM_SOURCE=${source}`,
    '-e', `AM_MIRROR=${mirror || ''}`,
    '-e', `AM_DATASET=${dataset}`,
    // Read-only: a backup must not be able to write to what it is reading.
    '-v', `hf://buckets/${source}:/live:ro`,
    '--timeout', JOB_TIMEOUT,
    JOB_IMAGE, 'bash', '-c', JOB_SCRIPT,
  ];
}

/**
 * Why a backup cannot run right now, or null if it can. One place, so the timer
 * and the settings row always agree about it.
 */
export function unavailableReason(cfg) {
  if (!hasToken()) return 'needs a write-scoped HF_TOKEN secret on the Space';
  if (!sourceBucket()) return 'no bucket is mounted on this Space';
  if ((cfg?.backup?.every || 'never') === 'never') return 'switched off';
  return null;
}

/** Resolve the destinations, falling back to <namespace>/<space>-backup. */
async function targets(cfg) {
  const d = await defaultsFor();
  const mirror = (cfg?.backup?.mirror || d.mirror || '').trim();
  const dataset = (cfg?.backup?.dataset || d.dataset || '').trim();
  return { mirror, dataset, defaults: d };
}

/** Launch one backup Job now. Returns { job } — the Hub does the rest. */
export async function runBackupNow(cfg) {
  if (!hasToken()) throw new Error('needs a write-scoped HF_TOKEN secret on the Space');
  const source = sourceBucket();
  if (!source) throw new Error('no bucket is mounted on this Space — nothing to back up');
  const { mirror, dataset } = await targets(cfg);
  for (const [label, id] of [['source', source], ['dataset', dataset], ['mirror', mirror]]) {
    if (label === 'mirror' && !id) continue;
    if (!validRepoId(id)) throw new Error(`${label} "${id}" is not a valid repo id`);
  }
  // The mirror bucket must exist and be private before anything is copied into
  // it; the dataset is created private by the upload itself.
  if (mirror) await run(['buckets', 'create', mirror, '--private', '--exist-ok']).catch(() => {});

  const out = await run(jobArgs({ source, mirror, dataset }), { timeout: 180_000 });
  const job = (out.match(/id=(\S+)/) || [])[1] || null;
  saveState({ jobId: job, startedAt: Date.now(), source, mirror, dataset, error: null });
  return { job };
}

/** Terminal state of the last launched Job, or null while it is still going. */
async function jobStage(jobId) {
  if (!jobId) return null;
  try {
    const j = JSON.parse(await run(['jobs', 'inspect', jobId, '--json'], { timeout: 30_000 }));
    const s = Array.isArray(j) ? j[0] : j;
    return (s && s.status && s.status.stage) || null;
  } catch { return null; }
}

const DONE = new Set(['COMPLETED', 'ERROR', 'FAILED', 'CANCELED']);

/**
 * One tick: launch a backup if one is due. Deliberately dumb — no cron, no
 * catch-up queue. "Due" is just "the last one started more than an interval
 * ago", which behaves correctly across restarts because it is derived from the
 * timestamp on disk rather than from an in-memory schedule.
 */
export async function tick(cfg) {
  if (unavailableReason(cfg)) return { skipped: unavailableReason(cfg) };
  const state = loadState();
  const due = Date.now() - (state.startedAt || 0) >= intervalMs(cfg.backup.every);
  if (!due) return { skipped: 'not due' };

  // Never let two runs overlap: a big first backup can outlast an interval.
  if (state.jobId && !DONE.has(await jobStage(state.jobId))) {
    return { skipped: 'previous backup still running' };
  }
  try {
    const r = await runBackupNow(cfg);
    console.log(`[backup] launched job ${r.job} (every ${cfg.backup.every})`);
    return r;
  } catch (e) {
    const error = e.stderr || e.message;
    saveState({ error, erroredAt: Date.now() });
    console.warn('[backup] launch failed:', error);
    return { error };
  }
}

/**
 * Start the loop. One unref'd timer that asks every 5 minutes whether a backup
 * is due; the config is re-read each time, so switching the interval takes
 * effect without restarting anything.
 */
export function startBackupTimer(getConfig) {
  const t = setInterval(() => { tick(getConfig()).catch(() => {}); }, TICK_MS);
  if (t.unref) t.unref();
  // First check shortly after boot, once bucket discovery has landed.
  const first = setTimeout(() => { tick(getConfig()).catch(() => {}); }, 30_000);
  if (first.unref) first.unref();
  return () => { clearInterval(t); clearTimeout(first); };
}

/**
 * Status for the settings row. A backup nobody can see the state of is a backup
 * nobody trusts — and the destination's privacy is the one thing that must be
 * visible, so it is re-read here rather than remembered.
 */
export async function backupStatus(cfg) {
  const state = loadState();
  const every = cfg?.backup?.every || 'never';
  const source = sourceBucket();
  const { mirror, dataset, defaults } = await targets(cfg);
  const [stage, priv] = await Promise.all([
    every === 'never' ? null : jobStage(state.jobId),
    every === 'never' || !dataset ? null : datasetPrivate(dataset),
  ]);
  return {
    every,
    source,
    mirror,
    dataset,
    defaults,
    hasToken: hasToken(),
    unavailable: unavailableReason(cfg),
    last: state.startedAt
      ? { at: state.startedAt, jobId: state.jobId || null, stage: stage || 'RUNNING' }
      : null,
    nextDue: state.startedAt && intervalMs(every) ? state.startedAt + intervalMs(every) : null,
    datasetPrivate: priv, // null = unknown or not created yet
    error: state.error || null,
  };
}

// One small authed read: the settings row needs the CURRENT answer, because a
// repo holding credentials can be flipped public at any time.
async function datasetPrivate(dataset) {
  if (!validRepoId(dataset)) return null;
  try {
    const j = JSON.parse(await run(['datasets', 'info', dataset, '--json'], { timeout: 30_000 }));
    return j.private === true;
  } catch { return null; }
}
