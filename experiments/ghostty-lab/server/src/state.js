import { execFileSync } from 'node:child_process';

/**
 * Agent state detection, both ways, so the cost can be compared honestly.
 *
 * Production derives state by shelling out to `tmux capture-pane -p` once per
 * session per poll and hashing the rendered text. It diffs RENDERED TEXT rather
 * than raw output on purpose: colour-only animations (Codex's shimmering banner)
 * fool a byte-activity check, while spinners, streaming text and elapsed-time
 * counters all change the text. That reasoning is sound and is preserved here.
 *
 * What changes with a server-held grid is only the cost: the same rendered text
 * is already in process, so there is no subprocess, no 1.5s memo to hide the
 * cost behind, and no reason for the sweep to be synchronous.
 */

// Text unchanged for longer than this means the agent isn't working.
export const BUSY_SECS = 4;

// Don't re-render the grid to text on every chunk during a burst of output.
const SAMPLE_THROTTLE_MS = 250;

export function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** Count BEL bytes as an explicit "your turn" signal from the app itself. */
export function noteBells(holder, chunk) {
  let n = 0;
  for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 7) n++;
  if (n) {
    holder.bells = (holder.bells || 0) + n;
    holder.lastBellAt = Date.now();
  }
  return n;
}

/**
 * Sample the held grid's rendered text and record when it last changed.
 * Called from the feed path; throttled, and cheap enough that it can be.
 */
export function sampleScreen(holder, now = Date.now()) {
  if (holder.lastSampleAt && now - holder.lastSampleAt < SAMPLE_THROTTLE_MS) return;
  holder.lastSampleAt = now;
  const t0 = performance.now();
  let text = '';
  try { text = holder.vt.getVisibleText(); } catch { return; }
  const sig = djb2(text);
  if (holder.screenSig !== sig) {
    holder.screenSig = sig;
    holder.screenChangedAt = now;
  }
  holder.sampleMs = performance.now() - t0;
  holder.samples = (holder.samples || 0) + 1;
  holder.sampleTotalMs = (holder.sampleTotalMs || 0) + holder.sampleMs;
}

/**
 * State from the in-process grid. No subprocess, no polling: the answer is
 * already maintained by the feed path, so reading it is a property access.
 */
export function gridState(holder, isShell = false) {
  if (!holder) return { state: 'stopped', method: 'grid', readMs: 0 };
  const t0 = performance.now();
  const age = holder.screenChangedAt ? (Date.now() - holder.screenChangedAt) / 1000 : Infinity;
  let state;
  if (age <= BUSY_SECS) state = 'working';
  else state = isShell ? 'idle' : 'waiting';
  return {
    state,
    method: 'grid',
    ageSecs: Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
    bells: holder.bells || 0,
    bellAgeSecs: holder.lastBellAt ? Math.round((Date.now() - holder.lastBellAt) / 100) / 10 : null,
    readMs: Math.round((performance.now() - t0) * 1000) / 1000,
    avgSampleMs: holder.samples ? Math.round((holder.sampleTotalMs / holder.samples) * 1000) / 1000 : 0,
    samples: holder.samples || 0,
  };
}

/**
 * State the production way: shell out to tmux, hash the captured text.
 * Kept here purely so the lab can price it against the grid read.
 */
const tmuxSigs = new Map(); // session name -> { sig, changedAt }

export function tmuxState(sessionName, isShell = false) {
  const t0 = performance.now();
  let text;
  try {
    text = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    tmuxSigs.delete(sessionName);
    return { state: 'stopped', method: 'tmux capture-pane', readMs: Math.round((performance.now() - t0) * 1000) / 1000 };
  }
  const now = Date.now();
  const sig = djb2(text);
  const prev = tmuxSigs.get(sessionName);
  const changedAt = !prev || prev.sig !== sig ? now : prev.changedAt;
  tmuxSigs.set(sessionName, { sig, changedAt });
  const age = (now - changedAt) / 1000;
  return {
    state: age <= BUSY_SECS ? 'working' : (isShell ? 'idle' : 'waiting'),
    method: 'tmux capture-pane',
    ageSecs: Math.round(age * 10) / 10,
    // The honest cost: a synchronous subprocess, per session, per poll.
    readMs: Math.round((performance.now() - t0) * 1000) / 1000,
  };
}
