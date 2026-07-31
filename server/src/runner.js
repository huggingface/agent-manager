import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import fs from 'node:fs';
import { cliById, WORKSPACES_DIR } from './config.js';
import { update, list } from './sessions.js';
import { captureOpencodeSession } from './traces.js';
import { buildPaletteIndex, rowsToAnsi, snapshotToAnsi, snapshotToRows } from './snapshot.js';

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
// A resize is only worth acting on once it stops changing. ResizeObserver fires
// per animation frame while a window is dragged, and every applied size costs a
// rewrap of the outgoing screen and a full TUI repaint (see carryScreen for what
// that leaves behind). Coalescing a drag into one resize is what keeps the
// scrollback from filling with the same screen re-wrapped a dozen ways.
const RESIZE_SETTLE_MS = Number(process.env.AM_RESIZE_SETTLE_MS || 120);
// Escape hatch for carryScreen: with AM_RESIZE_CARRY=0 a resize reflows the way a
// plain terminal does, duplication and all. Kept because carrying the screen by
// hand is the one part of a resize that makes an assumption about the app.
const RESIZE_CARRY = process.env.AM_RESIZE_CARRY !== '0';
// How long an app gets to answer SIGWINCH before the rows a shrink pushed off the
// screen are treated as history rather than as a copy (see settleArchive).
// Generous on purpose: an agent TUI that debounces SIGWINCH must not be mistaken
// for one that ignored it, and waiting costs nothing a user can see because the
// rows in question are off-screen either way. A repaint that arrives sooner ends
// the wait immediately.
const ARCHIVE_SETTLE_MS = Number(process.env.AM_RESIZE_ARCHIVE_MS || 700);

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

/**
 * Re-frame a snapshot for a different geometry, so it can be painted into one.
 *
 * BOTTOM-anchored, in both directions, because that is what the emulator does on
 * its own. Growing the screen pulls history back DOWN out of scrollback to fill
 * the new rows from the top (measured: 12 rows -> 30 brought 18 lines back), so a
 * top-anchored paint lands right on top of them — which destroyed the history and
 * left the old screen stranded above the app's fresh repaint. Anchoring at the
 * bottom puts the carried screen exactly where the emulator already put it, with
 * the recovered history above it untouched.
 *
 * On a shrink the rows that fall off the top are not in here at all —
 * settleArchive decides what becomes of those.
 */
function fitSnapshot(snap, cols, rows) {
  const shift = snap.rows - rows; // > 0 shrinking, < 0 growing
  return {
    cols,
    rows,
    isAltScreen: snap.isAltScreen,
    cursorRow: Math.max(0, Math.min(rows - 1, snap.cursorRow - shift)),
    cursorCol: Math.max(0, Math.min(cols - 1, snap.cursorCol)),
    cells: (snap.cells || [])
      .filter((c) => c.row - shift >= 0 && c.row - shift < rows && c.col < cols)
      .map((c) => (shift ? { ...c, row: c.row - shift } : c)),
  };
}

/**
 * Carry the current screen across a resize by hand, instead of letting reflow do
 * it — the whole reason a resize duplicated scrollback.
 *
 * Reflow is not wrong, it is just redundant here: narrowing rewraps every row of
 * the outgoing screen (a 119-column row becomes two at 110), which scrolls the
 * excess up into scrollback — and then the app repaints that same screen, so the
 * rewrapped copy is left above it forever. Six zoom clicks, six copies.
 *
 * So the screen is cleared BEFORE the reflow, which leaves it nothing to archive,
 * and re-painted after: snapshotToAnsi positions every row absolutely and emits
 * no newline, so the paint itself cannot wrap or scroll either.
 *
 * The rows that no longer fit cannot be settled here, which took two tries to
 * see. Dropping them ate real history — a 40->24 shrink lost 16 lines a user
 * could previously scroll back to. Archiving them brought the duplication
 * straight back, because for a repainting TUI those rows ARE the screen it is
 * about to reprint. Whether they are redundant depends on what the app does
 * NEXT, so they are handed to settleArchive to decide once that is known.
 *
 * Returns { pre, ansi, dropped }: bytes for before the resize and after it (both
 * of which every viewer needs too) plus the rows in limbo. Null when reflow
 * should be left alone (see host.repaints).
 */
