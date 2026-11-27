import { ApiError } from './api-errors.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { mountedBuckets } from './visibility.js';
import { shareNamespace } from './share.js';

// Bucket backup: every 1h/3h/24h, launch one HF Job that copies this Space's
// bucket to private Hub storage. Design: docs/bucket-backup.md
//
// The whole feature is one loop: if it is switched on and enough time has
// passed, launch a Job. Nothing else. The Job builds one versioned snapshot:
//
//   1. list the bucket over the API — 8 s for 108,960 files, against 14m51s to
//      stat the same tree through a FUSE mount (§3.11).
//   2. decide the scope in code, then copy just those paths server-side by Xet
//      hash into a private, EPHEMERAL staging bucket. Metadata only, no bytes.
//      Being frozen is what makes a run self-consistent: the live bucket is
//      written while we work.
//   3. download the snapshot to the Job's local disk, scrub secrets, verify none
//      remain, commit to a private dataset repo, delete the staging bucket.
//
// There is no persistent mirror. It cost a second full copy of the bucket, never
// deleted anything (so it archived every credential the Space ever held), and the
// restore it offered — "the Space exactly as it was, latest only" — is what the
// bucket itself already is.
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
// Tokens are matched as path segments, not globs. No whitespace and no
// shell metacharacters: these are joined into one env var and split apart again
// inside the Job, so the charset is what makes that split exact.
const EXCLUDE_RE = /^[A-Za-z0-9._*?/-]+$/;
export const MAX_EXCLUDES = 40;

/**
 * What a fresh install skips until the operator says otherwise.
 *
 * Most entries are caches or dependencies that a command can put back. Chrome
 * crash dumps are also excluded because they can contain process credentials.
 * Nothing is excluded for being large — a 292 MB session transcript is the
 * most history-shaped thing on the bucket, and an earlier draft of this list
 * dropped it to a per-file size cap, which was wrong.
 *
 * Measured against this Space's own bucket (110,590 files / 11.82 GB):
 * excluding only the names below drops 86,615 files and 8.05 GB, leaving 23,975
 * files and 3.78 GB. The heavy hitters were `node_modules` (25,184 files),
 * `.cache` (11,319), `.tmp` (10,151), `.lake/packages` (9,606, 0.65 GB),
 * `.elan/toolchains` (13,904, 2.75 GB) and `.npm/_cacache` (1.03 GB).
 *
 * Deliberately NOT here:
 *   - git worktrees as a class. A clone looks reproducible from its remote, but
 *     uncommitted work in it is not.
 *   - `dist` / `build` / `target` — genuinely ambiguous names for a source
 *     folder. A default that silently drops work is worse than one that copies
 *     some junk. Add them per-install.
 */
export const DEFAULT_EXCLUDE = Object.freeze([
  // dependency trees
  'node_modules', '.venv', 'venv', 'site-packages', '.lake/packages', '.pnpm-store',
  // caches, by manager
  '.cache', 'cache/huggingface', '.npm/_cacache', '.npm/_npx', '.yarn/cache', '.cargo/registry', 'pkg/mod',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.ipynb_checkpoints',
  '.gradle/caches', '.m2/repository', '.deno', '.bun/install/cache', '.turbo', '.next',
  // toolchains an installer re-fetches
  '.elan/toolchains', '.rustup/toolchains', '.nvm/versions', '.pyenv/versions',
  // Chrome crash dumps can contain process credentials
  '.config/google-chrome-for-testing',
  // scratch
  '.tmp', '.elan/tmp', '.lake/build',
]);

/**
 * The stored value, or the default when the operator has never set one.
 *
 * An absent key and an empty list are NOT the same: `undefined` means "never
 * asked", which takes the default, while `[]` is a list the operator emptied on
 * purpose and must stay empty — otherwise clearing the field in Settings would
 * silently refill itself on the next read.
 */
export function excludeFromConfig(saved) {
  if (saved === undefined || saved === null) return [...DEFAULT_EXCLUDE];
  return normalizeExclude(saved);
}

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
  return mountedBuckets()[0] || null;
}

