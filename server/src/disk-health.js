// Is the container's local disk running out of space, or too full of agent
// state to survive the next boot restore?
//
// Why statfs alone is not enough on Hugging Face Spaces:
//   1. /data is hf-mount (FUSE over object storage) and reports a synthetic
//      multi-petabyte statfs — never read it for disk fullness.
//   2. The container rootfs (where $AM_LOCAL and /tmp live) is often an
//      un-quotaed overlayfs over a multi-terabyte Kubernetes worker NVMe:
//      statfs(AM_LOCAL) then reports 300+ GiB free on the host right up until
//      kubelet evicts the pod at HF_SPACE_DISK_GB (typically 50 GiB).
//   3. Even when live free space is above 10 GiB, scripts/agent-state.sh
//      restores every harness tree onto $AM_LOCAL at startup and stages each
//      adapter's API mirror under $AM_LOCAL/agent-state-mirror/<adapter> before
//      copying it into place. If peak restore bytes leave < 10 GiB on a fresh
//      container, the next Space sleep or rebuild risks failing boot with
//      ENOSPC or pod eviction.
//
// /api/info is polled every 15s by every open tab, so diskHealth() returns an
// in-memory cached snapshot with zero synchronous filesystem work; an unref'd
// background timer refreshes it off the event loop.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GiB = 1024 ** 3;
export const DEFAULT_WARN_FREE_BYTES = 10 * GiB;
const DEFAULT_CHECK_SECONDS = 30;
const DU_TIMEOUT_MS = 10_000;

export function warnThresholdBytes(env = process.env) {
  const raw = env.AM_DISK_WARN_BYTES;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_WARN_FREE_BYTES;
}

export function configuredLimitBytes(env = process.env) {
  const explicit = Number(env.AM_DISK_LIMIT_BYTES);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  // HF_SPACE_DISK_GB is injected on Spaces; ignore it when SPACE_ID is absent
  // so test servers spawned inside a Space do not inherit the outer quota.
  if (env.SPACE_ID) {
    const spaceGb = Number(env.HF_SPACE_DISK_GB);
    if (Number.isFinite(spaceGb) && spaceGb > 0) return spaceGb * GiB;
  }
  return null;
}

/**
 * Pure decision over already-measured byte counts. Returns null when both live
 * free space and next-boot restore headroom are at or above `warnFreeBytes`.
 */
export function evaluateDiskHealth({
  fsTotalBytes,
  fsFreeBytes,
  quotaBytes = null,
  localUsedBytes = null,
  adapterSizes = [],
  warnFreeBytes = DEFAULT_WARN_FREE_BYTES,
  isSpace = false,
  now = Date.now(),
} = {}) {
  if (!(warnFreeBytes > 0)) return null;
  if (!(fsTotalBytes > 0) || !Number.isFinite(fsFreeBytes) || fsFreeBytes < 0) return null;

  const hasQuota = Number.isFinite(quotaBytes) && quotaBytes > 0;
  // When statfs reports a volume much larger than the Space's ephemeral quota
  // (e.g. 1.5 TiB worker NVMe vs HF_SPACE_DISK_GB=50), kubelet enforces the
  // quota against the container's writable directories rather than via statfs.
  const unquotaedHostFs = hasQuota && localUsedBytes !== null && fsTotalBytes > quotaBytes * 1.25;
  const totalBytes = hasQuota ? Math.min(fsTotalBytes, quotaBytes) : fsTotalBytes;
  const freeBytes = unquotaedHostFs
    ? Math.min(fsFreeBytes, Math.max(0, quotaBytes - localUsedBytes))
    : Math.min(fsFreeBytes, totalBytes);

  const validAdapters = adapterSizes.filter((n) => Number.isFinite(n) && n > 0);
  const stateBytes = validAdapters.reduce((sum, n) => sum + n, 0);
  const largestAdapterBytes = validAdapters.reduce((max, n) => Math.max(max, n), 0);
  // agent-state.sh restores adapters in parallel, deleting each adapter's API
  // mirror once its rsync completes; peak local disk during restore is at least
  // all restored live state plus the largest single adapter's mirror.
  const bootPeakBytes = stateBytes > 0 ? stateBytes + largestAdapterBytes : 0;

  let bootFreeBytes = null;
  if (bootPeakBytes > 0 && (isSpace || hasQuota)) {
    const reclaimable = localUsedBytes !== null ? localUsedBytes : stateBytes;
    const freshBootCapacity = Math.min(totalBytes, fsFreeBytes + reclaimable);
    bootFreeBytes = Math.max(0, freshBootCapacity - bootPeakBytes);
  }

  const lowDisk = freeBytes < warnFreeBytes;
  const bootRisk = bootFreeBytes !== null && bootFreeBytes < warnFreeBytes;
  if (!lowDisk && !bootRisk) return null;

  return {
    lowDisk,
    bootRisk,
    freeBytes,
    totalBytes,
    warnFreeBytes,
    usedBytes: localUsedBytes !== null ? localUsedBytes : Math.max(0, totalBytes - freeBytes),
    stateBytes: stateBytes > 0 ? stateBytes : null,
    bootPeakBytes: bootPeakBytes > 0 ? bootPeakBytes : null,
    bootFreeBytes,
    source: unquotaedHostFs ? 'space-quota' : 'statfs',
    checkedAt: now,
  };
}