function carryScreen(host, cols, rows) {
  if (!RESIZE_CARRY || !host.repaints) return null;
  let snap;
  let ansi;
  try {
    snap = host.vt.snapshot({ includeCells: true });
    // Rows only, no erase: on a grow the emulator has already refilled the top of
    // the screen from scrollback, and that history has to survive this paint.
    ansi = snapshotToRows(fitSnapshot(snap, cols, rows));
  } catch { return null; }

  const drop = Math.max(0, snap.rows - rows);
  const pre = '\x1b[0m\x1b[H\x1b[2J';
  try { host.vt.feed(pre); } catch { return null; }
  return { pre, ansi, dropped: drop ? rowsToAnsi(snap, 0, drop) : [] };
}

/**
 * Put lines into scrollback without disturbing the screen.
 *
 * Printing is the only way in — there is no API for "append to history" — so the
 * lines are printed at the top and then pushed off it, and the screen is painted
 * back from the grid afterwards. Costs one repaint, which is why it only happens
 * when nothing else repainted.
 */
function archiveLines(host, lines) {
  let restore;
  try { restore = snapshotToAnsi(host.vt.snapshot({ includeCells: true })); } catch { return; }
  let bytes = '\x1b[0m\x1b[H\x1b[2J\x1b[1;1H' + lines.join('\r\n');
  // A newline on the LAST row is what moves a row into scrollback, and it moves
  // the top row — not the one just printed. Enough of them to clear the screen
  // archives every line, whether they all fitted on it or not.
  bytes += `\x1b[0m\x1b[${host.rows};1H` + '\r\n'.repeat(Math.min(lines.length, host.rows));
  bytes += restore;
  try { host.vt.feed(bytes); } catch { return; }
  for (const sub of host.subs) sub.onData(bytes);
}

/**
 * Decide what the rows a shrink pushed off the screen were: a copy, or history.
 *
 * A screenful of output within the window means the app answered SIGWINCH by
 * reprinting its screen, so those rows are about to appear again and archiving
 * them is what filled the scrollback with duplicates. Silence means they were the
 * only copy — a shell's log, a TUI that exited, an agent sitting idle — and
 * dropping them is what stopped a pane from scrolling all the way up.
 *
 * Deciding afterwards is the point: at resize time this is not yet knowable, and
 * both guesses are wrong for somebody. Waiting costs nothing visible — the rows in
 * question are off-screen either way — so the window is generous rather than tight,
 * because an agent TUI that debounces SIGWINCH must not be mistaken for one that
 * ignored it. A repaint that does arrive cancels this immediately (see onData).
 *
 * Only a session that stayed silent through TWO resizes stops being treated as
 * repainting: one slow frame would otherwise drop a Claude pane onto the plain
 * reflow path for good, which is the duplication this all started with.
 */
function settleArchive(host) {
  host.archiveTimer = null;
  const pending = host.pendingArchive;
  host.pendingArchive = null;
  if (!pending) return;
  host.silentResizes += 1;
  if (host.silentResizes >= 2) host.repaints = false;
  if (pending.length) archiveLines(host, pending);
}

/**
 * Move the session to the size its viewers imply.
 *
 * The grid is resized BEFORE the PTY: the app's SIGWINCH repaint then lands in a
 * grid that already has the new geometry, instead of one line of its frame being
 * measured against the old one.
 *
 * Every viewer is then repainted from the grid. A resize is the one moment the
 * browser's own reflow of its byte log is guaranteed to disagree with us, and an
 * app that doesn't repaint on SIGWINCH at all (a bash prompt, an agent sitting
 * idle) would otherwise leave that disagreement on screen until it next drew
 * something. Repainting from the grid costs one screen of bytes and makes the
 * pane authoritative again — the same argument as the repaint on attach.
 */
