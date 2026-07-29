import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import fs from 'node:fs';
import { remoteState, setPaused } from './remote.js';
import { cliById, WORKSPACES_DIR, isRemote } from './config.js';
import { update, list } from './sessions.js';
import { captureOpencodeSession } from './traces.js';
import { buildPaletteIndex, snapshotToAnsi } from './snapshot.js';

// libghostty-vt ships prebuilts for linux x64/arm64 and macOS arm64. Loading it
// is guarded so a platform without a prebuilt still boots and says so, rather
// than taking the whole app down.
let ghostty = null;
export let ghosttyError = null;
try {
  ghostty = await import('@coder/libghostty-vt-node');
  buildPaletteIndex(ghostty.createTerminal);
} catch (err) {
  ghosttyError = String(err && err.message ? err.message : err);
  console.error('[runner] libghostty-vt unavailable:', ghosttyError);
}

const TERM_ENV = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: process.env.LANG || 'C.UTF-8',
};

const BASHRC = process.env.AM_BASHRC || '/app/session.bashrc';
const AM_USER = process.env.SPACE_AUTHOR_NAME || process.env.AM_USER || os.userInfo().username || 'user';

// Interactive bash that loads our prompt rcfile (bash ignores a missing rcfile,
// so this is safe in local dev where /app/session.bashrc doesn't exist).
const bashLaunch = `exec bash --rcfile ${BASHRC} -i`;

// ---------- session hosts (what replaced tmux) ----------
//
// Every session is one PTY held by THIS process, with a libghostty-vt terminal
// fed from its output. That terminal is the authoritative screen, so:
//
//   * a browser attaching gets a snapshot repaint plus replayed scrollback,
//     instead of asking tmux to redraw and hoping the agent's TUI cooperates;
//   * several browsers can watch and drive the same session at once, so the old
//     one-device-at-a-time handover is gone;
//   * agent state is a property read rather than a `tmux capture-pane`
//     subprocess per session per poll.
//
// What we gave up is tmux outliving this process. On a Space that only ever
// bridged a node restart (a rebuild or a sleep takes the whole container), and
// each CLI resumes its own conversation on relaunch.

// Rendered text unchanged for this long means the agent isn't working.
const BUSY_SECS = 4;
// Re-rendering the grid to text on every chunk during a burst is wasteful.
const SAMPLE_THROTTLE_MS = 250;
// Scrollback replayed to a reattaching browser, as raw PTY bytes. snapshot()
// returns history as plain LINES, so replaying that would hand back colourless
// scrollback under a fully styled screen.
const REPLAY_BYTES = Number(process.env.AM_REPLAY_BYTES || 256 * 1024);
const SCROLLBACK_LINES = Number(process.env.AM_SCROLLBACK || 20000);

const hosts = new Map(); // session id -> host

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export function isRunning(id) {
  return hosts.has(id);
}

export function ghosttyReady() {
  return !!ghostty;
}

/** Sample the grid's rendered text and record when it last changed. */
function sampleScreen(host) {
  const now = Date.now();
  if (host.lastSampleAt && now - host.lastSampleAt < SAMPLE_THROTTLE_MS) return;
  host.lastSampleAt = now;
  let text = '';
  try { text = host.vt.getVisibleText(); } catch { return; }
  const sig = djb2(text);
  if (host.screenSig !== sig) {
    host.screenSig = sig;
    host.screenChangedAt = now;
  }
}

/**
 * Activity per session, keyed like the old tmux sweep so callers don't change.
 * No subprocess and no memo: the grid is already current, so this is a map build
 * over held sessions.
 */
export function agentInfo() {
  const map = new Map();
  const now = Date.now();
  for (const [id, host] of hosts) {
    const changedAt = host.screenChangedAt || host.startedAt;
    map.set(id, { age: Math.round((now - changedAt) / 1000), bells: host.bells || 0 });
  }
  return map;
}

/**
 * Map activity + the session's known CLI into a UI state:
 *   working  — screen text is actively changing (thinking / streaming / a command)
 *   waiting  — agent alive but its screen is static → it's your turn
 *   idle     — a plain shell sitting at its prompt
 *   stopped  — no live session
 */
