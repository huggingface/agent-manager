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
// Pinned, not left to the default: the operator pays for this. cpu-basic is the
// cheapest tier ($0.0002/min) and the work is API calls and file hashing, so
// nothing here benefits from more machine. Pinning also means a change to the
// Hub's default flavour cannot silently make hourly backups more expensive.
export const JOB_FLAVOR = 'cpu-basic';

export const hasToken = () => !!(process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN);

// A bucket/dataset id arrives from PUT /api/config and ends up in a Job's
// argument list. Anything outside this charset is refused rather than escaped —
// there is no legitimate repo called `; rm -rf /`.
const ID_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
export const validRepoId = (s) => typeof s === 'string' && s.length <= 96 && ID_RE.test(s);

// Folders the operator does not want in the history: the slow, regenerable kind
// (`node_modules`, `.venv`, `env`) that turn one backup into thousands of file
// hashes. Measured on 805 files: 7s without, 1s with them excluded — and a real
// bucket's mount is slower than a local disk, so the saving is larger there.
//
// Tokens are folder names, or raw globs for anything finer. No whitespace and no
// shell metacharacters: these are joined into one env var and split apart again
// inside the Job, so the charset is what makes that split exact.
const EXCLUDE_RE = /^[A-Za-z0-9._*?/-]+$/;
export const MAX_EXCLUDES = 40;

export function normalizeExclude(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    // Leading and trailing slashes are noise: `/env/` and `env` mean the same.
    const t = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!t || t.length > 64 || !EXCLUDE_RE.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_EXCLUDES);
}

/**
 * Tokens -> `hf upload --exclude` globs.
 *
 * A bare name becomes TWO patterns, which is not obvious: `**\/env/**` does not
 * match a top-level `env/`, verified against the Hub — `**\/` needs at least one
 * leading segment. So excluding `env` needs `env/**` as well, or the copy at the
 * bucket root silently still goes up.
 *
 * A token with a slash is a path and anchors at the bucket root; one containing
 * `*` or `?` is already a glob and is passed through untouched.
 */
export function excludePatterns(tokens) {
  const pats = [];
  for (const t of normalizeExclude(tokens)) {
    if (t.includes('*') || t.includes('?')) pats.push(t);
    else if (t.includes('/')) pats.push(`${t}/**`);
    else pats.push(`${t}/**`, `**/${t}/**`);
  }
  return pats;
}

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

const HF = 'https://huggingface.co';

// Every run is launched with `--name am-backup-<space>`, which the Hub stores as
// a `name=` label. So one static URL lists this Space's backup runs — past,
// present and failed — and the row never has to track a job id to link to them.
export const jobName = () => `am-backup-${spaceName()}`.slice(0, 40);
export const jobsUrl = () =>
  `${HF}/settings/jobs?label=${encodeURIComponent(`name=${jobName()}`)}`;

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

# Folders the operator asked to skip, as one --exclude per pattern. read -ra
# splits on the spaces the server joined them with and nothing else: no globbing
# against the container's filesystem, and each pattern reaches hf as a single
# quoted argv element. Patterns are validated server-side to hold no whitespace,
# which is what makes this split exact.
EXCLUDE_ARGS=()
if [ -n "\${AM_EXCLUDE:-}" ]; then
  read -ra AM_EXCLUDE_PATS <<< "\$AM_EXCLUDE"
  for p in "\${AM_EXCLUDE_PATS[@]}"; do EXCLUDE_ARGS+=(--exclude "\$p"); done
  echo "skipping: \$AM_EXCLUDE"
fi

# 2. Version history, read from the bucket mounted read-only at /live — the
#    Hub's copy, not this Space's disk. Unchanged files transfer nothing and
#    produce no commit at all; --delete makes the newest commit match the bucket
#    while every earlier commit keeps deleted files recoverable — including
#    anything newly excluded, which drops out of the newest commit but stays
#    recoverable in the ones before it.
hf upload "\$AM_DATASET" /live . --repo-type dataset --private --delete "*" \\
  "\${EXCLUDE_ARGS[@]}" \\
  --commit-message "Bucket snapshot \$(date -u +%Y-%m-%dT%H:%MZ)"
`;

/**
 * The Job id out of `hf jobs run --detach` output, whatever shape it comes in.
 *
 * This is deliberately format-agnostic. The image installs huggingface_hub
 * unpinned, so the CLI here is not the CLI a dev machine has, and a version that
 * printed the id differently silently left us with `jobId: null` — which killed
 * overlap protection and made the status row report a stage it had invented.
 * Accepts `id=<id>`, a bare id on its own line, or one embedded in a job URL.
 */
export function parseJobId(out) {
  const text = String(out || '');
  const looksLikeId = (s) => /^[a-f0-9]{16,32}$/i.test(s || '');
  const tagged = text.match(/\bid=([A-Za-z0-9]+)/);
  if (tagged && looksLikeId(tagged[1])) return tagged[1];
  const fromUrl = text.match(/\/jobs\/[^\s/]+\/([A-Za-z0-9]+)/);
  if (fromUrl && looksLikeId(fromUrl[1])) return fromUrl[1];
  for (const line of text.split('\n').map((l) => l.trim()).reverse()) {
    const last = line.split(/\s+/).pop();
    if (looksLikeId(last)) return last;
  }
  return null;
}

// Job arguments, as an array (never a shell string). Exported for the tests:
// asserting on this is how we know a config value cannot reach a shell.
export function jobArgs({ source, mirror, dataset, exclude = [] }) {
  return [
    'jobs', 'run', '--detach',
    '--name', jobName(),
    '--secrets', 'HF_TOKEN',
    '-e', `AM_SOURCE=${source}`,
    '-e', `AM_MIRROR=${mirror || ''}`,
    '-e', `AM_DATASET=${dataset}`,
    // Space-joined: the tokens are validated to contain no whitespace, so the
    // Job can split them back apart exactly.
    '-e', `AM_EXCLUDE=${excludePatterns(exclude).join(' ')}`,
    // Read-only: a backup must not be able to write to what it is reading.
    '-v', `hf://buckets/${source}:/live:ro`,
    '--flavor', JOB_FLAVOR,
    '--timeout', JOB_TIMEOUT,
    JOB_IMAGE, 'bash', '-c', JOB_SCRIPT,
  ];
}