export async function defaultsFor() {
  const ns = await shareNamespace().catch(() => '');
  if (!ns) return { dataset: '', staging: '' };
  return {
    dataset: `${ns}/${spaceName()}-backup`,
    // Ephemeral: deleted and created private at the start, deleted again at the end.
    // A distinct name from the dataset so a half-finished run can never be
    // confused with the history, and so an operator's existing mirror bucket is
    // never written to by the new pipeline.
    staging: `${ns}/${spaceName()}-snapshot`,
  };
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
# Plain package, no [cli] extra: 1.26.0 dropped it and ships the CLI in the base
# install. hf_xet speeds up the one leg that actually moves bytes.
if ! pip install -q "huggingface_hub[hf_xet]" 2>&1 | sed -uE 's/(hf_|api_org_)[A-Za-z0-9]{20,}/\\1[REDACTED]/g'; then
    echo "refusing to back up: step=install type=InstallError status=unknown request_id=unknown"
    exit 1
fi

python - <<'EOPY' 2>&1 | sed -uE 's/(hf_|api_org_)[A-Za-z0-9]{20,}/\\1[REDACTED]/g'
import os, re, sys, time, collections, logging
# Keep unhandled errors useful without printing response bodies or tracebacks.
STEP = "initialization"
def error_facts(e):
    cls = type(e).__name__
    cls = cls if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", cls) else "Error"
    status = getattr(getattr(e, "response", None), "status_code", None)
    status = str(status) if isinstance(status, int) and 100 <= status <= 599 else "unknown"
    request_id = getattr(e, "request_id", None)
    request_id = request_id if isinstance(request_id, str) and re.fullmatch(r"(?:[a-fA-F0-9-]{8,64}|Root=1-[a-fA-F0-9]{8}-[a-fA-F0-9]{24}(?:;[a-fA-F0-9-]{8,64})?)", request_id) else "unknown"
    return "type=" + cls + " status=" + status + " request_id=" + request_id

def safe_exception(exc_type, exc, tb):
    sys.stderr.write("refusing to back up: step=" + STEP + " " + error_facts(exc) + "\\n")
sys.excepthook = safe_exception
from huggingface_hub import HfApi

logging.getLogger("huggingface_hub").setLevel(logging.CRITICAL)
api = HfApi()
SRC = os.environ["AM_SOURCE"]
DATASET = os.environ["AM_DATASET"]
STAGING = os.environ["AM_STAGING"]
# Folder-name tokens, space-joined. Matched here rather than handed to an
# uploader: an uploader enumerates the folder first and filters second, which
# pays exactly the walk this pipeline exists to avoid.
EXCLUDE = [t for t in os.environ.get("AM_EXCLUDE", "").split(" ") if t]
WORK = "/work"

def say(m): print(m, flush=True)

# ---------------------------------------------------------------- privacy gate
# A backup carries every saved login on the bucket (docs/bucket-backup.md §4), so
# a public destination is a stop, not a warning. Re-checked HERE on every run,
# because a repo can be flipped public long after it was created.
#
# Never inferred from a default: create_bucket() with no private= yields a PUBLIC
# bucket, and hf upload into a repo that does not exist creates it PUBLIC. Both
# verified against the Hub (§3.12). So every destination is created explicitly
# private and then read back before a single byte is written.
def must_be_private(kind, rid):
    info = api.bucket_info(rid) if kind == "bucket" else api.dataset_info(rid)
    if getattr(info, "private", None) is not True:
        sys.exit("refusing to back up: " + kind + " " + rid + " is not private")

if STAGING.lower() == SRC.lower():
    sys.exit("refusing to back up: staging bucket is the source bucket")
STEP = "privacy"
must_be_private("bucket", SRC)
api.create_repo(DATASET, repo_type="dataset", private=True, exist_ok=True)
must_be_private("dataset", DATASET)
STEP = "staging"
api.delete_bucket(STAGING, missing_ok=True)
api.create_bucket(STAGING, private=True, exist_ok=True)
must_be_private("bucket", STAGING)
say("destinations verified private: " + DATASET + ", " + STAGING)

def cleanup():
    # Left behind, staging is a second full copy of the bucket, so failing to
    # remove it is loud rather than silent.
    try:
        api.delete_bucket(STAGING)
        say("staging bucket deleted: " + STAGING)
    except Exception:
        say("WARNING could not delete staging bucket " + STAGING)

try:
    # ------------------------------------------------------------------ 1. list
    # Over the API, never a mount. The mount costs ~8 ms per file: a stat-only
    # walk of this bucket took 14m51s for 108,960 files; the same tree lists in
    # 8 s here. That gap is the whole reason for this rewrite.
    STEP = "list"
    t = time.time()
    entries = [f for f in api.list_bucket_tree(SRC, recursive=True) if hasattr(f, "size")]
    say("listed " + str(len(entries)) + " files in " + format(time.time() - t, ".1f") + "s")

    # ------------------------------------------------------------- 2. the scope
    def excluded(path):
        q = "/" + path + "/"
        return any(("/" + t.strip("/") + "/") in q for t in EXCLUDE)

    # Files that exist to hold credentials, matched on the exact final path
    # segment rather than as a substring: a substring test for "/credentials"
    # sails straight past "/.credentials.json", which is how one got into a probe
    # commit before the scrub existed.
    CRED_NAMES = {
        ".credentials.json", ".claude.json", "credentials.json", "auth.json",
        "hosts.yml", "token", "stored_tokens", ".netrc", ".env", ".env.local",
        "id_rsa", "id_ed25519", "credentials",
    }
    CRED_DIRS = ("/shell_snapshots/", "/Crash Reports/", "/Crashpad/")

    def is_credential(path):
        if any(d in "/" + path for d in CRED_DIRS):
            return True
        return path.rsplit("/", 1)[-1] in CRED_NAMES

    keep = []
    git_dirs = set()
    n_excl = n_cred = n_nohash = 0
    for f in entries:
        parts = f.path.split("/")
        if excluded(f.path):
            n_excl += 1
        elif ".git" in parts:
            git_dirs.add("/".join(parts[:parts.index(".git") + 1]))
        elif is_credential(f.path):
            n_cred += 1
        elif not f.xet_hash:
            n_nohash += 1
        else:
            keep.append(f)
    kb = sum((f.size or 0) for f in keep)
    say("scope: keeping " + str(len(keep)) + " files (" + format(kb / 1e9, ".2f") + " GB); skipped "
        + str(n_excl) + " reproducible, " + str(n_cred) + " credential-bearing, "
        + str(n_nohash) + " without a hash")
    say("scope: skipped " + str(len(git_dirs)) + " .git folders; push or use git bundle for local-only work")
    if not keep:
        sys.exit("refusing to commit: the scope matched no files")

    # -------------------------------------------------- 3. frozen snapshot copy
    # Server-side, by xet hash: metadata only, no bytes, ~880 files/s measured.
    # The snapshot is also what makes a run self-consistent. The live bucket is
    # written while we work, and reading it directly used to die with "not a file
    # on the local file system" when the Space rotated a file away mid-run.
    STEP = "snapshot"
    t = time.time()
    for i in range(0, len(keep), 2000):
        api.batch_bucket_files(
            STAGING,
            copy=[("bucket", SRC, f.xet_hash, f.path) for f in keep[i:i + 2000]],
        )
    say("snapshot: " + str(len(keep)) + " paths copied server-side in " + format(time.time() - t, ".0f") + "s")

    # ------------------------------------------------------------ 4. sync local
    # Local disk, so the walk before the commit is free: 0.14 s for 39,873 files
    # against 14m51s for the same work on the mount.
    STEP = "sync"
    os.makedirs(WORK, exist_ok=True)
    t = time.time()
    api.sync_bucket("hf://buckets/" + STAGING, WORK)
    downloaded = {os.path.relpath(os.path.join(root, fn), WORK)
                  for root, _, files in os.walk(WORK) for fn in files}
    if downloaded - {f.path for f in keep}:
        sys.exit("refusing to commit: staging contained unexpected files")
    got = len(downloaded)
    say("downloaded " + str(got) + " files in " + format(time.time() - t, ".0f") + "s")

    # ---------------------------------------------------------------- 5. scrub
    # Tight patterns on purpose: a looser sk-[A-Za-z0-9_-]{24,} matched
    # "sk-abstraction-and-chart-selection" in ordinary prose, and a scrub that
    # rewrites real content is worse than one that over-reports.
    STEP = "scrub"
    AFT = "(?![A-Za-z0-9_-])"
    SECRETS = [
        ("hf", re.compile(("hf_(?<![A-Za-z0-9_-]hf_)[A-Za-z0-9]{34}" + AFT).encode())),
        ("openai", re.compile(("sk-(?<![A-Za-z0-9_-]sk-)(?:proj-)?[A-Za-z0-9]{20,}" + AFT).encode())),
        ("anthropic", re.compile(("sk-ant-(?<![A-Za-z0-9_-]sk-ant-)[A-Za-z0-9_-]{24,}" + AFT).encode())),
        ("github", re.compile(("gh(?<![A-Za-z0-9_-]gh)[pousr]_[A-Za-z0-9]{36}" + AFT).encode())),
        ("aws", re.compile(("AKIA(?<![A-Za-z0-9_-]AKIA)[0-9A-Z]{16}" + AFT).encode())),
        ("google", re.compile(("AIza(?<![A-Za-z0-9_-]AIza)[0-9A-Za-z_-]{35}" + AFT).encode())),
    ]
    def safe_path(path):
        if any(rx.search(path.encode()) for _, rx in SECRETS):
            return "[path withheld]"
        return ascii(path)[1:-1]
    def allfiles():
        for root, _, fs in os.walk(WORK):
            for fn in fs:
                fp = os.path.join(root, fn)
                with open(fp, "rb") as source:
                    yield fp, source.read()

    hits = collections.Counter()
    touched = 0
    t = time.time()
    for fp, data in allfiles():
        orig = data
        for name, rx in SECRETS:
            data, k = rx.subn(lambda m: b"[REDACTED-SECRET]" + b"#" * (len(m.group()) - len(b"[REDACTED-SECRET]")), data)
            if k:
                hits[name] += k
        if data != orig:
            open(fp, "wb").write(data)
            touched += 1
            say("scrub: altered " + safe_path(os.path.relpath(fp, WORK)))
    say("scrub: redacted " + str(sum(hits.values())) + " secrets in " + str(touched)
        + " files " + str(dict(hits)) + " in " + format(time.time() - t, ".0f") + "s")

    # --------------------------------------------------------------- 6. verify
    # Mandatory, not a nicety. The Hub's scanner is TruffleHog and it verifies a
    # find by authenticating with it, which INVALIDATES a live token. A commit
    # that leaks one does not merely fail: it breaks the operator's credentials.
    STEP = "verify"
    left = sum(1 for _, d in allfiles() if any(rx.search(d) for _, rx in SECRETS))
    if left:
        sys.exit("refusing to commit: secrets still present in " + str(left) + " files")
    say("verified: no secret patterns remain")

    # --------------------------------------------------------------- 7. commit
    # delete_patterns makes the newest commit match the scope, while every
    # earlier commit keeps since-removed files recoverable.
    STEP = "commit"
    t = time.time()
    try:
        api.upload_folder(
            folder_path=WORK, repo_id=DATASET, repo_type="dataset", delete_patterns="*",
            commit_message="Bucket snapshot " + time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
        )
    except Exception as e:
        # Only paths already in the snapshot can be reported. Never echo the
        # exception: Hub secret-scan errors include the actual token values.
        message = str(e)
        matches = []
        for f in keep:
            # A path must be bounded by quotes, whitespace or line ends; a
            # substring of another path or URL is not an offending path.
            boundary = " "+chr(9)+chr(10)+chr(13)+chr(34)+chr(39)
            i = message.find(f.path)
            while i >= 0:
                end = i + len(f.path)
                if (i == 0 or message[i - 1] in boundary) and (end == len(message) or message[end] in boundary):
                    if not any(rx.search(f.path.encode()) for _, rx in SECRETS):
                        matches.append((i, f.path))
                    break
                i = message.find(f.path, i + 1)
        paths = [safe_path(p) for _, p in sorted(matches)]
        suffix = ((" (+" + str(len(paths) - 5) + " more)") if len(paths) > 5 else "")
        sys.exit("refusing to commit: " + error_facts(e) + " paths=" + str(len(paths))
                 + (" " + ", ".join(paths[:5]) + suffix if paths else ""))
    say("committed to " + DATASET + " in " + format(time.time() - t, ".0f") + "s")
finally:
    cleanup()
EOPY
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
export function jobArgs({ source, dataset, staging, exclude = [] }) {
  return [
    'jobs', 'run', '--detach',
    '--name', jobName(),
    '--secrets', 'HF_TOKEN',
    '-e', `AM_SOURCE=${source}`,
    '-e', `AM_DATASET=${dataset}`,
    '-e', `AM_STAGING=${staging}`,
    // Folder-name tokens, space-joined. They are validated to contain no
    // whitespace, so the Job splits them back apart exactly. Tokens, not globs:
    // the Job matches them against the API listing itself, so the two-pattern
    // glob dance `hf upload --exclude` needed is gone.
    '-e', `AM_EXCLUDE=${normalizeExclude(exclude).join(' ')}`,
    // No `-v`: nothing is mounted. The pipeline reads the bucket through the API
    // and downloads to local disk, which is ~6,000x faster to walk (§3.11).
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
  const dataset = (cfg?.backup?.dataset || d.dataset || '').trim();
  const staging = (cfg?.backup?.staging || d.staging || '').trim();
  return { dataset, staging, defaults: d, exclude: excludeFromConfig(cfg?.backup?.exclude) };
}

/** Launch one backup Job now. Returns { job } — the Hub does the rest. */
export async function runBackupNow(cfg) {
  const blocked = runNowBlockedBy();
  if (blocked) throw new ApiError(403, 'backup-unavailable', blocked);
  // Two runs at once would have two Jobs uploading to the same dataset, which
  // race. The timer skips for this reason too; on demand it is worth saying out
  // loud rather than silently doing nothing.
  if (await isRunning()) throw new ApiError(409, 'backup-running', 'a backup is already running');
  const source = sourceBucket();
  const { dataset, staging, exclude } = await targets(cfg);
  for (const [label, id] of [['source', source], ['dataset', dataset], ['staging', staging]]) {
    if (!validRepoId(id)) throw new ApiError(400, 'invalid-input', `${label} is not a valid repo id`);
  }
  if (staging.toLowerCase() === source.toLowerCase()) throw new ApiError(400, 'invalid-input', 'staging bucket must differ from source');
  // Nothing is pre-created here. Both destinations are created explicitly
  // private INSIDE the Job and then read back before anything is written —
  // creating them from two places is how you end up trusting a default.
  const out = await run(jobArgs({ source, dataset, staging, exclude }), { timeout: 180_000 });
  const job = parseJobId(out);
  // A launch we cannot identify still happened — record it, but say so, because
  // without an id there is nothing to poll and no overlap to detect.
  if (!job) console.warn('[backup] launched a Job but could not parse its id from:', out.slice(0, 200));
  saveState({ jobId: job, startedAt: Date.now(), source, dataset, staging, error: null, outcomeFor: null });
  return { job };
}

/** Stage and the platform's own message for a Job — "Job timeout" lives in the
 *  message, and it is the difference between "it broke" and "it never finished". */
async function jobStatus(jobId) {
  if (!jobId) return { stage: null, message: null };
  try {
    const j = JSON.parse(await run(['jobs', 'inspect', jobId, '--json'], { timeout: 30_000 }));
    const s = Array.isArray(j) ? j[0] : j;
    return { stage: (s && s.status && s.status.stage) || null, message: (s && s.status && s.status.message) || null };
  } catch { return { stage: null, message: null }; }
}

/** Terminal state of the last launched Job, or null while it is still going. */
async function jobStage(jobId) {
  return (await jobStatus(jobId)).stage;
}

/**
 * Read the Job's controlled refusal and Git-folder count from its logs.
 * Arbitrary error lines may contain secrets and must not enter state.
 */
export function parseBackupLogs(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const countLine = [...lines].reverse().find((l) => /^scope: skipped \d+ \.git folders;/.test(l));
  const gitFoldersSkipped = countLine ? Number(countLine.match(/^scope: skipped (\d+)/)[1]) : null;
  // Only the Job's controlled refusal is safe to persist. Other exceptions can
  // contain arbitrary Hub response bodies, including token values.
  const refusal = [...lines].reverse().find((l) => {
    if (l.startsWith('refusing to commit:')) return true;
    const privacy = /^refusing to back up: (?:bucket|dataset) ([^ ]+) is not private$/.exec(l);
    if (privacy) return validRepoId(privacy[1]);
    return /^refusing to back up: (?:staging bucket is the source bucket|step=(?:initialization|install|privacy|staging|list|snapshot|sync|scrub|verify|commit) type=[A-Za-z][A-Za-z0-9_]{0,79} status=(?:unknown|[1-5][0-9]{2}) request_id=(?:unknown|[a-fA-F0-9-]{8,64}|Root=1-[a-fA-F0-9]{8}-[a-fA-F0-9]{24}(?:;[a-fA-F0-9-]{8,64})?))$/.test(l);
  });
  return { gitFoldersSkipped, reason: refusal ? refusal.slice(0, 300) : null };
}

async function backupLogDetails(jobId) {
  try { return parseBackupLogs(await run(['jobs', 'logs', jobId], { timeout: 90_000 })); }
  catch { return { gitFoldersSkipped: null, reason: null }; }
}

/**
 * Record how the last run ended, once, so the answer survives in state instead
 * of needing a Hub call to discover.
 *
 * This is the whole point of the feature: a backup that fails quietly is worse
 * than no backup at all, because the operator believes they are covered. Until
 * now nothing wrote a failure down — the settings row only learned of one if
 * somebody happened to open it while the evidence was still fresh.
 */
async function recordOutcome() {
  const st = loadState();
  if (!st.jobId || st.outcomeFor === st.jobId) return;
  const { stage, message } = await jobStatus(st.jobId);
  if (!stage || isActiveStage(stage)) return; // still running, or the Hub did not say
  const details = await backupLogDetails(st.jobId);
  if (stage === 'COMPLETED') {
    saveState({ outcomeFor: st.jobId, failures: 0, lastFailure: null, lastSuccessAt: Date.now(), ...(details.gitFoldersSkipped == null ? {} : { gitFoldersSkipped: details.gitFoldersSkipped }) });
    return;
  }
  saveState({
    outcomeFor: st.jobId,
    failures: (st.failures || 0) + 1,
    ...(details.gitFoldersSkipped == null ? {} : { gitFoldersSkipped: details.gitFoldersSkipped }),
    lastFailure: { at: Date.now(), jobId: st.jobId, stage, message: message || null, reason: details.reason },
  });
  console.warn(`[backup] run ${st.jobId} ended ${stage}${message ? ` (${message})` : ''}`);
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
  // How the last run ended is recorded even when this tick does nothing else —
  // otherwise a failure is only noticed by someone opening the settings page.
  if (hasToken()) await recordOutcome().catch(() => {});
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
/** Note when the schedule was first switched on, so "no success yet" can go
 *  stale for a backup that has never once worked — which is this Space today. */
export function armStaleClock(cfg) {
  if (!intervalMs(cfg?.backup?.every)) return;
  const st = loadState();
  if (!st.firstArmedAt) saveState({ firstArmedAt: Date.now() });
}

export function startBackupTimer(getConfig) {
  armStaleClock(getConfig());
  const t = setInterval(() => { armStaleClock(getConfig()); tick(getConfig()).catch(() => {}); }, TICK_MS);
  if (t.unref) t.unref();
  // First check shortly after boot, once bucket discovery has landed.
  const first = setTimeout(() => { tick(getConfig()).catch(() => {}); }, 30_000);
  if (first.unref) first.unref();
  return () => { clearInterval(t); clearTimeout(first); };
}

/**
 * Backup health, from state alone — no Hub calls, because this rides on
 * /api/info which every open tab polls every 15 seconds.
 *
 * Returns null when there is nothing wrong, so the dashboard shows nothing at
 * all in the normal case. Two ways to be unwell:
 *   - `failing`: the last run ended in ERROR (or was killed).
 *   - `stale`: no successful run in three intervals. A silent stall — the timer
 *     never firing, the token going bad — leaves an operator just as wrongly
 *     confident as an outright failure, and looks fine without this.
 */
export function backupHealth(cfg) {
  const every = cfg?.backup?.every || 'never';
  const ms = intervalMs(every);
  if (!ms) return null; // switched off: silence is correct
  const st = loadState();
  const f = st.lastFailure || null;
  const lastSuccessAt = st.lastSuccessAt || null;
  const since = lastSuccessAt || st.firstArmedAt || null;
  const stale = !!since && Date.now() - since > ms * 3;
  if (!f && !stale) return null;
  return {
    failing: !!f,
    stale,
    failures: st.failures || 0,
    at: f ? f.at : null,
    jobId: f ? f.jobId : null,
    stage: f ? f.stage : null,
    message: f ? f.message || null : null,
    reason: f ? f.reason || null : null,
    lastSuccessAt,
    jobsUrl: jobsUrl(),
  };
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
  const { dataset, staging, defaults, exclude } = await targets(cfg);
  // Not gated on the interval: an on-demand backup is a real backup, and its
  // result has to be visible even with the schedule off.
  const [stage, priv] = await Promise.all([
    state.jobId ? jobStage(state.jobId) : null,
    dataset && hasToken() ? datasetPrivate(dataset) : null,
  ]);
  return {
    every,
    source,
    dataset,
    staging,
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
    // The tokens as stored, plus the shipped defaults, so Settings can offer
    // "restore defaults" and show whether the current list differs from them.
    exclude,
    excludeDefaults: [...DEFAULT_EXCLUDE],
    excludeIsDefault: exclude.length === DEFAULT_EXCLUDE.length
      && exclude.every((t, i) => t === DEFAULT_EXCLUDE[i]),
    health: backupHealth(cfg),
    failures: state.failures || 0,
    lastFailure: state.lastFailure || null,
    lastSuccessAt: state.lastSuccessAt || null,
    gitFoldersSkipped: state.gitFoldersSkipped ?? null,
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