export function deriveState(session, info) {
  if (session.cli === 'files' || session.cli === 'trace') return 'idle'; // passive panels, not processes
  // A remote agent's liveness comes from its polling, not from a pane we can
  // capture — there is no tmux session here to diff.
  if (isRemote(session.cli)) return remoteState(session);
  if (!info) return isRunning(session.id) ? 'idle' : 'stopped';
  if (info.age <= BUSY_SECS) return 'working';
  return session.cli === 'shell' ? 'idle' : 'waiting';
}

/** The visible screen as text, with no browser attached. */
export function peek(id) {
  const host = hosts.get(id);
  if (!host) return null;
  try { return host.vt.getVisibleText(); } catch { return null; }
}

// ---------- the shared grid ----------
//
// One session, one grid, however many viewers. A client may REQUEST a size but
// never imposes one: letting each client size itself is what garbles a second
// device, because the phone resizes the PTY while the laptop keeps drawing into
// its old geometry. The grid follows the smallest attached viewer so the content
// fits everywhere, and grows back as viewers leave.

function effectiveGrid(host) {
  if (!host.sizes.size) return { cols: host.cols, rows: host.rows };
  let cols = Infinity;
  let rows = Infinity;
  for (const s of host.sizes.values()) {
    cols = Math.min(cols, s.cols);
    rows = Math.min(rows, s.rows);
  }
  return { cols, rows };
}

function applyGrid(host) {
  const { cols, rows } = effectiveGrid(host);
  if (cols === host.cols && rows === host.rows) return false;
  host.cols = cols;
  host.rows = rows;
  try { host.pty.resize(cols, rows); } catch {}
  try { host.vt.resize(cols, rows); } catch {}
  for (const sub of host.subs) sub.onGrid(cols, rows, host.subs.size > 1, host.subs.size);
  return true;
}

// ---------- Codex conversation pinning ----------
// Codex picks its own conversation id at launch and doesn't accept one up
// front — but it announces the pick immediately: a rollout file named
// rollout-<ts>-<id>.jsonl appears under $CODEX_HOME/sessions with the cwd in
// its first line. Capture that id shortly after launch and pin it on the
// session, so restarts resume THIS agent's conversation — `resume --last`
// would grab whichever Codex agent in the same folder ran last.
const codexCapturing = new Map(); // id -> pending re-pin timer

// Every harness's conversation pin is re-checked on this cadence for as long as
// the pane is alive, so a mid-session reset (/clear and friends) can't leave the
// pin describing a conversation the user has moved on from.
const REPIN_MS = 20_000;

function codexSessionsRoot() {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

// Rollout files touched since `sinceMs`, newest first.
function codexRolloutsSince(sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { const m = fs.statSync(p).mtimeMs; if (m >= sinceMs) out.push({ p, m }); } catch {}
      }
    }
  };
  walk(codexSessionsRoot(), 0);
  return out.sort((a, b) => b.m - a.m);
}

// First line of a (potentially large) file without reading all of it. Codex's
// session_meta line carries the full embedded instruction text (~22KB as of
// 0.142), so read in chunks until the newline — a fixed small buffer would
// truncate the JSON and make every capture silently fail.
// The first line of a transcript that records a `cwd`, with its timestamp.
// Bounded on lines AND bytes: a file-history-snapshot line can be megabytes.
function transcriptHead(p) {
  // openSync INSIDE the try: on the bucket mount a transcript can rotate away
  // between the stat that found it and this open, and the only caller runs in a
  // setTimeout where a throw is unhandled.
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const CHUNK = 65536, MAX_BYTES = 512 * 1024, MAX_LINES = 64;
    let carry = '', pos = 0, lines = 0;
    while (pos < MAX_BYTES && lines < MAX_LINES) {
      const b = Buffer.alloc(Math.min(CHUNK, MAX_BYTES - pos));
      const n = fs.readSync(fd, b, 0, b.length, pos);
      if (!n) break;
      pos += n;
      carry += b.toString('utf8', 0, n);
      let nl;
      while ((nl = carry.indexOf('\n')) >= 0 && lines < MAX_LINES) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        lines++;
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j && j.cwd) return { cwd: j.cwd, timestamp: j.timestamp || null };
      }
      if (n < b.length) break; // EOF
    }
    return null;
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