function applyGrid(host) {
  const { cols, rows } = effectiveGrid(host);
  if (cols === host.cols && rows === host.rows) return false;
  // Only a screen that gets SMALLER in some dimension archives anything: rows are
  // pushed off the top, or a narrower width rewraps them until they overflow. A
  // screen that only grows takes rows back out of scrollback instead, and needs no
  // help doing it — interfering there is what painted over the history a zoom-out
  // had just recovered. So growing is left entirely alone, right down to not
  // repainting: each emulator recovers its own rows, and the app's own repaint (or
  // the next attach) settles any difference.
  const shrinking = cols < host.cols || rows < host.rows;
  host.cols = cols;
  host.rows = rows;
  const carried = shrinking ? carryScreen(host, cols, rows) : null;
  // Viewers get the erase BEFORE they resize, in the same order the grid saw it,
  // so their emulators skip the same reflow ours did.
  if (carried) for (const sub of host.subs) sub.onData(carried.pre);
  try { host.vt.resize(cols, rows); } catch {}
  try { host.pty.resize(cols, rows); } catch {}
  host.resizedAt = Date.now();
  host.resizeBytes = 0;
  if (carried) {
    // Painted straight away, not deferred. Holding it back until the app had its
    // say was tried, on the theory that an app reprinting its own frame makes our
    // copy redundant — measured, it changes nothing, because such an app erases
    // the screen before it prints. All deferring bought was a blank pane.
    try { host.vt.feed(carried.ansi); } catch {}
    for (const sub of host.subs) sub.onData(carried.ansi);
    // Oldest first: a second resize before the verdict lands adds to the same
    // batch rather than replacing it.
    host.pendingArchive = [...(host.pendingArchive || []), ...carried.dropped];
    if (host.archiveTimer) clearTimeout(host.archiveTimer);
    host.archiveTimer = setTimeout(() => settleArchive(host), ARCHIVE_SETTLE_MS);
    if (host.archiveTimer.unref) host.archiveTimer.unref();
  }
  let ansi = null;
  if (!carried && shrinking) { try { ansi = snapshotToAnsi(host.vt.snapshot({ includeCells: true })); } catch {} }
  for (const sub of host.subs) {
    // `carried` doubles as the flag: the viewer's own emulator has to skip its
    // reflow exactly when we skipped ours, or it archives what we did not — and it
    // must not resize until the bytes above have been parsed at the OLD size.
    sub.onGrid(cols, rows, host.subs.size > 1, host.subs.size, !!carried);
    if (ansi) sub.onData(ansi);
  }
  return true;
}

/**
 * Apply the grid once the requests stop arriving. The viewers that asked are
 * remembered so a request the grid can't honour (a big laptop attached beside a
 * phone) is still answered with the size that actually applies — a client that
 * hears nothing back would sit there drawing into a geometry it doesn't have.
 */
function scheduleGrid(host, sub) {
  if (sub) host.pendingSizes.add(sub);
  if (host.gridTimer) clearTimeout(host.gridTimer);
  host.gridTimer = setTimeout(() => {
    host.gridTimer = null;
    const pending = [...host.pendingSizes];
    host.pendingSizes.clear();
    if (applyGrid(host)) return; // applyGrid told everyone
    for (const s of pending) {
      if (host.subs.has(s)) s.onGrid(host.cols, host.rows, host.subs.size > 1, host.subs.size);
    }
  }, RESIZE_SETTLE_MS);
  if (host.gridTimer.unref) host.gridTimer.unref();
}

// ---------- Codex conversation pinning ----------
// Codex picks its own conversation id at launch and doesn't accept one up
// front — but it announces the pick immediately: a rollout file named
// rollout-<ts>-<id>.jsonl appears under $CODEX_HOME/sessions with the cwd in
// its first line. Capture that id shortly after launch and pin it on the
// session, so restarts resume THIS agent's conversation — `resume --last`
// would grab whichever Codex agent in the same folder ran last.
const codexCapturing = new Set(); // session ids with a capture in flight

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

