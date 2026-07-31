import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { USE_TMUX, cliById, WORKSPACES_DIR, isRemote } from './config.js';
import { update, list } from './sessions.js';
import { captureOpencodeSession } from './traces.js';
import { remoteState, setPaused } from './remote.js';

const TERM_ENV = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: process.env.LANG || 'C.UTF-8',
};

const BASHRC = process.env.AM_BASHRC || '/app/session.bashrc';
const TMUX_CONF = process.env.TMUX_CONF || '/app/tmux.conf';
const AM_USER = process.env.SPACE_AUTHOR_NAME || process.env.AM_USER || os.userInfo().username || 'user';

// Interactive bash that loads our prompt rcfile (bash ignores a missing rcfile,
// so this is safe in local dev where /app/session.bashrc doesn't exist).
const bashLaunch = `exec bash --rcfile ${BASHRC} -i`;

const tmuxName = (id) => `am-${id}`;

// If the rendered pane text hasn't changed for this long, it's not working.
const BUSY_SECS = 4;
const paneSig = new Map(); // id -> { sig, changedAt } (changedAt in unix seconds)

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// In direct-PTY (no-tmux) mode we track live handles to report running status.
const live = new Map(); // id -> Set(handle)
const track = (id, h) => {
  if (!live.has(id)) live.set(id, new Set());
  live.get(id).add(h);
};
const untrack = (id, h) => {
  const s = live.get(id);
  if (s) {
    s.delete(h);
    if (!s.size) live.delete(id);
  }
};