function firstLine(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const CHUNK = 65536, MAX = 1024 * 1024;
    let buf = Buffer.alloc(0);
    for (let pos = 0; pos < MAX; pos += CHUNK) {
      const b = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, b, 0, CHUNK, pos);
      buf = Buffer.concat([buf, b.subarray(0, n)]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) return buf.toString('utf8', 0, nl);
      if (n < CHUNK) break; // EOF
    }
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function tryCaptureCodexId(sessionId, workdir, sinceMs) {
  const claimed = new Set(list().filter((s) => s.id !== sessionId && s.codexSessionId).map((s) => s.codexSessionId));
  const pinned = (list().find((s) => s.id === sessionId) || {}).codexSessionId;
  for (const c of codexRolloutsSince(sinceMs)) {
    const m = c.p.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    if (!m || claimed.has(m[1])) continue;
    let meta;
    try { meta = JSON.parse(firstLine(c.p)); } catch { continue; }
    const mp = (meta && meta.payload) || {};
    if (mp.cwd !== workdir) continue;
    // A sibling's ongoing conversation in the same folder gets fresh writes
    // (mtime) during our capture window — require the rollout to have been
    // CREATED after this launch so we never claim someone else's thread.
    const created = Date.parse(mp.timestamp || meta.timestamp || '') || 0;
    if (created && created < sinceMs - 15_000) continue;
    // Skip Codex's internal guardian/subagent rollouts — they share the cwd but
    // aren't this agent's conversation, so pinning one would break resume and
    // the Overview digest.
    if (mp.thread_source === 'subagent' || (mp.source && mp.source.subagent)) continue;
    // The watcher re-runs for the life of the pane, so the usual outcome is
    // "still the same conversation" — don't rewrite sessions.json for that.
    if (m[1] === pinned) return true;
    if (pinned) console.warn(`[codex] re-pinning ${sessionId}: ${pinned} -> ${m[1]} (conversation was replaced)`);
    update(sessionId, { codexSessionId: m[1], codexRollout: c.p });
    return true;
  }
  return false;
}

// A pin captured before subagents were filtered out (or one whose rollout was
// rotated away) may point at a guardian/missing rollout — clear it so we
// re-capture the real conversation on this launch.
function pinIsStale(session) {
  if (!session.codexSessionId) return false;
  const p = session.codexRollout;
  if (!p || !fs.existsSync(p)) return true;
  try {
    const mp = (JSON.parse(firstLine(p)) || {}).payload || {};
    return mp.thread_source === 'subagent' || !!(mp.source && mp.source.subagent);
  } catch { return false; }
}

// Same staleness problem as Claude's pin, same remedy: codex starts a fresh
// conversation — and a fresh rollout file — when the thread is reset, so a pin
// captured once at launch stops describing the live conversation. Keep watching
// for as long as the pane is alive and follow the newest rollout this folder
// produces. tryCaptureCodexId only writes when the id actually changes.
function scheduleCodexCapture(session, workdir) {
  if (session.codexSessionId && pinIsStale(session)) {
    session = update(session.id, { codexSessionId: undefined, codexRollout: undefined }) || session;
  }
  const prev = codexCapturing.get(session.id);
  if (prev) clearTimeout(prev);
  const since = Date.now() - 2000;
  let warnedShared = false;

  const tick = () => {
    if (!isRunning(session.id)) { codexCapturing.delete(session.id); return; }
    if (folderIsShared(session.id, workdir, 'codex')) {
      if (!warnedShared) {
        warnedShared = true;
        console.warn(`[codex] ${session.id}: folder shared with another live session — not following thread resets here`);
      }
    } else {
      tryCaptureCodexId(session.id, workdir, since);
    }
    const t = setTimeout(tick, REPIN_MS);
    if (t.unref) t.unref();
    codexCapturing.set(session.id, t);
  };

  const t0 = setTimeout(tick, 5000); // rollout appears ~instantly
  if (t0.unref) t0.unref();
  codexCapturing.set(session.id, t0);
}