/**
 * Why an on-demand backup cannot run, or null if it can. Deliberately does NOT
 * consider the interval: "back up now" is exactly what you want before a risky
 * change, without committing to a schedule.
 */
export function runNowBlockedBy() {
  if (!hasToken()) return 'needs a write-scoped HF_TOKEN secret on the Space';
  if (!sourceBucket()) return 'no bucket is mounted on this Space';
  return null;
}

/**
 * Why the scheduled backup is not running, or null if it is live. Same reasons
 * as on-demand plus the interval, so the timer and the settings row can never
 * disagree about it.
 */
export function unavailableReason(cfg) {
  return runNowBlockedBy() || ((cfg?.backup?.every || 'never') === 'never' ? 'switched off' : null);
}

/** Resolve the destinations, falling back to <namespace>/<space>-backup. */
async function targets(cfg) {
  const d = await defaultsFor();
  const mirror = (cfg?.backup?.mirror || d.mirror || '').trim();
  const dataset = (cfg?.backup?.dataset || d.dataset || '').trim();
  return { mirror, dataset, defaults: d, exclude: normalizeExclude(cfg?.backup?.exclude) };
}

/** Launch one backup Job now. Returns { job } — the Hub does the rest. */
export async function runBackupNow(cfg) {
  const blocked = runNowBlockedBy();
  if (blocked) throw new Error(blocked);
  // Two runs at once would have two Jobs uploading to the same dataset, which
  // race. The timer skips for this reason too; on demand it is worth saying out
  // loud rather than silently doing nothing.
  if (await isRunning()) throw new Error('a backup is already running');
  const source = sourceBucket();
  const { mirror, dataset, exclude } = await targets(cfg);
  for (const [label, id] of [['source', source], ['dataset', dataset], ['mirror', mirror]]) {
    if (label === 'mirror' && !id) continue;
    if (!validRepoId(id)) throw new Error(`${label} "${id}" is not a valid repo id`);
  }
  // The mirror bucket must exist and be private before anything is copied into
  // it; the dataset is created private by the upload itself.
  if (mirror) await run(['buckets', 'create', mirror, '--private', '--exist-ok']).catch(() => {});

  const out = await run(jobArgs({ source, mirror, dataset, exclude }), { timeout: 180_000 });
  const job = parseJobId(out);
  // A launch we cannot identify still happened — record it, but say so, because
  // without an id there is nothing to poll and no overlap to detect.
  if (!job) console.warn('[backup] launched a Job but could not parse its id from:', out.slice(0, 200));
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

// Stages that mean a run is genuinely in flight. Observed from the Hub:
// SCHEDULING and RUNNING while live, COMPLETED or ERROR once finished.
//
// Deliberately a list of ACTIVE stages rather than terminal ones, so anything
// unrecognised — a new stage name, or `inspect` failing and returning nothing —
// counts as NOT running. Enumerating terminal stages had it the wrong way round:
// an unknown answer read as "running", which is the worse mistake twice over. It
// showed a run in progress that had long finished, and it would have blocked
// every future backup behind a job that no longer exists.
const ACTIVE = new Set(['SCHEDULING', 'RUNNING']);
export const isActiveStage = (stage) => !!stage && ACTIVE.has(stage);

/** Is the last launched Job still going? Unknown counts as finished, so a Hub
 *  hiccup can never wedge backups off forever. */
async function isRunning() {
  const { jobId } = loadState();
  if (!jobId) return false;
  return isActiveStage(await jobStage(jobId));
}

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
  if (await isRunning()) return { skipped: 'previous backup still running' };
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
  const { mirror, dataset, defaults, exclude } = await targets(cfg);
  // Not gated on the interval: an on-demand backup is a real backup, and its
  // result has to be visible even with the schedule off.
  const [stage, priv] = await Promise.all([
    state.jobId ? jobStage(state.jobId) : null,
    dataset && hasToken() ? datasetPrivate(dataset) : null,
  ]);
  return {
    every,
    source,
    mirror,
    dataset,
    defaults,
    hasToken: hasToken(),
    canRunNow: !runNowBlockedBy(),
    running: isActiveStage(stage),
    unavailable: unavailableReason(cfg),
    last: state.startedAt
      ? { at: state.startedAt, jobId: state.jobId || null, stage: stage || null }
      : null,
    jobName: jobName(),
    jobsUrl: jobsUrl(),
    // The tokens as stored, and the globs they become — a skip list nobody can
    // see the expansion of is a skip list nobody can debug.
    exclude,
    excludePatterns: excludePatterns(exclude),
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