function scheduleCodexCapture(session, workdir) {
  if (session.codexSessionId && pinIsStale(session)) {
    session = update(session.id, { codexSessionId: undefined, codexRollout: undefined }) || session;
  }
  if (session.codexSessionId || codexCapturing.has(session.id)) return;
  codexCapturing.add(session.id);
  const since = Date.now() - 2000;
  const delays = [5000, 15000, 45000]; // rollout appears ~instantly; retries cover slow starts
  const attempt = (i) => {
    if (tryCaptureCodexId(session.id, workdir, since) || i + 1 >= delays.length) {
      codexCapturing.delete(session.id);
      return;
    }
    const t = setTimeout(() => attempt(i + 1), delays[i + 1] - delays[i]);
    if (t.unref) t.unref();
  };
  const t0 = setTimeout(() => attempt(0), delays[0]);
  if (t0.unref) t0.unref();
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
// So verify the pin after launch the same way codex/opencode capture theirs, and
// re-pin to the transcript Claude actually wrote. Observed live on a test Space:
// session pinned 4efced14…, transcript on disk cb22b656….
const claudeCapturing = new Set();

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

function scheduleClaudeCapture(session, workdir) {
  if (claudeCapturing.has(session.id)) return;
  claudeCapturing.add(session.id);
  const since = Date.now() - 2000;
  const delays = [5000, 15000, 45000, 90000];
  const attempt = (i) => {
    // The pin is fine as soon as a matching transcript exists — the common case.
    if (transcriptExists(session.sessionUuid)) { claudeCapturing.delete(session.id); return; }

    const claimed = new Set(list().filter((s) => s.id !== session.id && s.sessionUuid).map((s) => s.sessionUuid));
    for (const c of claudeTranscriptsSince(since)) {
      const uuid = path.basename(c.p).replace(/\.jsonl$/, '');
      if (claimed.has(uuid)) continue;
      // The cwd is NOT on the first line: a transcript opens with metadata lines
      // (mode, permission-mode, file-history-snapshot, ai-title, worktree-state)
      // that have no cwd, and only the conversation lines carry one — line 4 or 5
      // in every real transcript measured. Reading line 1 made this check always
      // fail, so the re-pin could never actually claim anything.
      const head = transcriptHead(c.p);
      // Only claim a conversation started in THIS session's folder.
      if (!head || head.cwd !== workdir) continue;
      const created = Date.parse(head.timestamp || '') || 0;
      if (created && created < since - 15_000) continue; // someone else's older thread
      console.warn(`[claude] re-pinning ${session.id}: ${session.sessionUuid} -> ${uuid} (--session-id was not honoured)`);
      update(session.id, { sessionUuid: uuid });
      claudeCapturing.delete(session.id);
      return;
    }
    if (i + 1 >= delays.length) { claudeCapturing.delete(session.id); return; }
    const t = setTimeout(() => attempt(i + 1), delays[i + 1] - delays[i]);
    if (t.unref) t.unref();
  };
  const t0 = setTimeout(() => attempt(0), delays[0]);
  if (t0.unref) t0.unref();
}

const opencodeCapturing = new Set();
function scheduleOpencodeCapture(session, workdir) {
  if (session.opencodeSessionId || opencodeCapturing.has(session.id)) return;
  opencodeCapturing.add(session.id);
  const since = Date.now() - 2000;
  const delays = [3000, 8000, 20000, 45000, 90000];
  const attempt = (i) => {
    const claimed = new Set(list().filter((s) => s.id !== session.id && s.opencodeSessionId).map((s) => s.opencodeSessionId));
    const hit = captureOpencodeSession(workdir, since, claimed);
    if (hit) { update(session.id, { opencodeSessionId: hit.id }); opencodeCapturing.delete(session.id); return; }
    if (i + 1 >= delays.length) { opencodeCapturing.delete(session.id); return; }
    const t = setTimeout(() => attempt(i + 1), delays[i + 1] - delays[i]);
    if (t.unref) t.unref();
  };
  const t0 = setTimeout(() => attempt(0), delays[0]);
  if (t0.unref) t0.unref();
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
  const isShell = (cliById(session.cli) || cliById('shell')).id === 'shell';

  const host = {
    id: session.id,
    pty: term,
    vt,
    cols,
    rows,
    // Does this app reprint its screen after SIGWINCH? That decides whether the
    // reflow on resize archives a duplicate of the screen or archives the log
    // (see carryScreen). Every agent TUI repaints; a shell prompt does not, and
    // its rewrapped scrollback is the real thing, not a copy. The guess is
    // corrected below, because `vim` or a hand-typed `claude` breaks it.
    repaints: !isShell,
    resizedAt: 0,
    resizeBytes: 0,
    pendingArchive: null,
    archiveTimer: null,
    silentResizes: 0,
    subs: new Set(),
    sizes: new Map(), // sub -> the grid that viewer can display
    pendingSizes: new Set(), // subs whose request hasn't been answered yet
    gridTimer: null,
    history: [],
    historyBytes: 0,
    historyDropped: false,
    startedAt: Date.now(),
    screenChangedAt: Date.now(),
    bells: 0,
  };

  term.onData((chunk) => {
    try { vt.feed(chunk); } catch (e) { console.error('[runner] vt.feed', e && e.message); }

    // A screenful arriving after a resize means the app answered SIGWINCH by
    // reprinting its screen. That settles the question settleArchive was waiting on
    // — the rows it holds are about to be printed again, so archiving them would
    // duplicate them — and it settles it NOW, whenever the frame happens to arrive,
    // instead of when a timer says so.
    if (host.resizedAt) {
      if (Date.now() - host.resizedAt > ARCHIVE_SETTLE_MS + 150) host.resizedAt = 0;
      else {
        host.resizeBytes += chunk.length;
        // A quarter screen of bytes is far more than a shell prompt redrawing
        // itself and far less than a TUI frame.
        if (host.resizeBytes > (host.cols * host.rows) / 4) {
          host.resizedAt = 0;
          host.repaints = true; // also catches `vim` or a hand-typed `claude` in a shell pane
          host.silentResizes = 0;
          host.pendingArchive = null; // a copy after all
          if (host.archiveTimer) { clearTimeout(host.archiveTimer); host.archiveTimer = null; }
        }
      }
    }

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
    if (host.gridTimer) { clearTimeout(host.gridTimer); host.gridTimer = null; }
    if (host.archiveTimer) { clearTimeout(host.archiveTimer); host.archiveTimer = null; }
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
    onGrid: (cb) => { sub.onGrid = (c, r, shared, viewers, clear) => { try { cb(c, r, shared, viewers, clear); } catch {} }; },
    write: (d) => { try { host.pty.write(d); } catch {} },
    // A request, not a command: the shared grid is recomputed from all viewers,
    // and only once the requests settle.
    resize: (c, r) => {
      if (!Number.isFinite(c) || !Number.isFinite(r)) return;
      const want = {
        cols: Math.max(20, Math.min(400, Math.round(c))),
        rows: Math.max(5, Math.min(200, Math.round(r))),
      };
      const had = host.sizes.get(sub);
      host.sizes.set(sub, want);
      // A resync that changes nothing (tab focus, an unrelated pane opening) must
      // not schedule anything — but the FIRST request from a viewer is always
      // worth answering, so it learns the grid it joined.
      if (had && had.cols === want.cols && had.rows === want.rows) return;
      scheduleGrid(host, sub);
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
        shared: host.subs.size > 1,
      };
    },
    // Detach this viewer only. The session, its grid and its scrollback stay.
    kill: () => {
      host.subs.delete(sub);
      host.sizes.delete(sub);
      host.pendingSizes.delete(sub);
      scheduleGrid(host); // the grid grows back for whoever is left
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