// opencode has no per-conversation handle we can pass on launch, so we can't
// mint an id like Claude's --session-id. Instead, capture the ses_ row opencode
// writes to its db and pin it — mirrors the codex approach. The row appears
// only once the conversation has content (the user's first message), so retry
// on a longer, sparser schedule than codex.
// ---------- Claude conversation re-pinning ----------
// We ASK for a conversation id up front (`claude --session-id <uuid>`), which
// normally makes the transcript filename equal session.sessionUuid. But the
// launch line ends in `|| exec claude`, and when the first invocation exits
// non-zero — a fresh install running its onboarding does exactly that — Claude
// starts again and picks an id of its OWN. The pin then matches nothing on disk,
// forever: the Overview shows no digest, `--resume` can't find the transcript so
// the session silently starts fresh every launch, and sharing can't locate it.
//
// So verify the pin after launch — and keep verifying it, see the watcher below —
// re-pinning to the transcript Claude actually wrote. Observed live on a test Space:
// session pinned 4efced14…, transcript on disk cb22b656….
const claudeCapturing = new Map(); // id -> pending re-pin timer

function claudeProjectDirs() {
  const home = process.env.HOME || '';
  return [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')]
    .filter(Boolean).filter((d, i, a) => a.indexOf(d) === i)
    .map((d) => path.join(d, 'projects'));
}

// Every transcript, newest first, touched since `sinceMs`.
function claudeTranscriptsSince(sinceMs) {
  const out = [];
  for (const proj of claudeProjectDirs()) {
    let dirs = [];
    try { dirs = fs.readdirSync(proj, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(proj, d.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(proj, d.name, f);
        try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) out.push({ p, m: st.mtimeMs }); } catch {}
      }
    }
  }
  return out.sort((a, b) => b.m - a.m);
}

const transcriptExists = (uuid) =>
  !!uuid && claudeProjectDirs().some((proj) => {
    let dirs = [];
    try { dirs = fs.readdirSync(proj, { withFileTypes: true }); } catch { return false; }
    return dirs.some((d) => {
      if (!d.isDirectory()) return false;
      try { return fs.readdirSync(path.join(proj, d.name)).some((f) => f.startsWith(uuid)); } catch { return false; }
    });
  });

// A transcript's opening cwd/timestamp never changes once written, and the
// filename IS the conversation id, so a path is never reused for a different
// conversation. That makes the head safe to remember — which matters because the
// watcher rescans every REPIN_MS for the life of every session, and on the Space
// these are synchronous reads against a FUSE mount. Without this, every tick
// re-read every transcript on disk and would show up as event-loop lag.
const headMemo = new Map(); // transcript path -> head

function transcriptHeadCached(p) {
  const hit = headMemo.get(p);
  if (hit) return hit;
  const head = transcriptHead(p);
  // Only remember a definite answer: null can just mean the file has no cwd line
  // yet (still being written), and caching that would poison it for the process.
  if (head) {
    if (headMemo.size > 500) headMemo.clear();
    headMemo.set(p, head);
  }
  return head;
}

// The newest conversation written in `workdir` that no other session has pinned,
// as { uuid, start }. `start` is the conversation's OWN first timestamp, which is
// what distinguishes a /clear-spawned successor from the thread it replaced —
// both keep receiving mtime updates, only the successor is newly born.
// Exported for server/test/repin.test.mjs.
export function claudeCandidate(sessionId, workdir, sinceMs) {
  const claimed = new Set(list().filter((s) => s.id !== sessionId && s.sessionUuid).map((s) => s.sessionUuid));
  let best = null;
  for (const c of claudeTranscriptsSince(sinceMs)) {
    const uuid = path.basename(c.p).replace(/\.jsonl$/, '');
    if (claimed.has(uuid)) continue;
    // The cwd is NOT on the first line: a transcript opens with metadata lines
    // (mode, permission-mode, file-history-snapshot, ai-title, worktree-state)
    // that have no cwd, and only the conversation lines carry one — line 4 or 5
    // in every real transcript measured. Reading line 1 made this check always
    // fail, so the re-pin could never actually claim anything.
    const head = transcriptHeadCached(c.p);
    // Only claim a conversation started in THIS session's folder.
    if (!head || head.cwd !== workdir) continue;
    const start = Date.parse(head.timestamp || '') || 0;
    // Born in this launch window, or it's an older thread that merely received
    // writes — someone else's, or our own pre-relaunch one.
    if (start && start < sinceMs - 15_000) continue;
    if (!best || start > best.start) best = { uuid, start };
  }
  return best;
}

// Another LIVE session of the same harness on the same folder makes a new
// conversation there unattributable: we cannot tell whose /clear produced it.
// Refuse to guess, the way share.js does when a folder has rivals.
function folderIsShared(sessionId, workdir, cli) {
  return list().some((s) => s.id !== sessionId && s.cli === cli
    && path.join(WORKSPACES_DIR, s.path ?? s.id) === workdir && isRunning(s.id));
}

