import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PASSIVE_CLIS, isRemote } from './config.js';
import { list as listSessions, get as getSession } from './sessions.js';
import { isRunning, paneRootPid, ensureRunning, ghosttyReady } from './runner.js';
import { traceDigests } from './traces.js';

// The server owns every PTY, so a Space sleep, a reboot, or a factory reset ends
// all of them at once. Files and conversations survive on the bucket, but coming
// back means clicking each agent again — and a shell that was running something
// is simply gone, with nothing to show it ever mattered.
//
// So keep a RUNSTATE snapshot on the bucket: which sessions were alive, and
// which had a process actually running in them. On the next boot that snapshot
// is the record of what was up when the lights went out, and the sessions that
// were still yours get started again — detached, each resuming its own pinned
// conversation (runner.commandFor) with its scrollback replayed from the
// terminal history checkpoint. Everything else stays stopped: a restart is not
// an excuse to boot every agent you ever created.
//
// "revive", not "restore": in this codebase restore already means replaying a
// terminal's serialized grid to a viewer, which is a different thing entirely.
const RUNSTATE_FILE = path.join(DATA_DIR, 'runstate.json');

// How often the snapshot is refreshed. Frequent enough that a sleep loses at
// most half a minute of truth, rare enough to be invisible on the FUSE bucket.
const SNAPSHOT_MS = 30_000;
// A staggered boot: each revived session is a PTY plus a whole CLI booting, and
// launching them in one burst is what would make a restart feel like a crash.
const REVIVE_GAP_MS = 4000;
// Reviving is meant to bring your workbench back, not to recreate a fleet.
// Beyond this we start the most recently active ones and SAY so in the logs
// rather than quietly pretending the rest weren't running.
const MAX_REVIVE = 12;
// A Space that has been down for a season shouldn't wake up mid-thought. The
// recency rule bounds itself; this is the backstop for the work-in-flight one,
// whose whole point is that it carries no clock.
const STALE_SNAPSHOT_DAYS = 30;

// The snapshot as it was when this process started — read once, before the
// watch below starts overwriting it.
let previous = null;
let lastWritten = '';
// Boot revivals are staggered, so the first new snapshot must wait for them:
// writing at 30s would record a half-revived Space as the whole truth. Set in
// init() so it holds on EVERY boot path — the ones that revive nothing because
// something went wrong (no engine, Space locked) are exactly the ones where
// erasing the record does the most damage.
let settleAt = 0;

/** Load the previous boot's snapshot. Call once, before startRunstateWatch(). */
export function init() {
  try {
    const j = JSON.parse(fs.readFileSync(RUNSTATE_FILE, 'utf8'));
    previous = j && typeof j === 'object' && j.sessions ? j : null;
  } catch { previous = null; }
  // Hold the first write for a full cycle from here, whatever happens next. A
  // boot that revives nothing — engine missing, Space still locked, revive
  // switched off — must not answer by wiping the record of what was running:
  // that record is the only reason the next boot can do better.
  settleAt = Date.now() + SNAPSHOT_MS;
  return previous;
}

// Is anything running INSIDE this shell — a foreground command, or a `make &`
// left in the background? The pane's root process is the interactive bash, and
// anything it started is a child of it, which Linux hands us directly. One small
// procfs read, no subprocess, no /proc walk.
//
// SHELLS ONLY, on purpose. "Pane root == the thing you're talking to" is false
// for most agent CLIs: `codex` is a `#!/usr/bin/env node` launcher that keeps
// the native binary as a permanent child, and every `cont || exec run` launch
// shape leaves bash as the pane root with the CLI as its child. Both report a
// child forever, which would make the window mean nothing for those sessions —
// they would revive on every restart regardless. Agents don't need this signal
// anyway: they have a transcript, so the recency rule can see them. A shell has
// nothing else, which is the whole reason this rule exists.
function hasLiveChildren(pid) {
  if (!pid) return false;
  try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().length > 0; }
  catch { return false; } // no procfs / process already gone
}

// A terminal answers the TUI's questions by itself: on attach, xterm replies to
// device-attribute and cursor-position queries, and those replies travel the
// same socket frame as your keystrokes (the client sends all of onData; only its
// own control-claiming path distinguishes real keys). Counting them would make
// "you sent this session something" mean "a pane was open on it", which is not
// the question the revive window asks. Match only the shapes a terminal EMITS in
// reply — DA/CPR/window-report/DECRPM and DCS/OSC answers — never a key: arrow
// keys and friends end in uppercase A-D or `~`, none of which appear here.
const REPLY = /^(?:\x1b\[[?>!]?[0-9;]*\$?[cRty]|\x1bP[\s\S]*?\x1b\\|\x1b\][\s\S]*?(?:\x07|\x1b\\))+$/;
export function isTerminalReply(d) {
  return typeof d === 'string' && d.length > 0 && REPLY.test(d);
}

/** What is alive right now, and where something is actually running. */
function snapshot() {
  const sessions = {};
  for (const s of listSessions()) {
    // Passive panels are views, and a remote agent runs on someone's laptop —
    // neither is a process this server could ever start.
    if (PASSIVE_CLIS.includes(s.cli) || isRemote(s.cli)) continue;
    if (!isRunning(s.id)) continue;
    sessions[s.id] = {
      running: true,
      work: s.cli === 'shell' && hasLiveChildren(paneRootPid(s.id)),
    };
  }
  return { at: new Date().toISOString(), sessions };
}