export function isRunning(id) {
  if (USE_TMUX) {
    try {
      execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return live.has(id);
}

// Which sessions have a pane in copy mode right now — one tmux call covers all
// panes, so the server can push a copy-mode hint to attached clients cheaply.
export function paneModes() {
  const modes = {};
  if (!USE_TMUX) return modes;
  let out = '';
  try {
    // Mode first (a single 0/1), then the session name — which is `am-<id>`
    // and never contains a space, so splitting on the first space is safe.
    out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_in_mode} #{session_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return modes; } // no tmux server yet
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const name = line.slice(sp + 1);
    if (!name.startsWith('am-')) continue;
    const id = name.slice(3);
    modes[id] = modes[id] || line.slice(0, sp) === '1';
  }
  return modes;
}

/**
 * Detect activity by DIFFING each pane's rendered text between polls. This
 * ignores colour-only animations (e.g. Codex's shimmering banner) that fooled a
 * raw output-activity check, while still catching spinners, streaming output and
 * elapsed-time counters (their text changes). Returns Map id -> { age } where
 * age is seconds since the pane text last changed.
 */
let infoMemo = { ts: 0, map: new Map() };

export function agentInfo() {
  // The sweep shells out to tmux once per session, synchronously. Memoize it
  // briefly so N browser tabs polling /api/tree don't multiply that cost.
  if (Date.now() - infoMemo.ts < 1500) return infoMemo.map;
  const map = new Map();
  infoMemo = { ts: Date.now(), map };
  if (!USE_TMUX) return map;
  let list;
  try {
    list = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  } catch {
    paneSig.clear();
    return map; // no server / no sessions
  }
  const now = Math.floor(Date.now() / 1000);
  const live = new Set();
  for (const name of list.split('\n')) {
    if (!name.startsWith('am-')) continue;
    const id = name.slice(3);
    live.add(id);
    let text = '';
    try { text = execFileSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' }); } catch {}
    const sig = djb2(text);
    const prev = paneSig.get(id);
    const changedAt = !prev || prev.sig !== sig ? now : prev.changedAt;
    paneSig.set(id, { sig, changedAt });
    map.set(id, { age: now - changedAt });
  }
  for (const id of [...paneSig.keys()]) if (!live.has(id)) paneSig.delete(id);
  return map;
}

/**
 * Map activity + the session's known CLI into a UI state:
 *   working  — pane text is actively changing (thinking / streaming / a command)
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
  // the agent is the pane's foreground process; when it exits the tmux session
  // ends — a clear "done" signal — and the fallback preserves that.
  if (session.everStarted && cli.cont) return `${cli.cont} || exec ${cli.run}`;
  if (q0 && cli.withPrompt) return `exec ${cli.withPrompt(q0)}`;
  return `exec ${cli.run}`;
}

/** Attach a new PTY client to the session (creating the tmux session if needed). */
export function attach(session, cols, rows) {
  // A remote agent has no terminal here by design — its harness runs on another
  // machine. /ws catches this and says so in the pane.
  if (isRemote(session.cli)) throw new Error('this pane has no terminal — it talks to an agent elsewhere');
  // The recorded workspace-relative path ('' = the workspaces root itself).
  // If the folder was deleted or moved, mkdir simply recreates it empty — no
  // tracking, no magic.
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  fs.mkdirSync(workdir, { recursive: true });
  const full = commandFor(session);

  let term;
  if (USE_TMUX) {
    const args = [];
    if (fs.existsSync(TMUX_CONF)) args.push('-f', TMUX_CONF);
    args.push(
      // -A: attach if it exists, else create. -D: detach any other client, so
      // exactly ONE device drives the session at a time. Sharing it was worse:
      // window-size=latest resized the shared window to whoever spoke last, and
      // agent TUIs (which paint into the normal buffer, not the alt screen)
      // re-emit their frame with erase math computed at the OLD width — so every
      // phone/desktop flip left another copy of the same text in the scrollback,
      // wrapped at the other device's width. The handover is sequential instead:
      // the detached client is told the session lives on (close code 4001) and
      // waits for a deliberate return before taking it back (see TerminalPane).
      'new-session', '-A', '-D', '-s', tmuxName(session.id), '-c', workdir,
      '-e', `AM_SESSION=${folder}`,
      '-e', `AM_NAME=${session.name}`,
      '-e', `AM_ID=${session.id}`,
      '-e', `AM_USER=${AM_USER}`,
      '-e', `AM_ROOT=${WORKSPACES_DIR}`, // prompt shows $PWD relative to this
      'sh', '-lc', full,
    );
    term = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: workdir, env: TERM_ENV });
  } else {
    const env = { ...TERM_ENV, AM_SESSION: folder, AM_NAME: session.name, AM_ID: session.id, AM_USER, AM_ROOT: WORKSPACES_DIR };
    term = pty.spawn('bash', ['-lc', full], { name: 'xterm-256color', cols, rows, cwd: workdir, env });
  }

  if (!session.everStarted) update(session.id, { everStarted: true, pendingPrompt: undefined });
  if (session.cli === 'codex') scheduleCodexCapture(session, workdir);
  if (session.cli === 'opencode') scheduleOpencodeCapture(session, workdir);
  if (session.cli === 'claude') scheduleClaudeCapture(session, workdir);

  const handle = {
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(cb),
    write: (d) => { try { term.write(d); } catch {} },
    resize: (c, r) => { try { term.resize(c, r); } catch {} },
    kill: () => { try { term.kill(); } catch {} },
  };
  track(session.id, handle);
  term.onExit(() => untrack(session.id, handle));
  return handle;
}

/**
 * Make sure the session's tmux process exists WITHOUT a browser pane attached
 * (used by the Overview reply box to wake a stopped agent). Returns true if it
 * had to spawn. Direct-PTY mode has no detached equivalent — throws if dead.
 */