async function existingAncestor(target) {
  let cur = path.resolve(target);
  while (true) {
    try {
      await fs.promises.stat(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return '/';
      cur = parent;
    }
  }
}

/** Keep only existing directories on `dev` that are not inside another kept root. */
async function dedupeSameDevDirs(candidates, dev) {
  const resolved = [];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const real = await fs.promises.realpath(raw);
      const st = await fs.promises.stat(real);
      if (!st.isDirectory() || st.dev !== dev) continue;
      resolved.push(real);
    } catch {
      // Missing directories contribute 0 bytes.
    }
  }
  resolved.sort((a, b) => a.length - b.length);
  const kept = [];
  for (const dir of resolved) {
    if (kept.some((root) => dir === root || dir.startsWith(root === '/' ? '/' : `${root}${path.sep}`))) continue;
    kept.push(dir);
  }
  return kept;
}

/**
 * Run `du -sk -x` (POSIX 1024-byte allocated blocks, single filesystem, works
 * on both Linux and macOS) off the event loop. Returns sizes in bytes in the
 * order `du` reported them, or null if `du` produced no usable output.
 */
function duBytes(dirs, runDu = execFile) {
  if (!dirs.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    runDu('du', ['-sk', '-x', ...dirs], { timeout: DU_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      const text = String(stdout || '').trim();
      if (!text) return resolve(err ? null : []);
      const sizes = [];
      for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+/.exec(line);
        if (m) sizes.push(Number(m[1]) * 1024);
      }
      if (!sizes.length && err) return resolve(null);
      resolve(sizes);
    });
  });
}

function adapterDirsFor(env, localDir) {
  if (!env.AM_LOCAL) return [];
  const dirs = [
    env.CODEX_HOME || path.join(localDir, 'codex-home'),
    env.CLAUDE_CONFIG_DIR || path.join(localDir, 'agent-state', 'claude'),
    env.GEMINI_LIVE || path.join(localDir, 'agent-state', 'gemini-home', '.gemini'),
    env.OPENCLAW_STATE_DIR || path.join(localDir, 'oc-home', '.openclaw'),
    env.OPENCODE_LIVE || path.join(localDir, 'opencode-share'),
    env.HERMES_LIVE || path.join(localDir, 'hermes'),
    env.FX_LIVE || path.join(localDir, 'fx-home'),
    env.ANTIGRAVITY_LIVE || path.join(localDir, 'antigravity-home'),
  ];
  const liveHome = env.AM_LIVE_HOME || env.HOME;
  if (env.AM_DURABLE_HOME && liveHome && path.resolve(env.AM_DURABLE_HOME) !== path.resolve(liveHome)) {
    dirs.push(liveHome);
  }
  return dirs;
}

export async function probeDiskHealth({
  env = process.env,
  statfs = fs.promises.statfs,
  runDu = execFile,
  now = Date.now(),
} = {}) {
  const warnFreeBytes = warnThresholdBytes(env);
  if (!(warnFreeBytes > 0)) return null;

  const localDir = path.resolve(env.AM_LOCAL || env.TMPDIR || os.tmpdir());
  const anchor = await existingAncestor(localDir);
  let vfs, anchorStat;
  try {
    [vfs, anchorStat] = await Promise.all([statfs(anchor), fs.promises.stat(anchor)]);
  } catch {
    return null;
  }

  const blockSize = Number(vfs.frsize || vfs.bsize) || 4096;
  const fsTotalBytes = Number(vfs.blocks) * blockSize;
  const fsFreeBytes = Number(vfs.bavail) * blockSize;
  const quotaBytes = configuredLimitBytes(env);
  const isSpace = Boolean(env.SPACE_ID);

  // Measure container-writable local roots when a quota applies over a larger
  // host filesystem, or when computing fresh-boot headroom on a Space.
  const needLocalUsage = (quotaBytes && fsTotalBytes > quotaBytes * 1.25) || isSpace;
  const writableCandidates = [localDir];
  if (isSpace) {
    writableCandidates.push(env.TMPDIR || '/tmp');
    if (env.HOME) writableCandidates.push(env.HOME);
    if (env.DATA_DIR) writableCandidates.push(env.DATA_DIR); // included only if on same local dev (ephemeral fallback)
  }

  const [writableRoots, stateRoots] = await Promise.all([
    needLocalUsage ? dedupeSameDevDirs(writableCandidates, anchorStat.dev) : Promise.resolve([]),
    dedupeSameDevDirs(adapterDirsFor(env, localDir), anchorStat.dev),
  ]);

  const [writableSizes, adapterSizes] = await Promise.all([
    needLocalUsage ? duBytes(writableRoots, runDu) : Promise.resolve(null),
    stateRoots.length ? duBytes(stateRoots, runDu) : Promise.resolve([]),
  ]);

  const localUsedBytes = Array.isArray(writableSizes)
    ? writableSizes.reduce((sum, n) => sum + n, 0)
    : null;

  return evaluateDiskHealth({
    fsTotalBytes,
    fsFreeBytes,
    quotaBytes,
    localUsedBytes,
    adapterSizes: Array.isArray(adapterSizes) ? adapterSizes : [],
    warnFreeBytes,
    isSpace,
    now,
  });
}

let current = null;
let inFlight = null;
let timer = null;

export function refreshDiskHealth(opts) {
  if (inFlight) return inFlight;
  inFlight = probeDiskHealth(opts)
    .then((res) => { current = res; return res; })
    .catch(() => current)
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function startDiskHealthMonitor() {
  if (timer) return () => {};
  const everyMs = Math.max(1, Number(process.env.AM_DISK_CHECK_SECONDS) || DEFAULT_CHECK_SECONDS) * 1000;
  refreshDiskHealth();
  timer = setInterval(() => { refreshDiskHealth(); }, everyMs);
  if (timer.unref) timer.unref();
  return () => {
    clearInterval(timer);
    timer = null;
  };
}

export function diskHealth() {
  return current;
}