/**
 * Write the snapshot now. Deliberately NOT hooked to SIGTERM: by the time a
 * shutdown signal lands the PTYs may already be going down, so a final write is
 * as likely to record an empty Space as a true one — and it would overwrite the
 * good record with it. A 30s-stale truth beats a fresh lie.
 */
export function saveRunstate() {
  const snap = snapshot();
  // The set of live sessions changes rarely; don't rewrite the bucket for a
  // timestamp nobody reads.
  const body = JSON.stringify(snap.sessions);
  if (body === lastWritten) return;
  try {
    const tmp = `${RUNSTATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, RUNSTATE_FILE);
    // Only once it's actually on disk: a FUSE write that threw must be retried
    // next cycle, not remembered as the state of the file.
    lastWritten = body;
  } catch (e) { console.error('[runstate]', e && e.message); }
}

/**
 * Keep the on-disk snapshot current for the next boot to read. Deliberately
 * writes nothing for the first cycle: until the boot revivals have finished, the
 * old snapshot is a truer record of what was running than the new one, and a
 * Space that crash-loops on boot must not erase it.
 */
export function startRunstateWatch({ intervalMs = SNAPSHOT_MS } = {}) {
  const t = setInterval(() => { if (Date.now() >= settleAt) saveRunstate(); }, intervalMs);
  if (t.unref) t.unref();
  return t;
}

/**
 * Which of the snapshotted sessions deserve to come back, most recently used
 * first. A session qualifies when it was alive in the snapshot AND either
 *   - you sent it something within `days` (your keystrokes in the pane, the
 *     Overview reply box, or a prompt in its transcript), or
 *   - something was still running in it at snapshot time.
 * The first rule is what keeps a working set alive across a reboot; the second
 * is what a shell running a long job leaves behind.
 *
 * Pure, and separate from the starting below, because this is the part with
 * rules in it: the arguments are all facts, the answer is just a list.
 */
export function selectRevivable({ snapshot: snap, sessions, digests, alive, days, now = Date.now() }) {
  const cutoff = now - days * 864e5;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const plan = [];
  for (const [id, rec] of Object.entries((snap && snap.sessions) || {})) {
    if (!rec || !rec.running) continue;
    const s = byId.get(id);
    if (!s) continue;                                        // deleted since
    if (PASSIVE_CLIS.includes(s.cli) || isRemote(s.cli)) continue;
    if (alive.has(id)) continue;                             // already up somehow
    // `lastInputAt` is what YOU typed (index.js records it); the digest covers
    // prompts that arrived before we tracked that, and prompts from peers.
    const d = digests.get(id);
    const lastPrompt = Math.max(Number(s.lastInputAt) || 0, (d && d.lastPromptTs) || 0);
    const recent = lastPrompt >= cutoff;
    // `work` is only meaningful for a shell (see hasLiveChildren). Re-checked
    // here rather than trusted, so a snapshot written before that was true
    // can't revive an agent on a signal that was never valid for it.
    const busy = !!rec.work && s.cli === 'shell';
    if (!recent && !busy) continue;
    plan.push({ id, name: s.name, cli: s.cli, at: lastPrompt, why: recent ? 'prompted recently' : 'work in flight' });
  }
  return plan.sort((a, b) => b.at - a.at);
}

/** Start the sessions that were running when this Space last went down. */
export async function reviveOnBoot({ enabled = true, days = 3 } = {}) {
  if (!enabled) return [];
  if (!previous || !previous.sessions) return [];
  // No terminal engine means ensureRunning throws for every session; say it once
  // instead of a dozen times.
  if (!ghosttyReady()) {
    console.warn('[revive] no terminal engine — starting nothing');
    return [];
  }
  const age = Date.now() - (Date.parse(previous.at) || 0);
  if (age > STALE_SNAPSHOT_DAYS * 864e5) {
    console.log(`[revive] last snapshot is ${Math.round(age / 864e5)} days old — starting nothing`);
    return [];
  }

  let digests = new Map();
  try { digests = await traceDigests(); } catch { /* no transcripts is fine */ }
  const sessions = listSessions();
  const plan = selectRevivable({
    snapshot: previous,
    sessions,
    digests,
    alive: new Set(sessions.filter((s) => isRunning(s.id)).map((s) => s.id)),
    days,
  });
  if (!plan.length) return [];

  const start = plan.slice(0, MAX_REVIVE);
  const skipped = plan.slice(MAX_REVIVE);
  console.log(`[revive] ${start.length} session(s) were running at shutdown — starting them again`);
  if (skipped.length) {
    console.log(`[revive] NOT starting ${skipped.length} more (cap ${MAX_REVIVE}): ${skipped.map((p) => p.name).join(', ')}`);
  }

  settleAt = Date.now() + start.length * REVIVE_GAP_MS + 5000;
  start.forEach((p, i) => {
    const t = setTimeout(() => {
      const s = getSession(p.id);
      if (!s) return; // deleted between the plan and its turn
      try {
        ensureRunning(s);
        console.log(`[revive] ${p.name} (${p.cli}) — ${p.why}`);
      } catch (e) { console.error(`[revive] ${p.name}:`, e && e.message); }
    }, i * REVIVE_GAP_MS);
    if (t.unref) t.unref();
  });
  return start;
}