export function ensureRunning(session) {
  // Nothing to start: a remote agent starts itself, elsewhere. Callers that
  // might see one must go through deliver() (index.js) instead of assuming a PTY.
  if (isRemote(session.cli)) throw new Error('a remote agent runs on its own machine — nothing to start here');
  if (isRunning(session.id)) return false;
  if (!USE_TMUX) throw new Error('session is not running');
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  fs.mkdirSync(workdir, { recursive: true });
  const args = [];
  if (fs.existsSync(TMUX_CONF)) args.push('-f', TMUX_CONF);
  args.push(
    'new-session', '-d', '-s', tmuxName(session.id), '-c', workdir,
    '-x', '200', '-y', '50', // sane size until a client attaches (window-size=latest)
    '-e', `AM_SESSION=${folder}`,
    '-e', `AM_NAME=${session.name}`,
    '-e', `AM_ID=${session.id}`,
    '-e', `AM_USER=${AM_USER}`,
    '-e', `AM_ROOT=${WORKSPACES_DIR}`,
    'sh', '-lc', commandFor(session),
  );
  execFileSync('tmux', args, { stdio: 'ignore', env: TERM_ENV });
  if (!session.everStarted) update(session.id, { everStarted: true, pendingPrompt: undefined });
  if (session.cli === 'codex') scheduleCodexCapture(session, workdir);
  if (session.cli === 'opencode') scheduleOpencodeCapture(session, workdir);
  if (session.cli === 'claude') scheduleClaudeCapture(session, workdir);
  return true;
}

/** Type a line into the session's terminal (works with no browser attached). */
export async function sendInput(id, text) {
  // Multi-line prompts go in as a bracketed paste so the CLI's composer treats
  // the inner newlines as soft line breaks instead of submitting early.
  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  // The Enter must arrive as its OWN keypress: TUIs (codex) detect rapid input
  // bursts as a paste, and a CR inside the burst becomes a newline in the
  // composer instead of a submit. A short gap breaks the burst.
  const gap = () => new Promise((r) => setTimeout(r, 300));
  if (USE_TMUX) {
    execFileSync('tmux', ['send-keys', '-t', tmuxName(id), '-l', '--', payload], { stdio: 'ignore' });
    await gap();
    execFileSync('tmux', ['send-keys', '-t', tmuxName(id), 'Enter'], { stdio: 'ignore' });
    return;
  }
  const set = live.get(id);
  if (!set || !set.size) throw new Error('session is not running');
  const h = set.values().next().value;
  h.write(payload);
  await gap();
  h.write('\r');
}

/**
 * The session's rendered screen plus `lines` of scrollback above it — what a
 * human would see in the pane. Used by the agent API so one agent can watch
 * another's progress instead of spending a turn asking.
 */
export function capturePane(id, lines = 80) {
  if (!USE_TMUX) return null;
  const n = Math.max(0, Math.min(2000, lines));
  let out;
  try {
    out = execFileSync('tmux', ['capture-pane', '-p', '-S', `-${n}`, '-t', tmuxName(id)],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; } // no such session (stopped)
  // capture-pane pads the pane to its full height with blank lines; drop them so
  // a short screen doesn't arrive as 50 lines of nothing. -S already bounds the
  // scrollback, so the caller decides whether to trim the visible screen too.
  return out.replace(/\s+$/, '');
}

/** Return the last mouse selection for this session as a browser-consumable OSC 52. */
export function copySelection(id) {
  if (!USE_TMUX) return null;
  const bufferName = `am-copy-${tmuxName(id)}`;
  let text = '';
  try {
    text = execFileSync('tmux', ['save-buffer', '-b', bufferName, '-'], { encoding: 'utf8', env: TERM_ENV });
  } catch {
    try {
      text = execFileSync('tmux', ['save-buffer', '-'], { encoding: 'utf8', env: TERM_ENV });
    } catch {
      return null;
    }
  }
  if (!text) return null;
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** Stop a session entirely (kills the tmux session / the running process). */
export function stop(id) {
  // A remote agent has no process to kill — "stopped" means disconnected, so the
  // same button pauses it and closes its open polls.
  const s = list().find((x) => x.id === id);
  if (s && isRemote(s.cli)) { setPaused(s, true, 'stopped from the manager'); return; }
  if (USE_TMUX) {
    try {
      execFileSync('tmux', ['kill-session', '-t', tmuxName(id)], { stdio: 'ignore' });
    } catch {}
  } else {
    const s = live.get(id);
    if (s) for (const h of s) h.kill();
  }
}
