// Warn when a synchronous fs call blocks the event loop, and name the caller.
//
// On the Space, DATA_DIR / HOME / CLAUDE_CONFIG_DIR are on the FUSE bucket,
// where a statSync costs ~85ms against 0.01ms on local disk. Node runs JS on one
// thread, so one such call freezes every pane the server is carrying for that
// long. This has bitten us three times now — claudeTranscriptsSince, then
// codexRolloutsSince — and it is hard to spot because **the kernel's pressure
// accounting cannot see it**: FUSE parks the caller in wait_event_interruptible
// (state S), not io_schedule, so the wait is never counted as iowait and
// /proc/pressure/io reads 0.00 while the loop is stuck. Hence a tripwire here.
//
// Silent on a normal filesystem. AM_SLOWFS_MS=0 disables it.
import fs from 'node:fs';

const THRESHOLD_MS = Number(process.env.AM_SLOWFS_MS ?? 50);
// One line per call site per window: a bucket stall must not become a log storm.
const REPEAT_MS = 10_000;

const lastLogged = new Map(); // call site -> { at, suppressed }

// The first frame outside this file that names real source. Internal callback
// frames ("at Array.forEach (<anonymous>)") point at nothing actionable.
function callSite(skip) {
  const holder = {};
  try { Error.captureStackTrace(holder, skip); } catch { return '?'; }
  for (const raw of String(holder.stack || '').split('\n').slice(1)) {
    const line = raw.trim();
    if (!line.startsWith('at ') || line.includes('slowfs.js') || line.includes('node:')) continue;
    if (!line.includes('file:') && !line.includes('/')) continue;
    return line.slice(3);
  }
  return '?';
}

export function installSlowFsProbe({ thresholdMs = THRESHOLD_MS } = {}) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false;

  // Every *Sync method, rather than a hand-kept list that drifts as callers move.
  for (const name of Object.keys(fs).filter((k) => k.endsWith('Sync'))) {
    const original = fs[name];
    if (typeof original !== 'function') continue;

    function slowFsWrapper(...args) {
      const t0 = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        // This sits in front of every sync fs call in the process, including
        // ones inside catch blocks: it must never throw and never swallow.
        try {
          const ms = performance.now() - t0;
          if (ms >= thresholdMs) warn(name, args[0], ms, slowFsWrapper);
        } catch { /* diagnostics must not break the app */ }
      }
    }
    // realpathSync.native and friends hang off the function itself.
    Object.assign(slowFsWrapper, original);
    Object.defineProperty(slowFsWrapper, 'name', { value: name });
    fs[name] = slowFsWrapper;
  }
  console.warn(`[slowfs] watching synchronous fs; logging calls over ${thresholdMs}ms`);
  return true;
}

function warn(method, target, ms, skip) {
  const site = callSite(skip);
  const key = `${method} ${site}`;
  const prev = lastLogged.get(key);
  const now = Date.now();
  if (prev && now - prev.at < REPEAT_MS) { prev.suppressed++; return; }
  const extra = prev?.suppressed ? ` (+${prev.suppressed} more since last line)` : '';
  lastLogged.set(key, { at: now, suppressed: 0 });
  // target may be a Buffer, URL or fd; String() covers all three well enough.
  console.warn(`[slowfs] ${ms.toFixed(0)}ms ${method} ${String(target)} — at ${site}${extra}`);
}