// Re-pinning is NOT a one-shot check, because the pin can go stale mid-session.
// `/clear` ends the conversation and starts a new one with an id of its own,
// exactly like the onboarding fallback above: the transcript we pinned stops
// growing and Claude writes a NEW file. Nothing told the manager, so the pin
// aged out silently — the Overview digest, the trace panel and sharing all kept
// reading the pre-/clear thread, and the next launch ran `--resume <old uuid>`,
// restoring the conversation as it was BEFORE the /clear and discarding
// everything since. That is why a Space restart brought back the old session.
//
// So the watcher keeps looking for as long as the pane is alive and follows the
// session forward onto whatever conversation Claude is actually writing. One
// mechanism now covers both failure modes: the launch-time fallback (pin never
// honoured) and a /clear at any later point.
function scheduleClaudeCapture(session, workdir) {
  // A relaunch restarts the watch with a fresh window, so `since` can't drift
  // older and start admitting pre-relaunch threads as candidates.
  const prev = claudeCapturing.get(session.id);
  if (prev) clearTimeout(prev);
  const since = Date.now() - 2000;
  let warnedShared = false;

  const tick = () => {
    if (!isRunning(session.id)) { claudeCapturing.delete(session.id); return; }
    if (folderIsShared(session.id, workdir, 'claude')) {
      if (!warnedShared) {
        warnedShared = true;
        console.warn(`[claude] ${session.id}: folder shared with another live session — not following /clear here`);
      }
    } else {
      const pinned = (list().find((s) => s.id === session.id) || session).sessionUuid;
      const hit = claudeCandidate(session.id, workdir, since);
      if (hit && hit.uuid !== pinned) {
        const why = transcriptExists(pinned) ? 'conversation was replaced (/clear)' : '--session-id was not honoured';
        console.warn(`[claude] re-pinning ${session.id}: ${pinned} -> ${hit.uuid} (${why})`);
        update(session.id, { sessionUuid: hit.uuid });
      }
    }
    const t = setTimeout(tick, REPIN_MS);
    if (t.unref) t.unref();
    claudeCapturing.set(session.id, t);
  };

  const t0 = setTimeout(tick, 5000);
  if (t0.unref) t0.unref();
  claudeCapturing.set(session.id, t0);
}

const opencodeCapturing = new Map(); // id -> pending re-pin timer

// As with Claude and codex, the pin has to keep up with the live conversation:
// starting a new opencode conversation writes a new `session` row, and a pin
// captured once at launch would keep pointing at the abandoned one.
function scheduleOpencodeCapture(session, workdir) {
  const prev = opencodeCapturing.get(session.id);
  if (prev) clearTimeout(prev);
  const since = Date.now() - 2000;
  let warnedShared = false;

  const tick = () => {
    if (!isRunning(session.id)) { opencodeCapturing.delete(session.id); return; }
    if (folderIsShared(session.id, workdir, 'opencode')) {
      if (!warnedShared) {
        warnedShared = true;
        console.warn(`[opencode] ${session.id}: folder shared with another live session — not following new conversations here`);
      }
    } else {
      const claimed = new Set(list().filter((s) => s.id !== session.id && s.opencodeSessionId).map((s) => s.opencodeSessionId));
      const pinned = (list().find((s) => s.id === session.id) || session).opencodeSessionId;
      const hit = captureOpencodeSession(workdir, since, claimed);
      if (hit && hit.id !== pinned) {
        if (pinned) console.warn(`[opencode] re-pinning ${session.id}: ${pinned} -> ${hit.id} (conversation was replaced)`);
        update(session.id, { opencodeSessionId: hit.id });
      }
    }
    const t = setTimeout(tick, REPIN_MS);
    if (t.unref) t.unref();
    opencodeCapturing.set(session.id, t);
  };

  const t0 = setTimeout(tick, 3000);
  if (t0.unref) t0.unref();
  opencodeCapturing.set(session.id, t0);
}

// Single-quote a string for embedding in an `sh -lc` command line.
const shq = (t) => `'${String(t).replace(/'/g, `'\\''`)}'`;

function commandFor(session) {
  const cli = cliById(session.cli) || cliById('shell');
  if (cli.id === 'shell') return bashLaunch;
  // Quickstart: a prompt queued at creation rides the FIRST launch command
  // (claude 'p', codex 'p', gemini -i 'p', opencode --prompt 'p') — the CLI
  // starts already working on it, no typing race against a booting TUI.
  const q0 = !session.everStarted && session.pendingPrompt ? shq(session.pendingPrompt) : '';

  // Claude keys conversations by working directory, so grouped sessions sharing
  // a folder would all `--continue` onto the SAME most-recent conversation. Pin
  // each session to its own conversation id instead: create it with
  // --session-id, resume it with --resume. Decide resume-vs-fresh by whether the
  // transcript exists on disk (NOT via `resume || fresh`: that chain also fired
  // when claude itself exited non-zero, silently respawning a crashed session
  // as a fresh conversation and eating the pane's "done" signal). The fresh
  // branch keeps `|| exec claude` as a last resort for an unsupported flag.
  if (cli.id === 'claude' && session.sessionUuid) {
    const fresh = `claude --session-id ${session.sessionUuid}${q0 ? ` ${q0}` : ''} || exec claude`;
    if (!session.everStarted) return fresh;
    const projects = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"';
    const hasTranscript = `[ -n "$(find ${projects} -name '${session.sessionUuid}*' -print -quit 2>/dev/null)" ]`;
    return `if ${hasTranscript}; then exec claude --resume ${session.sessionUuid}; else ${fresh}; fi`;
  }

  // OpenClaw: first run needs its onboarding wizard (keys, workspace); once the
  // config exists, go straight to the TUI. Decided by config-file existence —
  // same honest pattern as the Claude transcript check.
  if (cli.id === 'openclaw') {
    // OpenClaw runs with its own HOME on local disk (see entrypoint.sh): its
    // state can't live on the FUSE bucket and it rejects symlinked paths.
    // Locally (no OPENCLAW_HOME) the real HOME is used unchanged.
    return 'HOME="${OPENCLAW_HOME:-$HOME}"; export HOME; '
      + 'if [ -s "$HOME/.openclaw/openclaw.json" ]; then exec openclaw chat; '
      + 'else openclaw onboard && exec openclaw chat; fi';
  }

  // Codex: resume this agent's pinned conversation (captured from its rollout
  // file after launch — see scheduleCodexCapture). Existence-checked like
  // Claude, so a purged rollout starts fresh honestly and a crash ends the
  // pane instead of respawning. Unpinned sessions fall through to the generic
  // `resume --last` below (correct while the agent has its folder to itself).
  if (cli.id === 'codex' && session.codexSessionId && session.codexRollout) {
    return `if [ -f '${session.codexRollout}' ]; then exec codex resume ${session.codexSessionId}; else exec codex; fi`;
  }

  // opencode (seen on 1.17.13): at startup it creates a DIRECTORY named
  // opencode.json at its own config path, then every message dies re-reading
  // it (EISDIR → the model silently never responds; the next launch exits
  // instantly). Clear a directory-shaped entry AND occupy the path with a real
  // config file — copied from opencode.jsonc when one exists — so the bug
  // can't re-trigger mid-session. An existing config FILE is left untouched.
  if (cli.id === 'opencode') {
    const guard = 'G="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"; '
      + 'mkdir -p "$(dirname "$G")"; [ -d "$G" ] && rm -rf "$G"; '
      + '[ -e "$G" ] || { [ -f "${G}c" ] && cp "${G}c" "$G" || echo "{}" > "$G"; }; ';
    // `--continue` resumes the most-recent conversation in the CWD, so two
    // opencode agents sharing a folder would resume onto the SAME conversation
    // (cross-talk) — same hazard as codex `resume --last`. Only continue when
    // this session holds its folder alone; otherwise start fresh, and capture
    // pins the new conversation right away (see scheduleOpencodeCapture).
    const folder = session.path ?? session.id;
    const shared = list().some((o) => o.id !== session.id && o.cli === 'opencode' && (o.path ?? o.id) === folder);
    const base = session.everStarted && cli.cont && !shared
      ? `${cli.cont} || exec ${cli.run}`
      : `exec ${q0 && cli.withPrompt ? cli.withPrompt(q0) : cli.run}`;
    return `${guard}${base}`;
  }

  // codex without a pinned conversation: `resume --last` scopes to the cwd,
  // so in a SHARED folder it can resume a SIBLING's conversation (cross-talk).
  // Only resume when this session has the folder to itself; otherwise start
  // fresh — capture pins the new conversation right away.
  if (cli.id === 'codex' && session.everStarted) {
    const folder = session.path ?? session.id;
    const shared = list().some((o) => o.id !== session.id && o.cli === 'codex' && (o.path ?? o.id) === folder);
    if (shared) return `exec ${cli.run}`;
  }

  // Other agents: resume when one likely exists, else a fresh launch. `exec` so
  // the agent is the PTY's foreground process; when it exits the session ends —
  // a clear "done" signal — and the fallback preserves that.
  if (session.everStarted && cli.cont) return `${cli.cont} || exec ${cli.run}`;
  if (q0 && cli.withPrompt) return `exec ${cli.withPrompt(q0)}`;
  return `exec ${cli.run}`;
}

/**
 * Start the session's PTY and its grid, without any browser attached. Returns
 * true if it had to spawn. This is now the ONLY way a session starts, so the
 * Overview reply box waking a stopped agent and a browser opening a pane take
 * exactly the same path.
 */
export function ensureRunning(session, cols = 120, rows = 34) {
  // Nothing to start: a remote agent starts itself, on its own machine. Both
  // callers guard this too; keep the refusal here so no future one can spawn
  // a PTY for a pane that can never use it.
  if (isRemote(session.cli)) throw new Error('a remote agent runs on its own machine — nothing to start here');
  const existing = hosts.get(session.id);
  if (existing) return false;
  if (!ghostty) throw new Error(`libghostty-vt unavailable: ${ghosttyError}`);

  // The recorded workspace-relative path ('' = the workspaces root itself).
  // If the folder was deleted or moved, mkdir simply recreates it empty — no
  // tracking, no magic.
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  fs.mkdirSync(workdir, { recursive: true });
  const full = commandFor(session);

  const env = {
    ...TERM_ENV,
    AM_SESSION: folder,
    AM_NAME: session.name,
    AM_ID: session.id,
    AM_USER,
    AM_ROOT: WORKSPACES_DIR, // prompt shows $PWD relative to this
  };
  const term = pty.spawn('bash', ['-lc', full], {
    name: 'xterm-256color', cols, rows, cwd: workdir, env,
  });
  const vt = ghostty.createTerminal({ cols, rows, scrollbackLimit: SCROLLBACK_LINES });

  const host = {
    id: session.id,
    pty: term,
    vt,
    cols,
    rows,
    subs: new Set(),
    sizes: new Map(), // sub -> the grid that viewer can display
    history: [],
    historyBytes: 0,
    historyDropped: false,
    startedAt: Date.now(),
    screenChangedAt: Date.now(),
    bells: 0,
  };

  term.onData((chunk) => {
    try { vt.feed(chunk); } catch (e) { console.error('[runner] vt.feed', e && e.message); }

    // State detection rides the feed path: the grid is already current, so there
    // is nothing to poll and no subprocess to spawn.
    sampleScreen(host);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 7) { host.bells++; host.lastBellAt = Date.now(); }
    }

    host.history.push(chunk);
    host.historyBytes += chunk.length;
    while (host.historyBytes > REPLAY_BYTES && host.history.length > 1) {
      host.historyBytes -= host.history.shift().length;
      host.historyDropped = true;
    }

    for (const sub of host.subs) sub.onData(chunk);
  });

  term.onExit(() => {
    hosts.delete(session.id);
    try { vt.dispose(); } catch {}
    for (const sub of host.subs) sub.onExit();
    host.subs.clear();
  });

  hosts.set(session.id, host);
  if (!session.everStarted) update(session.id, { everStarted: true, pendingPrompt: undefined });
  if (session.cli === 'codex') scheduleCodexCapture(session, workdir);
  if (session.cli === 'opencode') scheduleOpencodeCapture(session, workdir);
  if (session.cli === 'claude') scheduleClaudeCapture(session, workdir);
  return true;
}

/**
 * The bytes to replay for scrollback. A ring that has wrapped almost certainly
 * starts mid-escape-sequence, so drop everything before the first newline — the
 * repaint that follows is the authority for the visible screen either way.
 */
function replayBytes(host) {
  const joined = host.history.join('');
  if (!host.historyDropped) return joined;
  const nl = joined.indexOf('\n');
  return nl >= 0 ? joined.slice(nl + 1) : joined;
}

/**
 * Subscribe a viewer to a session, starting it if needed.
 *
 * Unlike the tmux version this does NOT spawn anything per viewer, and
 * `handle.kill()` only unsubscribes — closing a tab must never stop an agent.
 * `handle.restore()` returns the bytes that rebuild the screen: replayed
 * scrollback first, then a snapshot repaint on top as the authority.
 */
export function attach(session, cols, rows) {
  ensureRunning(session, cols, rows);
  const host = hosts.get(session.id);
  if (!host) throw new Error('session failed to start');

  const sub = {
    onData: () => {},
    onExit: () => {},
    onGrid: () => {},
  };
  host.subs.add(sub);

  return {
    onData: (cb) => { sub.onData = (d) => { try { cb(d); } catch {} }; },
    onExit: (cb) => { sub.onExit = () => { try { cb(); } catch {} }; },
    onGrid: (cb) => { sub.onGrid = (c, r, shared, viewers) => { try { cb(c, r, shared, viewers); } catch {} }; },
    write: (d) => { try { host.pty.write(d); } catch {} },
    // A request, not a command: the shared grid is recomputed from all viewers.
    resize: (c, r) => {
      if (!Number.isFinite(c) || !Number.isFinite(r)) return;
      host.sizes.set(sub, { cols: Math.max(20, Math.min(400, Math.round(c))), rows: Math.max(5, Math.min(200, Math.round(r))) });
      if (!applyGrid(host)) sub.onGrid(host.cols, host.rows, host.subs.size > 1, host.subs.size);
    },
    restore: () => {
      let snap;
      try { snap = host.vt.snapshot({ includeCells: true }); } catch { return null; }
      return {
        replay: replayBytes(host),
        ansi: snapshotToAnsi(snap),
        cols: snap.cols,
        rows: snap.rows,
        viewers: host.subs.size,
        shared: host.sizes.size > 1,
      };
    },
    // Detach this viewer only. The session, its grid and its scrollback stay.
    kill: () => {
      host.subs.delete(sub);
      host.sizes.delete(sub);
      applyGrid(host); // the grid grows back for whoever is left
    },
  };
}

/** Type a line into the session's terminal (works with no browser attached). */
export async function sendInput(id, text) {
  const host = hosts.get(id);
  if (!host) throw new Error('session is not running');
  // Multi-line prompts go in as a bracketed paste so the CLI's composer treats
  // the inner newlines as soft line breaks instead of submitting early.
  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  // The Enter must arrive as its OWN keypress: TUIs (codex) detect rapid input
  // bursts as a paste, and a CR inside the burst becomes a newline in the
  // composer instead of a submit. A short gap breaks the burst.
  host.pty.write(payload);
  await new Promise((r) => setTimeout(r, 300));
  host.pty.write('\r');
}

/**
 * The session's rendered screen plus `lines` of scrollback above it — what a
 * human would see in the pane. Used by the agent API so one agent can watch
 * another's progress instead of spending a turn asking.
 *
 * Reads the grid we already hold, so it costs no subprocess. snapshot() returns
 * history as plain text, which is exactly what the tmux `capture-pane -p` this
 * replaced produced, so callers see the same shape.
 */
export function capturePane(id, lines = 80) {
  const host = hosts.get(id);
  if (!host) return null; // stopped
  const n = Math.max(0, Math.min(2000, lines));
  let snap;
  try { snap = host.vt.snapshot({ includeScrollback: n > 0 }); } catch { return null; }
  const history = (snap.scrollbackLines || []).slice(-n).map((l) => l.text);
  const visible = (snap.visibleLines || []).map((l) => l.text);
  // Trailing blank rows are padding, not content: a short screen should not
  // arrive as 50 lines of nothing.
  return [...history, ...visible].join('\n').replace(/\s+$/, '');
}

/** Stop a session entirely (kills the process; viewers get an exit close code). */
export function stop(id) {
  const host = hosts.get(id);
  if (!host) return;
  try { host.pty.kill(); } catch {}
}

/**
 * Kill every session. Without tmux nothing outlives this process, so a clean
 * shutdown should not leave orphaned PTYs behind holding the workspace.
 */
export function stopAll() {
  for (const host of hosts.values()) {
    try { host.pty.kill(); } catch {}
  }
}
