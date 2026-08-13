import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pty from 'node-pty';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { remoteState, setPaused } from './remote.js';
import { cliById, isRemote, PORT, STATE_DIR, WORKSPACES_DIR } from './config.js';
import { update, list } from './sessions.js';
import { captureOpencodeSession, opencodeSessionExists, opencodeSessionInfo, readTrace } from './traces.js';
import {
  buildPaletteIndex, snapshotToRestoreAnsi, styledSnapshotLines, textColumns,
} from './snapshot.js';
import {
  createTerminalHistoryCheckpoint, loadTerminalHistory, TERMINAL_HISTORY_VERSION,
  traceHistoryLines,
} from './history-store.js';
import { createTerminalModeTracker } from './terminal-modes.js';

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
//   * a browser attaching gets canonical history plus a snapshot repaint,
//     instead of asking tmux to redraw and hoping the agent's TUI cooperates;
//   * several browsers can watch the same session, with one explicit input/size
//     controller instead of a one-device-at-a-time disconnect handover;
//   * agent state is a property read rather than a `tmux capture-pane`
//     subprocess per session per poll.
//
// PTYs still end with this process, but canonical scrollback is checkpointed to
// durable storage below and rejoined with the CLI's resumed screen on relaunch.

// Rendered text unchanged for this long means the agent isn't working.
const BUSY_SECS = 4;
// Re-rendering the grid to text on every chunk during a burst is wasteful.
const SAMPLE_THROTTLE_MS = 250;
// Despite the Node wrapper's `scrollbackLimit` name, Ghostty's native option is
// a byte budget. Passing a line count such as 20,000 retains only a small native
// allocation (about 700 ordinary rows). Keep the unit explicit at our boundary.
const DEFAULT_SCROLLBACK_BYTES = 64 * 1024 * 1024;
const configuredScrollback = process.env.AM_SCROLLBACK_BYTES === undefined
  ? Number.NaN
  : Number(process.env.AM_SCROLLBACK_BYTES);
const SCROLLBACK_BYTES = Number.isFinite(configuredScrollback) && configuredScrollback >= 0
  ? configuredScrollback
  : DEFAULT_SCROLLBACK_BYTES;
// A layout resize is only worth acting on once it stops changing. ResizeObserver
// fires per animation frame while a window is dragged; coalescing that burst
// avoids repeatedly reflowing the terminal and repeatedly sending SIGWINCH.
const RESIZE_SETTLE_MS = Number(process.env.AM_RESIZE_SETTLE_MS || 120);
// Primary-screen agent TUIs redraw their whole frame after SIGWINCH. Let that
// burst settle in a scratch emulator, then merge its final frame once; streaming
// the raw redraw would turn every overflow row into duplicate history.
const RESIZE_CAPTURE_IDLE_MS = Number(process.env.AM_RESIZE_CAPTURE_IDLE_MS || 80);
const RESIZE_CAPTURE_MAX_MS = Number(process.env.AM_RESIZE_CAPTURE_MAX_MS || 900);
// A resumed agent paints through the same primary-screen protocol as a resize,
// but may pause for seconds between its welcome frame and replayed transcript.
// Keep that transaction distinct from the deliberately short resize debounce:
// committing its first chunk makes every later chunk look like new history.
const STARTUP_CAPTURE_IDLE_MS = Number(process.env.AM_STARTUP_CAPTURE_IDLE_MS || 5000);
const STARTUP_CAPTURE_MAX_MS = Number(process.env.AM_STARTUP_CAPTURE_MAX_MS || 20000);
// Unlike the PTY process, /data survives a Space rebuild. Checkpoint canonical
// scrollback there so deploys and sleeps do not turn a resumed agent into a
// terminal with only its freshly repainted viewport.
const HISTORY_SAVE_MS = Number(process.env.AM_HISTORY_SAVE_MS || 5000);
const HISTORY_DIR = path.join(STATE_DIR, 'terminal-history');
// Claude's resume stream can pause between its welcome frame and replayed
// conversation. Treat that as one startup transaction; hydrating during the
// pause would seed a turn that Claude is about to print itself.
const TRACE_HYDRATE_IDLE_MS = Number(process.env.AM_TRACE_HYDRATE_IDLE_MS || 5000);
const TRACE_HYDRATE_MIN_MS = Number(process.env.AM_TRACE_HYDRATE_MIN_MS || 3000);
// Bound untrusted WebSocket geometry without imposing the old 400x200 ceiling,
// which left visible dead space on high-DPI displays at low zoom levels.
const MIN_COLS = 20;
const MIN_ROWS = 5;
const MAX_COLS = 1000;
const MAX_ROWS = 500;

const hosts = new Map(); // session id -> host
const stopping = new Set();

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export function isRunning(id) {
  return hosts.has(id) && !stopping.has(id);
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
// A PTY has exactly one geometry. One attached viewer therefore holds a size
// lease (the controller); every other viewer watches the same grid without
// changing it. A watcher can take the lease through an explicit interaction.
// This prevents a phone or background tab from resizing a desktop session merely
// by connecting.

function effectiveGrid(host) {
  return host.controller?.want || { cols: host.cols, rows: host.rows };
}

function preferredGrid(cols, rows, fallback) {
  const c = Number.isFinite(cols) ? Math.round(cols) : fallback.cols;
  const r = Number.isFinite(rows) ? Math.round(rows) : fallback.rows;
  return {
    cols: Math.max(MIN_COLS, Math.min(MAX_COLS, c)),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, r)),
  };
}

function notifyGrid(host, reset = false) {
  for (const sub of host.subs) {
    sub.onGrid(host.cols, host.rows, host.controller === sub, host.subs.size, reset);
  }
}

function clearCaptureTimers(txn) {
  if (txn.idleTimer) clearTimeout(txn.idleTimer);
  if (txn.maxTimer) clearTimeout(txn.maxTimer);
  txn.idleTimer = null;
  txn.maxTimer = null;
}

function logicalText(lines, cols) {
  let text = '';
  for (let line = 0; line < lines.length; line++) {
    const row = lines[line].text || '';
    text += row;
    // A full terminal row is a soft wrap. Do not insert whitespace: Claude's
    // words can be split at an arbitrary column between snapshots. A shorter
    // row ended with a real line break, which must remain part of the overlap.
    if (textColumns(row) < cols) {
      text += '\n';
    }
  }
  return text;
}

function logicalHistory(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => ({ text: line }));
}

function visibleRows(vt) {
  try { return vt.getVisibleText().split('\n').map((text) => ({ text })); } catch { return []; }
}

function longestPrefixOccurrence(pattern, text) {
  const prefix = new Array(pattern.length).fill(0);
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched && pattern[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (pattern[i] === pattern[matched]) matched++;
    prefix[i] = matched;
  }
  let matched = 0, best = 0, bestEnd = -1;
  for (let i = 0; i < text.length; i++) {
    while (matched && text[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (text[i] === pattern[matched]) matched++;
    if (matched > best) { best = matched; bestEnd = i; }
    if (matched === pattern.length) matched = prefix[matched - 1];
  }
  return { length: best, end: bestEnd };
}

/**
 * Merge a primary-screen repaint into the fullest transcript seen so far.
 *
 * A growing pane can reveal an archived suffix after a fresh welcome/header,
 * so the overlap may occur inside the repaint rather than at its first byte.
 * Searching the reversed strings finds the longest archive suffix anywhere in
 * the repaint in linear time. The repaint prefix is inserted before that
 * suffix, preserving a header without retaining two copies of the turns.
 */
export function mergeRepaintArchive(base, repaint) {
  if (!base) return repaint;
  if (!repaint) return base;
  if (!base.trim()) return repaint;
  if (!repaint.trim()) return base;
  const reverse = (text) => {
    let result = '';
    for (let i = text.length - 1; i >= 0; i--) result += text[i];
    return result;
  };
  // Shape 1: an archive suffix is revealed after a freshly painted header.
  const suffix = longestPrefixOccurrence(
    reverse(base.slice(-repaint.length)), reverse(repaint),
  );
  // Shape 2: the repaint starts in the archive, then replaces its volatile
  // footer (dimensions, status line, prompt chrome) with the new one.
  const prefix = longestPrefixOccurrence(repaint.slice(0, base.length), base);
  const minimum = Math.min(12, base.trim().length, repaint.trim().length);
  if (Math.max(suffix.length, prefix.length) < minimum) return base + repaint;
  if (prefix.length > suffix.length) {
    const baseOffset = prefix.end - prefix.length + 1;
    return base.slice(0, baseOffset) + repaint;
  }
  const repaintOffset = repaint.length - 1 - suffix.end;
  return repaint.slice(0, repaintOffset) + base
    + repaint.slice(repaintOffset + suffix.length);
}

/**
 * Replace the archive's old visible tail with a new repaint.
 *
 * Resize output is presentation, never appended terminal output. Match the
 * longest prefix of the new visible grid inside the archive; everything before
 * that point is the hidden prefix, and the new grid replaces everything after
 * it (including dimension-dependent status/footer text).
 */
export function repaintArchiveView(archive, visible, fallbackHistory = '') {
  if (!visible) return { archive, history: logicalHistory(archive) };
  const leading = visible.match(/^(?:[ \t]*\n)*/)?.[0].length || 0;
  const candidate = visible.slice(leading);
  let match = candidate ? longestPrefixOccurrence(candidate, archive) : { length: 0, end: -1 };

  // A few shared characters are not a safe repaint boundary in a substantial
  // screen. Claude's randomized status lines, for example, all begin with
  // "Worked for ". Anchoring a fresh screen there can retain the old turn that
  // precedes a later status line, then append that same turn again. Require a
  // meaningful overlap for long screens, while still accepting complete short
  // prompts in small panes.
  const archiveContentLength = archive.trim().length;
  const confidence = (tail) => Math.min(
    64,
    archiveContentLength,
    Math.max(12, Math.floor(tail.trim().length / 2)),
  );
  let minimum = confidence(candidate);

  // A repaint may start with one volatile row before its stable transcript.
  // If the first row offers only a weak match, advance by logical lines until
  // the first substantial overlap is found. The visible grid is bounded to 500
  // rows, and the cap keeps a maliciously fragmented screen from repeatedly
  // scanning a large archive.
  if (match.length < minimum) {
    let offset = 0;
    for (let attempts = 0; attempts < 32;) {
      const newline = candidate.indexOf('\n', offset);
      if (newline < 0) break;
      offset = newline + 1;
      const tail = candidate.slice(offset);
      if (!tail.trim()) break;
      const nextBreak = tail.indexOf('\n');
      const firstLine = tail.slice(0, nextBreak < 0 ? undefined : nextBreak);
      if (firstLine.trim().length < 12) continue;
      attempts++;
      const next = longestPrefixOccurrence(tail, archive);
      const nextMinimum = confidence(tail);
      if (next.length >= nextMinimum) {
        match = next;
        minimum = nextMinimum;
        break;
      }
    }
  }
  let history = fallbackHistory;
  if (match.length >= minimum && minimum > 0) {
    const archiveOffset = match.end - match.length + 1;
    history = archive.slice(0, archiveOffset);
  }
  return { archive: history + visible, history: logicalHistory(history) };
}

function terminalArchive(vt, snap) {
  return logicalText([...(snap.scrollbackLines || []), ...visibleRows(vt)], snap.cols);
}

const MAX_HISTORY_STYLES = 50_000;

function learnHistoryStyles(host, vt, snap) {
  if (!host.historyStyles || typeof vt.formatHtml !== 'function') return;
  const visibleHasStyle = (snap.cells || []).some((cell) => cell.bold || cell.italic
    || cell.underline || cell.foreground || cell.background);
  if (!visibleHasStyle && host.historyStyles.size === 0) return;
  let styled;
  try { styled = styledSnapshotLines(snap, vt.formatHtml()); } catch { return; }
  for (const line of [...styled.rows, ...styled.logical]) {
    if (!line.text || !line.ansi) continue;
    // Refresh insertion order so frequently repainted transcript rows survive
    // the bounded cache while old one-off status lines age out.
    host.historyStyles.delete(line.text);
    host.historyStyles.set(line.text, line.ansi);
  }
  while (host.historyStyles.size > MAX_HISTORY_STYLES) {
    host.historyStyles.delete(host.historyStyles.keys().next().value);
  }
}

function withHistoryStyles(host, lines) {
  return (lines || []).map((line) => {
    const ansi = line.ansi || host.historyStyles?.get(line.text || '');
    return ansi ? { ...line, ansi } : line;
  });
}

function styledSnapshot(host, vt, snap) {
  learnHistoryStyles(host, vt, snap);
  return { ...snap, scrollbackLines: withHistoryStyles(host, snap.scrollbackLines) };
}

// A Ghostty snapshot restores the rendered grid. Append the interaction modes
// observed on the PTY so a newly attached xterm also behaves like the terminal
// that saw the TUI start (mouse reporting, bracketed paste, cursor-key mode…).
function viewerRestoreAnsi(host, vt, snap) {
  return snapshotToRestoreAnsi(styledSnapshot(host, vt, snap))
    + host.terminalModes.restoreAnsi();
}

/**
 * Commit one captured agent repaint without duplicating its overflow rows.
 *
 * The pre-resize scrollback boundary and final repaint are merged once, then
 * both the server terminal and every viewer are restored from that same state.
 * Shell sessions never use this path.
 */
function finishCapturedGrid(host, txn) {
  if (host.resizeCapture !== txn) return;
  host.resizeCapture = null;
  clearCaptureTimers(txn);

  let snap = null;
  let replacement = null;
  let committedArchive = null;
  if (txn.sawData) {
    try { snap = txn.vt.snapshot({ includeCells: true, includeScrollback: true }); } catch {}
    if (snap) {
      try {
        learnHistoryStyles(host, txn.vt, snap);
        const visible = visibleRows(txn.vt);
        const visibleText = logicalText(visible, txn.cols);
        const view = repaintArchiveView(txn.archive, visibleText, txn.fallbackHistory);
        committedArchive = view.archive;
        replacement = ghostty.createTerminal({
          cols: txn.cols,
          rows: txn.rows,
          scrollbackLimit: SCROLLBACK_BYTES,
        });
        replacement.feed(snapshotToRestoreAnsi({
          ...snap, scrollbackLines: withHistoryStyles(host, view.history),
        }));
      } catch (error) {
        console.error('[runner] resize capture commit', error && error.message);
        try { replacement?.dispose(); } catch {}
        replacement = null;
        snap = null;
      }
    }
  }

  try {
    if (!snap) {
      // The foreground process ignored SIGWINCH. Ordinary reflow is the only
      // faithful outcome because no repaint exists to replace the old screen.
      host.vt.resize(txn.cols, txn.rows);
      host.cols = txn.cols;
      host.rows = txn.rows;
      host.repaintArchive = null;
      notifyGrid(host, false);
    } else {
      const previous = host.vt;
      host.vt = replacement;
      host.cols = txn.cols;
      host.rows = txn.rows;
      // The archive retains the full transcript even when a wide grid exposes
      // all of it and therefore needs no scrollback. A later narrow repaint can
      // derive the hidden prefix again instead of losing the oldest rows.
      host.repaintArchive = committedArchive;
      // Reset and restore one canonical snapshot. Keeping a browser's old
      // scrollback while painting only the new viewport makes the two models
      // diverge after a narrow zoom, even when the server history is correct.
      notifyGrid(host, true);
      const committed = host.vt.snapshot({ includeCells: true, includeScrollback: true });
      const ansi = viewerRestoreAnsi(host, host.vt, committed);
      for (const sub of host.subs) sub.onData(ansi);
      try { previous.dispose(); } catch {}
      sampleScreen(host);
    }
  } finally {
    try { txn.vt.dispose(); } catch {}
  }
  host.historyCheckpoint.schedule();

  // A newer controller preference may have arrived while the repaint settled.
  const next = effectiveGrid(host);
  if (next.cols !== host.cols || next.rows !== host.rows) scheduleGrid(host);
}

function armCapturedGrid(host, txn) {
  if (txn.idleTimer) clearTimeout(txn.idleTimer);
  txn.idleTimer = setTimeout(() => finishCapturedGrid(host, txn), txn.idleMs);
  if (txn.idleTimer.unref) txn.idleTimer.unref();
}

/** Start or supersede the bounded repaint transaction for an agent TUI. */
function startCapturedGrid(host, cols, rows, seed = null, resizePty = true) {
  const previous = host.resizeCapture;
  // A viewer can report its measured geometry before the resumed CLI emits
  // its first byte. That resize is still part of startup, so claim the durable
  // seed here rather than leaving it for a later output chunk.
  const pendingStartup = !seed && !previous ? host.startupHistory : null;
  if (pendingStartup) {
    seed = {
      history: pendingStartup.lines,
      historyCols: pendingStartup.cols,
      logical: true,
    };
  }
  // Resizing during a startup capture supersedes its scratch grid, but must not
  // downgrade its long idle window to the ordinary resize debounce. Otherwise
  // a delayed resume repaint is committed later as duplicate terminal output.
  const startupCapture = !!seed || !!previous?.startupCapture;
  let archive = seed?.history
    ? (seed.logical
      ? `${seed.history.map((line) => line.text || '').join('\n')}\n`
      : logicalText(seed.history, seed.historyCols || host.cols))
    : host.repaintArchive;
  let fallbackHistory = seed?.history ? archive : null;
  if (previous) {
    archive = previous.archive;
    fallbackHistory = previous.fallbackHistory;
    host.resizeCapture = null;
    clearCaptureTimers(previous);
    try { previous.vt.dispose(); } catch {}
  }
  try {
    const source = host.vt.snapshot({ includeScrollback: true });
    if (archive == null) {
      archive = terminalArchive(host.vt, source);
    }
    if (fallbackHistory == null) {
      fallbackHistory = logicalText(source.scrollbackLines || [], source.cols);
    }
  } catch { return false; }

  let scratch;
  try {
    scratch = ghostty.createTerminal({ cols, rows, scrollbackLimit: 4 * 1024 * 1024 });
  } catch (error) {
    console.error('[runner] resize capture setup', error && error.message);
    try { scratch?.dispose(); } catch {}
    return false;
  }

  const txn = {
    vt: scratch,
    cols,
    rows,
    archive: archive || '',
    fallbackHistory: fallbackHistory || '',
    sawData: false,
    startupCapture,
    idleMs: startupCapture ? STARTUP_CAPTURE_IDLE_MS : RESIZE_CAPTURE_IDLE_MS,
    maxMs: startupCapture ? STARTUP_CAPTURE_MAX_MS : RESIZE_CAPTURE_MAX_MS,
    idleTimer: null,
    maxTimer: null,
  };
  host.resizeCapture = txn;
  if (pendingStartup) host.startupHistory = null;
  if (resizePty) { try { host.pty.resize(cols, rows); } catch {} }
  txn.maxTimer = setTimeout(() => finishCapturedGrid(host, txn), txn.maxMs);
  if (txn.maxTimer.unref) txn.maxTimer.unref();
  return true;
}

/**
 * Move the session to the size its viewers imply.
 *
 * Shells use ordinary reflow: every row is real output. Known agent TUIs on the
 * primary screen instead use a bounded scratch transaction because their full
 * SIGWINCH redraw is presentation, not new history. Alternate-screen programs
 * are already isolated from primary scrollback and use ordinary resize.
 */
function applyGrid(host) {
  const { cols, rows } = effectiveGrid(host);
  if (!host.resizeCapture && cols === host.cols && rows === host.rows) return false;
  if (host.captureResize) {
    let alt = false;
    try { alt = !!host.vt.snapshot().isAltScreen; } catch {}
    if (!alt && startCapturedGrid(host, cols, rows)) return true;
  }
  host.cols = cols;
  host.rows = rows;
  try { host.vt.resize(cols, rows); } catch {}
  // Put the geometry frame on every viewer's ordered WebSocket stream before
  // SIGWINCH can make the foreground application repaint at the new size.
  // Otherwise those repaint bytes may be interpreted using the old grid and
  // leave duplicated or displaced rows in the browser emulator.
  notifyGrid(host, false);
  try { host.pty.resize(cols, rows); } catch {}
  return true;
}

/**
 * Apply the controller's preferred grid once requests stop arriving. If a
 * pending request clamps back to the current size, report that canonical size.
 */
function scheduleGrid(host) {
  if (host.gridTimer) clearTimeout(host.gridTimer);
  host.gridTimer = setTimeout(() => {
    host.gridTimer = null;
    if (!applyGrid(host)) notifyGrid(host, false);
  }, RESIZE_SETTLE_MS);
  if (host.gridTimer.unref) host.gridTimer.unref();
}

function armTraceHydration(host) {
  if (!host.traceHistoryPage || host.traceHistoryTimer) return;
  const readyAt = Math.max(
    host.startedAt + TRACE_HYDRATE_MIN_MS,
    (host.lastOutputAt || host.startedAt) + TRACE_HYDRATE_IDLE_MS,
    host.resizeCapture ? Date.now() + TRACE_HYDRATE_IDLE_MS : 0,
  );
  host.traceHistoryTimer = setTimeout(() => {
    host.traceHistoryTimer = null;
    if (hosts.get(host.id) !== host || !host.traceHistoryPage) return;
    if (host.resizeCapture || Date.now() < readyAt) { armTraceHydration(host); return; }

    let snap;
    try { snap = host.vt.snapshot({ includeCells: true, includeScrollback: true }); } catch { return; }
    const visible = visibleRows(host.vt);
    const visibleText = logicalText(visible, snap.cols);
    const currentText = visible.map((line) => line.text || '').join('\n');
    const recovered = traceHistoryLines(host.traceHistoryPage, currentText);
    host.traceHistoryPage = null;
    learnHistoryStyles(host, host.vt, snap);

    let replacement = null;
    try {
      // The trace supplies missing older turns while the settled startup grid
      // supplies the welcome and the newest live turn. Merge their overlap
      // into one archive rather than appending either presentation verbatim.
      const startup = terminalArchive(host.vt, snap);
      const archive = mergeRepaintArchive(logicalText(recovered, snap.cols), startup);
      const view = repaintArchiveView(archive, visibleText);
      replacement = ghostty.createTerminal({
        cols: host.cols, rows: host.rows, scrollbackLimit: SCROLLBACK_BYTES,
      });
      replacement.feed(snapshotToRestoreAnsi({
        ...snap,
        scrollbackLines: withHistoryStyles(host, view.history),
      }));
      const previous = host.vt;
      host.vt = replacement;
      host.repaintArchive = view.archive;
      notifyGrid(host, true);
      const committed = host.vt.snapshot({ includeCells: true, includeScrollback: true });
      const ansi = viewerRestoreAnsi(host, host.vt, committed);
      for (const sub of host.subs) sub.onData(ansi);
      try { previous.dispose(); } catch {}
      sampleScreen(host);
      host.historyCheckpoint.schedule();
    } catch (error) {
      console.error('[runner] trace history restore', error && error.message);
      try { replacement?.dispose(); } catch {}
    }
  }, Math.max(0, readyAt - Date.now()));
  if (host.traceHistoryTimer.unref) host.traceHistoryTimer.unref();
}

async function hydrateTraceHistory(session, host) {
  try {
    let page = await readTrace(session, { offset: 0, limit: 500 });
    if (page.total > page.turns.length) {
      page = await readTrace(session, { offset: Math.max(0, page.total - 500), limit: 500 });
    }
    if (hosts.get(host.id) !== host) return;
    host.traceHistoryPage = page;
    armTraceHydration(host);
  } catch {
    // A new/onboarding session may not have a trace yet; live output remains
    // authoritative and its first checkpoint will become the durable seed.
  }
}

// ---------- whose folder is this conversation in? ----------
// Every pin path asks the same question of a candidate conversation: was it
// started by THIS pane? The answer is the folder it was born in — and a pane's
// folder is a tree, not one directory.
//
// This used to be `cwd === workdir`, and that quietly broke every agent that
// works in a git worktree. The PTY starts in the session's folder, the agent
// then enters `.claude/worktrees/<name>` (or just cd's somewhere below), and the
// conversation a later `/clear` starts records that DEEPER cwd. Equality
// rejected it from both directions — the SessionStart crumb as 'cwd mismatch',
// the transcript scan by skipping the file — so the pin stayed on the abandoned
// conversation for the rest of the pane's life. The reader kept showing the
// pre-/clear thread while the terminal showed the new one, and the next launch
// would `--resume` the old id and discard everything since. Observed live:
// session claude-code-4 pinned edbfc11f… while claude wrote b1e23587… in
// /data/workspaces/Agent-manager/.claude/worktrees/session-sharing.
//
// Containment, not prefix matching: `/w/proj-a2` must not count as inside
// `/w/proj-a`. Exported for server/test/repin.test.mjs.
export function cwdUnderWorkdir(cwd, workdir) {
  if (typeof cwd !== 'string' || !cwd || typeof workdir !== 'string' || !workdir) return false;
  const rel = path.relative(path.resolve(workdir), path.resolve(cwd));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// ---------- Codex conversation pinning ----------
// Codex picks its own conversation id at launch and doesn't accept one up
// front. The managed SessionStart hook below is the primary source of its exact
// choice. This rollout discovery remains the fallback: a file named
// rollout-<ts>-<id>.jsonl appears under $CODEX_HOME/sessions with the cwd in
// its first line, so an unshared pane can still recover when hooks are absent.
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
//
// Async for the same reason as claudeTranscriptsSince, and it is the same bug:
// this is a readdir per day-directory plus a stat per rollout, and although
// CODEX_HOME is on local disk, its `sessions` child is a SYMLINK onto the FUSE
// bucket — `stat -f` says fuseblk, and `find` without -L will tell you the
// directory is empty, which is how this hid. A stat there costs ~85ms, so the
// sync version froze every pane in the Space for 400-750ms on the REPIN_MS beat,
// once per codex session. Measured: stalls >250ms at 2.5/min, worst 3.9s.
//
// Sequential rather than Promise.all, exactly as in claudeTranscriptsSince:
// parallel FUSE stats would saturate the 4-thread libuv pool and push every
// other fs operation in the process behind them, and nothing here is waiting on
// the result.
// Exported for server/test/codex-repin.test.mjs.
export async function codexRolloutsSince(sinceMs) {
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { const m = (await fsp.stat(p)).mtimeMs; if (m >= sinceMs) out.push({ p, m }); } catch {}
      }
    }
  };
  await walk(codexSessionsRoot(), 0);
  return out.sort((a, b) => b.m - a.m);
}

// First line of a (potentially large) file without reading all of it. Codex's
// session_meta line carries the full embedded instruction text (~22KB as of
// 0.142), so read in chunks until the newline — a fixed small buffer would
// truncate the JSON and make every capture silently fail.
// The first line of a transcript that records a `cwd`, with its timestamp.
// Bounded on lines AND bytes: a file-history-snapshot line can be megabytes.
// Async, like the rest of the claude scan: every read here is against the FUSE
// bucket, where a cold one costs tens of ms, and this is on the one event loop
// that carries every session's PTY. See claudeTranscriptsSince.
async function transcriptHead(p) {
  // open() INSIDE the try: on the bucket mount a transcript can rotate away
  // between the stat that found it and this open, and the only caller runs in a
  // setTimeout where a throw is unhandled.
  let fh = null;
  try {
    fh = await fsp.open(p, 'r');
    const CHUNK = 65536, MAX_BYTES = 512 * 1024, MAX_LINES = 64;
    let carry = '', pos = 0, lines = 0;
    while (pos < MAX_BYTES && lines < MAX_LINES) {
      const b = Buffer.alloc(Math.min(CHUNK, MAX_BYTES - pos));
      const { bytesRead: n } = await fh.read(b, 0, b.length, pos);
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
  } catch { return null; } finally { if (fh) { try { await fh.close(); } catch {} } }
}

// Async for the same reason as the walk above: these rollouts are on the bucket,
// and reading up to a megabyte of one synchronously blocked the loop carrying
// every session's PTY. Opened INSIDE the try, like transcriptHead: a rollout can
// rotate away between the stat that found it and this open.
async function firstLine(p) {
  let fh = null;
  try {
    fh = await fsp.open(p, 'r');
    const CHUNK = 65536, MAX = 1024 * 1024;
    let buf = Buffer.alloc(0);
    for (let pos = 0; pos < MAX; pos += CHUNK) {
      const b = Buffer.alloc(CHUNK);
      const { bytesRead: n } = await fh.read(b, 0, CHUNK, pos);
      buf = Buffer.concat([buf, b.subarray(0, n)]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) return buf.toString('utf8', 0, nl);
      if (n < CHUNK) break; // EOF
    }
    return buf.toString('utf8');
  } finally { if (fh) { try { await fh.close(); } catch {} } }
}

// Read fresh at every use, never snapshotted: this awaits a bucket walk and then
// a file read per candidate, so a claim or a pin taken before those resolve is a
// stale view of the world by the time it is acted on. Same lesson as the claude
// scan — see the note above the re-pin in scheduleClaudeCapture.
async function tryCaptureCodexId(sessionId, workdir, sinceMs, stillOurs = () => true) {
  const claimedByOthers = () =>
    new Set(list().filter((s) => s.id !== sessionId && s.codexSessionId).map((s) => s.codexSessionId));
  const currentPin = () => (list().find((s) => s.id === sessionId) || {}).codexSessionId;
  for (const c of await codexRolloutsSince(sinceMs)) {
    const m = c.p.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    if (!m || claimedByOthers().has(m[1])) continue;
    let meta;
    try { meta = JSON.parse(await firstLine(c.p)); } catch { continue; }
    const mp = (meta && meta.payload) || {};
    if (!cwdUnderWorkdir(mp.cwd, workdir)) continue;
    // A sibling's ongoing conversation in the same folder gets fresh writes
    // (mtime) during our capture window — require the rollout to have been
    // CREATED after this launch so we never claim someone else's thread.
    const created = Date.parse(mp.timestamp || meta.timestamp || '') || 0;
    if (created && created < sinceMs - 15_000) continue;
    // Skip Codex's internal guardian/subagent rollouts — they share the cwd but
    // aren't this agent's conversation, so pinning one would break resume and
    // the Overview digest.
    if (mp.thread_source === 'subagent' || (mp.source && mp.source.subagent)) continue;
    // Re-read now that the walk and the head read have both resolved: this
    // rollout may since have been claimed by the session it actually belongs to,
    // and taking it anyway would strand that session on a conversation it cannot
    // reclaim.
    if (claimedByOthers().has(m[1])) continue;
    const pinned = currentPin();
    // The watcher re-runs for the life of the pane, so the usual outcome is
    // "still the same conversation" — don't rewrite sessions.json for that.
    if (m[1] === pinned) return true;
    // Both of these were checked before the walk, and the walk plus the head
    // read above have been awaiting the bucket for ~a second since. In that
    // window a relaunch spawns a new host whose watch owns the pin from then on,
    // and a sibling can go live in this folder — precisely the case
    // folderIsShared refuses to guess at. Writing on the strength of the
    // pre-walk answer lets a disposed chain overwrite a correct pin or claim a
    // sibling's rollout. Same re-check the claude re-pin does before its write.
    if (!stillOurs() || folderIsShared(sessionId, workdir, 'codex')) return false;
    if (pinned) console.warn(`[codex] re-pinning ${sessionId}: ${pinned} -> ${m[1]} (conversation was replaced)`);
    update(sessionId, { codexSessionId: m[1], codexRollout: c.p });
    return true;
  }
  return false;
}

// How long a beat waits for its rollout scan before giving up on it and
// rearming. Generous: a cold walk of a real sessions tree runs ~1s, and timing
// one out early would only add a redundant walk, not fix anything.
const SCAN_TIMEOUT_MS = 30_000;

// Resolves true if `p` is still pending after `ms`, false if it settled first.
// Never rejects and never leaves the process alive on the timer — the caller
// wants to carry on, not to be told about a failure. `p` must already carry its
// own .catch: once the race is lost, nothing else is watching it.
function raceTimeout(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    if (t.unref) t.unref();
    p.then(() => { clearTimeout(t); resolve(false); }, () => { clearTimeout(t); resolve(false); });
  });
}

// A pin captured before subagents were filtered out (or one whose rollout was
// rotated away) may point at a guardian/missing rollout — clear it so we
// re-capture the real conversation on this launch.
async function pinIsStale(session) {
  if (!session.codexSessionId) return false;
  const p = session.codexRollout;
  if (!p) return true;
  try { await fsp.stat(p); } catch { return true; } // gone, or the bucket says so
  try {
    const mp = (JSON.parse(await firstLine(p)) || {}).payload || {};
    return mp.thread_source === 'subagent' || !!(mp.source && mp.source.subagent);
  } catch { return false; }
}

// Same staleness problem as Claude's pin, same remedy: codex starts a fresh
// conversation — and a fresh rollout file — when the thread is reset, so a pin
// captured once at launch stops describing the live conversation. Keep watching
// for as long as the pane is alive and follow the newest rollout this folder
// produces. tryCaptureCodexId only writes when the id actually changes.
function scheduleCodexCapture(session, workdir) {
  const prev = codexCapturing.get(session.id);
  if (prev) clearTimeout(prev);
  const since = Date.now() - 2000;
  // The host this watch belongs to. A relaunch spawns a new host and a new
  // watch, and that one owns the pin from then on — same identity guard the
  // claude watcher uses, and it matters for the same reason now that a tick
  // awaits and a relaunch can land mid-scan.
  const host = hosts.get(session.id);
  const stillOurs = () => hosts.get(session.id) === host;
  let warnedShared = false;
  let checkedStale = false;
  let scanInFlight = false;
  let warnedSlow = false;

  const tick = async () => {
    // Clearing a stale pin used to run inline at schedule time, where its
    // existsSync + whole-first-line read sat on the launch path. Both touch the
    // bucket, so do it on the first beat instead — and read the session fresh,
    // since the one passed in was captured before any of this awaited.
    //
    // Deliberately ABOVE the isRunning gate. Inline it ran once per launch,
    // whatever the pane did next; behind the gate a pane that exits inside the
    // first beat skipped it, and as this is now the only clear site in the tree
    // the bad pin survived to the next launch. Nothing clears this timer on
    // exit — only a relaunch does — so the beat still arrives and this still
    // runs exactly once, with stillOurs() keeping a relaunch's fresh pin safe.
    if (!checkedStale) {
      checkedStale = true;
      const live = list().find((s) => s.id === session.id);
      if (live && live.codexSessionId && await pinIsStale(live) && stillOurs()) {
        update(session.id, { codexSessionId: undefined, codexRollout: undefined });
      }
    }
    if (!isRunning(session.id)) { codexCapturing.delete(session.id); return false; }
    if (folderIsShared(session.id, workdir, 'codex')) {
      if (!warnedShared) {
        warnedShared = true;
        console.warn(`[codex] ${session.id}: folder shared with another live session — not following thread resets here`);
      }
    } else if (stillOurs()) {
      // A walk that never comes back must not take the watcher with it. On a
      // wedged mount fsp.stat neither resolves nor rejects, so without this the
      // tick never settles, `run`'s .then never fires, rearm never runs, and
      // this pane silently stops following thread resets for good.
      //
      // The timeout only lets the BEAT continue — the walk itself cannot be
      // cancelled and keeps its libuv thread. So scanInFlight makes sure we
      // never stack a second walk on top of a stuck one: with a 4-thread pool,
      // one walk per beat on a hung mount would consume the pool within a
      // minute and wedge every other fs call in the process.
      if (scanInFlight) {
        if (!warnedSlow) {
          warnedSlow = true;
          console.warn(`[codex] ${session.id}: rollout scan still outstanding — skipping this beat`);
        }
      } else {
        scanInFlight = true;
        const scan = tryCaptureCodexId(session.id, workdir, since, stillOurs)
          .catch((e) => { console.warn(`[codex] ${session.id}: rollout scan failed (${e && e.message})`); })
          .finally(() => { scanInFlight = false; });
        if (await raceTimeout(scan, SCAN_TIMEOUT_MS)) {
          console.warn(`[codex] ${session.id}: rollout scan past ${SCAN_TIMEOUT_MS}ms — rearming without it`);
        }
      }
    }
    return true;
  };

  // One rearm per tick, whatever the tick did. A tick that throws logs and keeps
  // the watcher alive: dropping it would stop following thread resets for the
  // rest of the pane's life, which is the failure this mechanism exists for.
  const run = () => tick()
    .catch((e) => {
      console.warn(`[codex] ${session.id}: repin tick failed (${e && e.message}) — retrying next beat`);
      return isRunning(session.id);
    })
    .then((again) => { if (again) rearm(); else codexCapturing.delete(session.id); });

  let armed = null;
  function rearm(ms = REPIN_MS) {
    // Not the pane's watch any more: either a relaunch during an in-flight walk
    // started a fresh one — which already owns the map entry, and arming here
    // would leave BOTH chains beating with only one reachable by clearTimeout —
    // or the pane exited and nothing replaced it.
    if (!stillOurs()) {
      // Drop OUR entry on the way out; a fired Timeout still retains its
      // callback, and with it this closure and the disposed host. Only ours: a
      // newer watch's timer has to survive untouched.
      if (codexCapturing.get(session.id) === armed) codexCapturing.delete(session.id);
      return;
    }
    armed = setTimeout(run, ms);
    if (armed.unref) armed.unref();
    codexCapturing.set(session.id, armed);
  }

  rearm(5000); // rollout appears ~instantly
}

// opencode has no per-conversation handle we can pass on launch, so we can't
// mint an id like Claude's --session-id. Its plugin reports the exact ses_ id;
// this database discovery remains the unshared-folder fallback. A row appears
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
//
// Async, and that is the point rather than a style choice. This is a readdir per
// project dir plus a stat per transcript, and on the Space CLAUDE_CONFIG_DIR is
// on the FUSE bucket. Measured there over 32 transcripts: ~3ms when the mount's
// attribute cache is warm, 1.1-1.3s when it is cold (~37ms per stat round trip).
// The sync version spent all of that ON the one event loop that also carries
// every session's PTY, so a cold scan was a hard freeze of every terminal — at
// the REPIN_MS beat, once per live pane, every ~20 seconds.
//
// The awaited version does the same I/O for the same wall time, but on the
// libuv threadpool: measured over 302 files, 11.6s of wall time for 26ms of
// event-loop block. Sequential rather than Promise.all on purpose — 32 parallel
// FUSE stats would saturate the 4-thread pool and push every other fs
// operation in the process behind them, and nothing here is waiting on the
// result.
async function claudeTranscriptsSince(sinceMs) {
  const out = [];
  for (const proj of claudeProjectDirs()) {
    let dirs = [];
    try { dirs = await fsp.readdir(proj, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(proj, d.name)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(proj, d.name, f);
        try { const st = await fsp.stat(p); if (st.mtimeMs >= sinceMs) out.push({ p, m: st.mtimeMs }); } catch {}
      }
    }
  }
  return out.sort((a, b) => b.m - a.m);
}

// Async for the same reason as claudeTranscriptsSince — plain loops rather than
// .some(), which cannot await a predicate. Only reached when a re-pin is about to
// happen, and only to say which of the two reasons it is.
async function transcriptExists(uuid) {
  if (!uuid) return false;
  for (const proj of claudeProjectDirs()) {
    let dirs = [];
    try { dirs = await fsp.readdir(proj, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const files = await fsp.readdir(path.join(proj, d.name));
        if (files.some((f) => f.startsWith(uuid))) return true;
      } catch { /* dir vanished mid-walk */ }
    }
  }
  return false;
}

// A transcript's opening cwd/timestamp never changes once written, and the
// filename IS the conversation id, so a path is never reused for a different
// conversation. That makes the head safe to remember — which matters because the
// watcher rescans for the life of every session, and on the Space these are reads
// against a FUSE mount. Without this, every tick re-read every transcript on disk.
const headMemo = new Map(); // transcript path -> head

async function transcriptHeadCached(p) {
  const hit = headMemo.get(p);
  if (hit) return hit;
  const head = await transcriptHead(p);
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
export async function claudeCandidate(sessionId, workdir, sinceMs) {
  const claimed = new Set(list().filter((s) => s.id !== sessionId && s.sessionUuid).map((s) => s.sessionUuid));
  let best = null;
  for (const c of await claudeTranscriptsSince(sinceMs)) {
    const uuid = path.basename(c.p).replace(/\.jsonl$/, '');
    if (claimed.has(uuid)) continue;
    // The cwd is NOT on the first line: a transcript opens with metadata lines
    // (mode, permission-mode, file-history-snapshot, ai-title, worktree-state)
    // that have no cwd, and only the conversation lines carry one — line 4 or 5
    // in every real transcript measured. Reading line 1 made this check always
    // fail, so the re-pin could never actually claim anything.
    const head = await transcriptHeadCached(c.p);
    // Only claim a conversation started in THIS session's folder — or in a
    // directory below it, which is where an agent in a worktree lives (see
    // cwdUnderWorkdir).
    if (!head || !cwdUnderWorkdir(head.cwd, workdir)) continue;
    const start = Date.parse(head.timestamp || '') || 0;
    // Born in this launch window, or it's an older thread that merely received
    // writes — someone else's, or our own pre-relaunch one.
    if (start && start < sinceMs - 15_000) continue;
    if (!best || start > best.start) best = { uuid, start };
  }
  return best;
}

// Another LIVE session of the same harness whose folder OVERLAPS ours makes a new
// conversation there unattributable: we cannot tell whose /clear produced it.
// Refuse to guess, the way share.js does when a folder has rivals.
//
// Overlap, not equality, because the scan now accepts a conversation born
// anywhere below the folder (see cwdUnderWorkdir): a live sibling running in a
// subdirectory of ours — or in a parent of it, which is what a session on the
// workspaces root is — is exactly as ambiguous as one in the same directory.
// Refusing here costs nothing where it fires: the breadcrumb path is unaffected,
// and it is the mechanism now — the scan is its backstop.
function folderIsShared(sessionId, workdir, cli) {
  return list().some((s) => {
    if (s.id === sessionId || s.cli !== cli || !isRunning(s.id)) return false;
    const other = path.join(WORKSPACES_DIR, s.path ?? s.id);
    return cwdUnderWorkdir(other, workdir) || cwdUnderWorkdir(workdir, other);
  });
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

// ---------- breadcrumbs: the pane tells us, so we don't have to guess ----------
// Folder scans cannot attribute a new conversation when several live panes of
// one harness share a folder. The harness itself does know the exact id, so the
// three harnesses with lifecycle extension points report it directly:
//
//   Claude   SessionStart command hook
//   Codex    managed SessionStart command hook
//   OpenCode global plugin (session.created and chat.message)
//
// Each PTY launch gets a fresh AM_RUN_ID. A breadcrumb must match both AM_ID and
// that nonce, so a delayed event from the pane's previous process can never
// move its replacement — and two panes in one folder can never claim each
// other's conversation. The existing transcript/rollout/database discovery
// stays below as a fallback for installations where an adapter is unavailable.
const REPIN_DIR = process.env.AM_REPIN_DIR || '/tmp/am-repin';
const breadcrumbCapturing = new Map(); // session id -> pending exact-event poll
const BREADCRUMB_MS = 250;
const BREADCRUMB_RETRY_MS = 500;
const BREADCRUMB_RETRIES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONVERSATION_ID = { claude: UUID, codex: UUID, opencode: /^ses_[A-Za-z0-9_-]+$/ };

// Read AND remove the pane's breadcrumb — consumed on read, so a stale crumb
// can never flip a pin backwards after a later, scan-based re-pin.
function takeBreadcrumb(sessionId, cli) {
  const p = path.join(REPIN_DIR, `${sessionId}.${cli}.json`);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  try { fs.unlinkSync(p); } catch {}
  try { return JSON.parse(raw); } catch { return null; }
}

// The pane's root process — the PTY this server spawned for the session. After
// `exec claude` this IS claude; in the `claude --session-id … || exec claude`
// branch claude is its direct child. Trusting ANY descendant is too broad: an
// interactive agent started by the top-level agent's shell tool inherits AM_ID
// too, and its lifecycle event must not move the pane's pin.
//
// This used to ask tmux for `#{pane_pid}`. Replacing tmux with a server-held grid
// left the call behind referencing two identifiers that no longer exist here
// (`tmuxName`, `execFileSync`), so it threw a ReferenceError into its own bare
// `catch` on every tick and returned null. That failed EVERY breadcrumb as 'pid
// not in pane' and silently disabled the whole hook path — observed live: the
// only breadcrumb outcome in the Space logs was `breadcrumb rejected (pid not in
// pane)`. The server owns the PTY now, so the pane root is a property read and
// there is no subprocess per tick either.
// Exported for server/test/repin.test.mjs.
export function paneRootPid(sessionId) {
  const pid = hosts.get(sessionId)?.pty?.pid;
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

// comm in /proc/<pid>/stat may itself contain spaces and parens, so split after
// the LAST ') '. Tests inject readStat; production reads the live process tree.
function procIdentity(pid, readStat) {
  let stat;
  try { stat = readStat(pid); } catch { return null; }
  const close = stat.lastIndexOf(') ');
  const open = stat.indexOf('(');
  if (open < 0 || close < open) return null;
  const tail = stat.slice(close + 2).split(' ');
  const ppid = parseInt(tail[1], 10); // state ppid …
  return Number.isInteger(ppid) ? { comm: stat.slice(open + 1, close), ppid } : null;
}

export function pidIsPaneRootOrDirectChild(pid, root,
  readStat = (p) => fs.readFileSync(`/proc/${p}/stat`, 'utf8')) {
  if (!Number.isInteger(pid) || !Number.isInteger(root) || pid <= 1 || root <= 1) return false;
  if (pid === root) return true;
  return procIdentity(pid, readStat)?.ppid === root;
}

// Usually the npm launcher replaces the pane root and starts Codex's native
// binary as its direct child. The `resume --last || fresh` compatibility path
// must retain bash, so there the npm launcher is the direct child and native
// Codex is the grandchild. Accept that one known `node` launcher layer. A
// nested Codex has a tool shell above its launcher and cannot pass this check.
export function codexProcessPidTrusted(codexPid, root,
  readStat = (p) => fs.readFileSync(`/proc/${p}/stat`, 'utf8')) {
  for (let p = codexPid, hops = 0; Number.isInteger(p) && p > 1 && hops < 64; hops++) {
    const identity = procIdentity(p, readStat);
    if (!identity) return false;
    if (identity.comm.startsWith('codex')) {
      if (p === root || identity.ppid === root) return true;
      const launcher = procIdentity(identity.ppid, readStat);
      return launcher?.comm === 'node' && launcher.ppid === root;
    }
    p = identity.ppid;
  }
  return false;
}

// Pure verdict on one breadcrumb, exported for server/test/repin.test.mjs.
// `facts` carries everything environmental: { cli, runId, workdir, pinned,
// claimed (ids other sessions pin), pidTrusted }. Returns
// { repin: conversationId } or { repin: null, why }.
export function breadcrumbVerdict(crumb, sessionId, facts) {
  if (!crumb || typeof crumb !== 'object') return { repin: null, why: 'unreadable' };
  if (crumb.amId !== sessionId) return { repin: null, why: 'amId mismatch' };
  if (crumb.cli !== facts.cli) return { repin: null, why: 'cli mismatch' };
  if (!facts.runId || crumb.runId !== facts.runId) return { repin: null, why: 'runId mismatch' };
  const conversationId = crumb.payload?.session_id;
  if (!CONVERSATION_ID[facts.cli]?.test(conversationId || ''))
    return { repin: null, why: 'no session_id' };
  // A crumb written before a pane was moved to another folder must not follow
  // it there — same folder-scoping rule the transcript scan applies, and the
  // same tree (a worktree under the folder is still this pane's work).
  if (!cwdUnderWorkdir(crumb.payload?.cwd, facts.workdir))
    return { repin: null, why: 'cwd outside the session folder' };
  // Every supported adapter inherits the pane markers into child processes.
  // Only the top-level agent process may speak for the pane; nested agents can
  // otherwise re-pin their parent's Overview, trace and next resume target.
  if (!facts.pidTrusted) return { repin: null, why: 'pid not top-level pane agent' };
  if (facts.claimed?.has(conversationId)) return { repin: null, why: 'claimed by another session' };
  if (conversationId === facts.pinned) return { repin: null, why: 'already pinned' };
  return { repin: conversationId };
}

// Codex gives the exact transcript path with SessionStart. Keep only paths that
// are under this CODEX_HOME's sessions tree and whose rollout filename encodes
// the reported id; the hook's payload is data, never an arbitrary resume path.
export function codexRolloutForBreadcrumb(crumb) {
  const id = crumb?.payload?.session_id;
  const raw = crumb?.payload?.transcript_path;
  if (!UUID.test(id || '') || typeof raw !== 'string' || !raw) return null;
  const resolved = path.resolve(raw);
  const roots = [path.resolve(codexSessionsRoot())];
  const targets = [resolved];
  // CODEX_HOME/sessions is commonly a symlink to durable storage. Codex may
  // report either spelling, so compare both lexical and canonical paths while
  // retaining the same containment and exact-id checks.
  try { roots.push(fs.realpathSync(roots[0])); } catch {}
  try { targets.push(fs.realpathSync(resolved)); } catch {}
  const contained = roots.some((root) => targets.some((target) => {
    const rel = path.relative(root, target);
    return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  }));
  return contained && path.basename(resolved).endsWith(`-${id}.jsonl`) ? resolved : null;
}

// SessionStart permits transcript_path=null. Resolve that case by the exact id
// encoded in Codex's rollout filename — deterministic even in a shared folder.
// Async because the walk it uses is: this landed on main while the walk was
// being moved off the event loop, and the two met at the rebase. Keeping it
// synchronous would mean a second sync walk of the whole rollout tree — the
// exact stall this branch exists to remove.
export async function codexRolloutForId(id) {
  if (!UUID.test(id || '')) return null;
  const suffix = `-${id}.jsonl`;
  return (await codexRolloutsSince(0)).find((item) => path.basename(item.p).endsWith(suffix))?.p || null;
}

// Register the SessionStart hook in $CLAUDE_CONFIG_DIR/settings.json. Merge,
// never replace: the file also holds permissions/model/theme. Idempotent — a
// second boot finds the entry and writes nothing. A file that exists but does
// not parse is left alone (clobbering the user's settings to install a hook
// would be a terrible trade), and every failure is non-fatal: without the
// hook the watcher simply keeps today's behaviour.
export function installClaudeRepinHook(hookCmd = '/app/scripts/am-repin-hook.sh') {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return false;
  const file = path.join(dir, 'settings.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') { console.warn(`[claude] not installing repin hook: ${file} unreadable (${e.message})`); return false; }
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) { console.warn(`[claude] not installing repin hook: ${file} is not an object`); return false; }
  const entries = Array.isArray(cfg.hooks?.SessionStart) ? cfg.hooks.SessionStart : [];
  const present = entries.some((m) => (m?.hooks || []).some((h) => String(h?.command || '').includes('am-repin-hook.sh')));
  if (present) return true;
  // No matcher: fire for every source. `startup` replaces the "--session-id
  // not honoured" heuristic with a fact, `resume` is a proven no-op (same id),
  // and `clear` is the case this exists for. Filtering happens server-side.
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.SessionStart = [...entries, { hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] }];
  try {
    const tmp = `${file}.am-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, file);
    console.warn(`[claude] repin hook installed in ${file}`);
    return true;
  } catch (e) { console.warn(`[claude] repin hook install failed: ${e.message}`); return false; }
}

// OpenCode automatically loads global plugins from this directory. The plugin
// is an app-owned file, so upgrades replace only that one file while all user
// plugins and opencode.json settings remain untouched. This config directory
// can be on the Space's FUSE bucket, whose rename semantics are unreliable;
// install before launching OpenCode and write the app-owned file directly.
export function installOpencodeRepinPlugin(source = '/app/scripts/am-opencode-repin.js') {
  const base = process.env.OPENCODE_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || os.homedir(), '.config'), 'opencode');
  const dir = path.join(base, 'plugins');
  const file = path.join(dir, 'am-agent-manager.js');
  let body;
  try { body = fs.readFileSync(source, 'utf8'); }
  catch (e) { console.warn(`[opencode] repin plugin source unavailable: ${e.message}`); return false; }
  try {
    if (fs.readFileSync(file, 'utf8') === body) return true;
  } catch { /* install or upgrade it below */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    console.warn(`[opencode] repin plugin installed in ${file}`);
    return true;
  } catch (e) { console.warn(`[opencode] repin plugin install failed: ${e.message}`); return false; }
}

function exactPinFacts(session, host, workdir, pinField) {
  return {
    cli: session.cli,
    runId: host.runId,
    workdir,
    pinned: (list().find((s) => s.id === session.id) || session)[pinField],
    claimed: new Set(list().filter((s) => s.id !== session.id && s[pinField]).map((s) => s[pinField])),
  };
}

// Apply one event from the pane's own adapter. This path never asks which file
// or database row is newest: the reported id is the lookup key, and local state
// is used only to validate that exact key before persisting it.
async function applyBreadcrumb(session, host, workdir, crumb) {
  let facts;
  let patch;
  if (session.cli === 'claude') {
    facts = exactPinFacts(session, host, workdir, 'sessionUuid');
    const root = paneRootPid(session.id);
    facts.pidTrusted = !!root && (pidIsPaneRootOrDirectChild(crumb.claudePid, root)
      || (Number.isInteger(host.exactAgentPid) && host.exactAgentPid === crumb.claudePid));
    patch = (id) => ({ sessionUuid: id });
  } else if (session.cli === 'codex') {
    facts = exactPinFacts(session, host, workdir, 'codexSessionId');
    const root = paneRootPid(session.id);
    facts.pidTrusted = !!root && (codexProcessPidTrusted(crumb.codexPid, root)
      || (Number.isInteger(host.exactAgentPid) && host.exactAgentPid === crumb.codexPid));
  } else if (session.cli === 'opencode') {
    facts = exactPinFacts(session, host, workdir, 'opencodeSessionId');
    facts.pidTrusted = crumb.pluginPid === paneRootPid(session.id);
  } else {
    return { repin: null, why: 'unsupported cli' };
  }

  const verdict = breadcrumbVerdict(crumb, session.id, facts);
  if (!verdict.repin && verdict.why !== 'already pinned') return verdict;

  if (session.cli === 'codex') {
    const reported = crumb?.payload?.transcript_path;
    const rollout = codexRolloutForBreadcrumb(crumb)
      || (reported == null ? await codexRolloutForId(crumb?.payload?.session_id) : null);
    // That fallback awaits a walk of the rollout tree, and the pane's own exit
    // handler calls in here and then deletes the host on the next line. If a
    // relaunch got a new host in the meantime, this crumb describes a launch
    // that is over and writing it would overwrite the new one's pin — the same
    // re-check tryCaptureCodexId and the claude re-pin both make.
    if (hosts.get(session.id) !== host) return { repin: null, why: 'relaunched during rollout lookup' };
    if (!rollout) return {
      repin: null,
      why: reported == null ? 'rollout not available yet' : 'invalid transcript_path',
      retry: reported == null,
    };
    patch = (id) => ({ codexSessionId: id, codexRollout: rollout });
    // A same-id resume is normally a no-op, but an older pin may lack the path
    // required by commandFor. Exact lifecycle data repairs that incomplete pin.
    if (!verdict.repin && facts.pinned === crumb.payload.session_id) {
      const current = list().find((s) => s.id === session.id) || session;
      if (current.codexRollout !== rollout) update(session.id, patch(facts.pinned));
    }
  } else if (session.cli === 'opencode') {
    const row = opencodeSessionInfo(crumb?.payload?.session_id);
    if (!row) return { repin: null, why: 'session missing from database', retry: true };
    if (row.parentId) return { repin: null, why: 'subagent session' };
    if (!cwdUnderWorkdir(row.directory, workdir))
      return { repin: null, why: 'database cwd outside the session folder' };
    patch = (id) => ({ opencodeSessionId: id });
  }

  // Remember only a process that passed both tree attribution and adapter data
  // validation. onExit runs after node-pty has reaped the process, so /proc may
  // already be gone when it performs the promised final breadcrumb read; a
  // later /clear crumb from this same long-lived agent remains attributable.
  host.exactAgentPid = session.cli === 'claude' ? crumb.claudePid
    : session.cli === 'codex' ? crumb.codexPid : crumb.pluginPid;
  if (verdict.repin || verdict.why === 'already pinned') host.exactRepinProven = true;
  if (verdict.repin) {
    console.warn(`[${session.cli}] re-pinning ${session.id}: ${facts.pinned || '(none)'} -> ${verdict.repin} (exact ${crumb.payload?.source || 'event'})`);
    update(session.id, patch(verdict.repin));
  }
  return verdict;
}

async function consumeBreadcrumb(session, host, workdir, force = false) {
  const fresh = takeBreadcrumb(session.id, session.cli);
  let pending = host.pendingExactBreadcrumb;
  if (fresh) {
    pending = { crumb: fresh, attempts: 0, nextAt: 0 };
    host.pendingExactBreadcrumb = null;
  }
  if (!pending || (!fresh && !force && Date.now() < pending.nextAt)) return;
  try {
    const verdict = await applyBreadcrumb(session, host, workdir, pending.crumb);
    if (verdict.retry && pending.attempts < BREADCRUMB_RETRIES) {
      host.pendingExactBreadcrumb = {
        crumb: pending.crumb,
        attempts: pending.attempts + 1,
        nextAt: Date.now() + BREADCRUMB_RETRY_MS,
      };
      return;
    }
    host.pendingExactBreadcrumb = null;
    if (!verdict.repin && verdict.why !== 'already pinned')
      console.warn(`[${session.cli}] ${session.id}: exact breadcrumb rejected (${verdict.why})`);
  } catch (e) {
    host.pendingExactBreadcrumb = null;
    console.warn(`[${session.cli}] ${session.id}: exact breadcrumb failed (${e && e.message})`);
  }
}

// Poll only a tiny file on local /tmp, frequently enough that a /clear followed
// by an immediate pane exit still persists its new id. Expensive transcript,
// rollout and database discovery retain their existing sparse cadence below.
function scheduleBreadcrumbCapture(session, workdir) {
  if (!CONVERSATION_ID[session.cli]) return;
  const prev = breadcrumbCapturing.get(session.id);
  if (prev) clearTimeout(prev);
  const host = hosts.get(session.id);
  let armed = null;
  // One rearm per tick, after the beat finishes rather than alongside it: the
  // codex fallback inside now awaits a walk of the rollout tree, and arming on
  // a fixed interval regardless would stack beats on a slow mount. Same shape
  // as the codex and claude watchers.
  const tick = async () => {
    if (hosts.get(session.id) !== host) {
      if (breadcrumbCapturing.get(session.id) === armed) breadcrumbCapturing.delete(session.id);
      return;
    }
    try { await consumeBreadcrumb(session, host, workdir); } catch { /* consumeBreadcrumb logs its own */ }
    if (hosts.get(session.id) !== host) {
      if (breadcrumbCapturing.get(session.id) === armed) breadcrumbCapturing.delete(session.id);
      return;
    }
    armed = setTimeout(tick, BREADCRUMB_MS);
    if (armed.unref) armed.unref();
    breadcrumbCapturing.set(session.id, armed);
  };
  tick();
}

// Once the pane's SessionStart hook has proven itself, the transcript scan is a
// backstop rather than the mechanism, so it runs on this cadence instead of
// REPIN_MS. Now that the scan is awaited rather than synchronous this is no longer
// about event-loop block time — it is only about not walking the bucket 3x a
// minute per pane for an answer the breadcrumb already gave. So it can be short:
// this also bounds how long a pin stays stale if a breadcrumb is ever LOST (the
// hook fired but its crumb never reached us), and that staleness costs one late
// Overview digest. Note the bound is this PLUS up to one beat, not exactly this:
// only a tick can scan, ticks come every REPIN_MS, and each one is armed after the
// previous finishes — so the first tick at or past the backstop can be as late as
// SCAN_BACKSTOP_MS + REPIN_MS, plus the new scan's own duration.
const SCAN_BACKSTOP_MS = 60_000;

/**
 * Should this tick run the transcript scan?
 *
 * Before the hook has proven itself the cadence is unchanged, so a pane with no
 * working hook (hook newly installed, crumb lost, a harness with no hook at all)
 * keeps the pre-existing behaviour and nothing regresses. Pure so the cadence is
 * testable without a live pane; exported for server/test/repin.test.mjs.
 */
export function claudeScanDue({ hookProven, lastScanAt }, now = Date.now()) {
  if (!hookProven) return true;
  return now - (lastScanAt || 0) >= SCAN_BACKSTOP_MS;
}

function scheduleClaudeCapture(session, workdir) {
  // A relaunch restarts the watch with a fresh window, so `since` can't drift
  // older and start admitting pre-relaunch threads as candidates.
  const prev = claudeCapturing.get(session.id);
  if (prev) clearTimeout(prev);
  const since = Date.now() - 2000;
  // The host this watch belongs to. Clearing `prev` above only cancels a PENDING
  // beat; now that a tick awaits, one can be mid-scan when a relaunch calls this
  // again, and that tick still has a rearm ahead of it — see rearm.
  const host = hosts.get(session.id);
  let warnedShared = false;
  // Has a breadcrumb from this pane ever named this pane's OWN conversation? That
  // is what demotes the scan to a backstop — see claudeScanDue.
  let hookProven = false;
  let lastScanAt = 0;

  // Read fresh, never captured: the scan awaits, so anything read before it is a
  // stale view of the world by the time it returns.
  const currentPin = () => (list().find((s) => s.id === session.id) || session).sessionUuid;
  const claimedByOthers = () =>
    new Set(list().filter((s) => s.id !== session.id && s.sessionUuid).map((s) => s.sessionUuid));
  // Is this watch still the pane's? A relaunch spawns a new host and a new watch,
  // and that one owns the pin from then on.
  const stillOurs = () => hosts.get(session.id) === host;

  // Returns whether to keep watching. Rearming is the caller's job (see `run`):
  // the scan awaits now, so a throw lands as a rejected promise rather than as an
  // exception in a setTimeout callback, and exactly one place deciding the next
  // beat is what keeps a failed tick from either killing the watcher or arming
  // two timers.
  const tick = async () => {
    if (!isRunning(session.id)) { claudeCapturing.delete(session.id); return false; }
    hookProven ||= !!host.exactRepinProven;
    if (folderIsShared(session.id, workdir, 'claude')) {
      if (!warnedShared) {
        warnedShared = true;
        console.warn(`[claude] ${session.id}: folder shared with another live session — following /clear only via breadcrumbs here`);
      }
    } else if (claudeScanDue({ hookProven, lastScanAt })) {
      const hit = await claudeCandidate(session.id, workdir, since);
      // Stamped AFTER the scan resolves, not before it. Nothing can overlap it —
      // the next beat is armed only once this tick returns — and stamping first
      // meant a scan that threw was not retried on the next beat the way `run`
      // logs, but skipped until the backstop expired.
      lastScanAt = Date.now();
      // Every input that decision rests on was read BEFORE the scan awaited, so
      // re-read them rather than mutating a world that has moved on:
      //   - this pane may have been relaunched, and the new watch owns the pin now
      //     (its `since` is newer, so `hit` may be pre-relaunch and wrong);
      //   - another claude pane may have gone live in this folder, which is
      //     precisely the case folderIsShared refuses to guess at — and it was
      //     false when this tick started;
      //   - `hit` may since have been pinned by the session it belongs to;
      //     claudeCandidate snapshots `claimed` before it walks the disk, so a
      //     conversation that was unclaimed then can be claimed now. Taking it
      //     anyway would make the owner's own breadcrumb bounce off 'claimed by
      //     another session' for good.
      if (hit && stillOurs() && !claimedByOthers().has(hit.uuid)
          && !folderIsShared(session.id, workdir, 'claude')) {
        const pin = currentPin();
        if (hit.uuid !== pin) {
          const why = await transcriptExists(pin) ? 'conversation was replaced (/clear)' : '--session-id was not honoured';
          // transcriptExists awaited too, so confirm ownership once more before
          // the write itself.
          if (stillOurs()) {
            console.warn(`[claude] re-pinning ${session.id}: ${pin} -> ${hit.uuid} (${why})`);
            update(session.id, { sessionUuid: hit.uuid });
          }
        }
      }
    }
    return true;
  };

  // One rearm per tick, whatever the tick did. A tick that throws logs and keeps
  // the watcher alive: dropping it would silently stop following /clear for the
  // rest of the pane's life, which is the failure this whole mechanism exists for.
  const run = () => tick()
    .catch((e) => {
      console.warn(`[claude] ${session.id}: repin tick failed (${e && e.message}) — retrying next beat`);
      return isRunning(session.id);
    })
    .then((again) => { if (again) rearm(); else claudeCapturing.delete(session.id); });

  let armed = null;
  function rearm(ms = REPIN_MS) {
    // This watch is no longer the pane's: either a relaunch during an in-flight
    // scan started a fresh one — which already owns the map entry, and arming here
    // would leave BOTH chains beating with only one reachable by clearTimeout, the
    // orphan keeping its own hookProven/lastScanAt and its own pre-relaunch
    // `since` — or the pane simply exited and nothing replaced it. Same
    // host-identity guard the grid timers use.
    if (!stillOurs()) {
      // Drop OUR entry on the way out. A fired Timeout still holds its callback
      // (node does not release `_onTimeout`), so leaving it in the map retains this
      // closure and the disposed host until the session next starts. Only ours
      // though: a newer watch's timer has to survive untouched.
      if (claudeCapturing.get(session.id) === armed) claudeCapturing.delete(session.id);
      return;
    }
    armed = setTimeout(run, ms);
    if (armed.unref) armed.unref();
    claudeCapturing.set(session.id, armed);
  }

  rearm(5000);
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

// Conversation ids reach the launch line unquoted, and this one comes back out
// of a database rather than from us (Claude's uuid we mint ourselves). Shape-check
// it so nothing but an opencode session id can ever be interpolated.
const SES_ID = /^ses_[A-Za-z0-9_-]+$/;

export function commandFor(session) {
  const cli = cliById(session.cli) || cliById('shell');
  if (cli.id === 'shell') return bashLaunch;
  // Quickstart: a prompt queued at creation rides the FIRST launch command
  // (claude 'p', codex 'p', gemini -i 'p', opencode --prompt 'p') — the CLI
  // starts already working on it, no typing race against a booting TUI.
  const q0 = !session.everStarted && session.pendingPrompt ? shq(session.pendingPrompt) : '';
  const q0Images = !session.everStarted && Array.isArray(session.pendingImagePaths)
    ? session.pendingImagePaths.map((image) => shq(String(image))) : [];
  const firstCommand = () => cli.withPrompt(q0, q0Images);

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
    // Resume the conversation this session is PINNED to, by id. `--continue`
    // (below) takes the most-recent conversation in the CWD instead, which
    // ignores the pin entirely: after a reset a restart came back on whichever
    // conversation the folder touched last, and the pin the watcher maintains —
    // the one the digest, the trace panel and sharing all read — described a
    // different thread than the pane was showing. Existence-checked in JS rather
    // than in the shell, because the db is one file for all conversations (no
    // per-conversation path to test) and a missing row is fatal, not a fallback.
    const pin = session.opencodeSessionId;
    if (session.everStarted && pin && SES_ID.test(pin) && opencodeSessionExists(pin)) {
      return `${guard}exec opencode --session ${pin}`;
    }
    // Unpinned (or the conversation is gone): `--continue` resumes the
    // most-recent conversation in the CWD, so two opencode agents sharing a
    // folder would resume onto the SAME one (cross-talk) — same hazard as codex
    // `resume --last`. Only continue when this session holds its folder alone;
    // otherwise start fresh, and capture pins the new conversation right away
    // (see scheduleOpencodeCapture).
    const folder = session.path ?? session.id;
    const shared = list().some((o) => o.id !== session.id && o.cli === 'opencode' && (o.path ?? o.id) === folder);
    const base = session.everStarted && cli.cont && !shared
      ? `${cli.cont} || exec ${cli.run}`
      : `exec ${q0 && cli.withPrompt ? firstCommand() : cli.run}`;
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
  if (q0 && cli.withPrompt) return `exec ${firstCommand()}`;
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
  // The login shell knows its own PTY-root pid before any `exec`. Adapters use
  // this marker to discard nested agent lifecycle events BEFORE they can
  // overwrite the top-level pane's breadcrumb; runner validation repeats the
  // process-tree check before persisting anything.
  const full = `export AM_PANE_PID=$$; ${commandFor(session)}`;
  const captureResize = cliById(session.cli)?.resizeMode === 'repaint';
  const runId = crypto.randomUUID();

  const env = {
    ...TERM_ENV,
    AM_SESSION: folder,
    AM_NAME: session.name,
    AM_ID: session.id,
    AM_RUN_ID: runId,
    AM_CLI: session.cli,
    AM_USER,
    AM_ROOT: WORKSPACES_DIR, // prompt shows $PWD relative to this
    // The port the agent API answers on. PORT is configurable, so a session
    // must be able to READ it rather than trust a number baked into a doc when
    // that doc was generated.
    AM_PORT: String(PORT),
  };
  const term = pty.spawn('bash', ['-lc', full], {
    name: 'xterm-256color', cols, rows, cwd: workdir, env,
  });
  const vt = ghostty.createTerminal({ cols, rows, scrollbackLimit: SCROLLBACK_BYTES });
  const loadedHistory = loadTerminalHistory(HISTORY_DIR, session.id);
  // Older agent checkpoints may contain startup repaint frames or a turn that
  // trace hydration raced with Claude's own replay. Rebuild those once from
  // the trace. Shell history never used that path and remains safe to restore.
  const persistedHistory = captureResize
    && loadedHistory?.version < TERMINAL_HISTORY_VERSION ? null : loadedHistory;
  if (persistedHistory) {
    try {
      vt.feed(snapshotToRestoreAnsi({
        cols, rows, cursorRow: 0, cursorCol: 0, isAltScreen: false, cells: [],
        scrollbackLines: persistedHistory.lines,
      }));
    } catch (error) {
      console.error('[runner] history restore', error && error.message);
    }
  }
  const host = {
    id: session.id,
    runId,
    pty: term,
    vt,
    cols,
    rows,
    captureResize,
    resizeCapture: null,
    repaintArchive: null,
    historyStyles: new Map((persistedHistory?.lines || [])
      .filter((line) => line.text && line.ansi).map((line) => [line.text, line.ansi])),
    terminalModes: createTerminalModeTracker(),
    startupHistory: captureResize ? persistedHistory : null,
    historyCheckpoint: null,
    traceHistoryPage: null,
    traceHistoryTimer: null,
    subs: new Set(),
    controller: null,
    gridTimer: null,
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    screenChangedAt: Date.now(),
    bells: 0,
  };
  host.historyCheckpoint = createTerminalHistoryCheckpoint({
    directory: HISTORY_DIR,
    id: host.id,
    delayMs: HISTORY_SAVE_MS,
    snapshot: () => {
      const snap = host.vt.snapshot({ includeScrollback: true });
      learnHistoryStyles(host, host.vt, snap);
      if (!captureResize) {
        return { ...snap, scrollbackLines: withHistoryStyles(host, snap.scrollbackLines) };
      }
      const archive = host.repaintArchive ?? terminalArchive(host.vt, snap);
      return {
        cols: host.cols,
        scrollbackLines: withHistoryStyles(host, logicalHistory(archive)),
      };
    },
    blocked: () => !!host.resizeCapture,
    persistedBody: persistedHistory?.body || null,
  });

  term.onData((chunk) => {
    host.lastOutputAt = Date.now();
    host.terminalModes.feed(chunk);
    if (host.traceHistoryTimer) {
      clearTimeout(host.traceHistoryTimer);
      host.traceHistoryTimer = null;
    }
    if (host.traceHistoryPage) armTraceHydration(host);
    let txn = host.resizeCapture;
    if (!txn && host.startupHistory) {
      startCapturedGrid(host, host.cols, host.rows, null, false);
      txn = host.resizeCapture;
    }
    if (txn) {
      try { txn.vt.feed(chunk); } catch (e) { console.error('[runner] resize capture', e && e.message); }
      txn.sawData = true;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 7) { host.bells++; host.lastBellAt = Date.now(); }
      }
      armCapturedGrid(host, txn);
      return;
    }

    // This is real output outside a resize transaction. It may have advanced
    // scrollback, so the next transaction takes a fresh canonical boundary.
    host.repaintArchive = null;
    try { host.vt.feed(chunk); } catch (e) { console.error('[runner] vt.feed', e && e.message); }
    host.historyCheckpoint.schedule();

    // State detection rides the feed path: the grid is already current, so there
    // is nothing to poll and no subprocess to spawn.
    sampleScreen(host);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 7) { host.bells++; host.lastBellAt = Date.now(); }
    }

    for (const sub of host.subs) sub.onData(chunk);
  });

  term.onExit(() => {
    // Do one final local read before releasing this launch's nonce. In
    // particular, `/clear` followed immediately by quit must still persist the
    // conversation that was on screen when the pane ended.
    // Not awaited — onExit is synchronous and the teardown below must not wait
    // on a bucket walk. The write it may perform re-checks host ownership
    // first, so landing after the hosts.delete below (or after a relaunch) is
    // safe: it either still owns the pin or declines to touch it.
    consumeBreadcrumb(session, host, workdir, true)
      .catch((e) => console.warn(`[${session.cli}] ${session.id}: final breadcrumb read failed (${e && e.message})`));
    hosts.delete(session.id);
    stopping.delete(session.id);
    if (host.gridTimer) { clearTimeout(host.gridTimer); host.gridTimer = null; }
    if (host.traceHistoryTimer) { clearTimeout(host.traceHistoryTimer); host.traceHistoryTimer = null; }
    if (host.resizeCapture) {
      clearCaptureTimers(host.resizeCapture);
      try { host.resizeCapture.vt.dispose(); } catch {}
      host.resizeCapture = null;
    }
    host.historyCheckpoint.flush();
    try { host.vt.dispose(); } catch {}
    for (const sub of host.subs) sub.onExit();
    host.subs.clear();
  });

  hosts.set(session.id, host);
  stopping.delete(session.id);
  if (!persistedHistory && captureResize) hydrateTraceHistory(session, host);
  if (!session.everStarted) update(session.id, {
    everStarted: true, pendingPrompt: undefined, pendingImagePaths: undefined,
  });
  scheduleBreadcrumbCapture(session, workdir);
  if (session.cli === 'codex') scheduleCodexCapture(session, workdir);
  if (session.cli === 'opencode') scheduleOpencodeCapture(session, workdir);
  if (session.cli === 'claude') scheduleClaudeCapture(session, workdir);
  return true;
}

/**
 * Subscribe a viewer to a session, starting it if needed.
 *
 * Unlike the tmux version this does NOT spawn anything per viewer, and
 * `handle.kill()` only unsubscribes — closing a tab must never stop an agent.
 * `handle.restore()` returns a canonical snapshot: Ghostty's complete plain-text
 * history followed by a styled visible-screen repaint. It never replays an
 * arbitrary suffix of old PTY bytes at a new geometry.
 */
export function attach(session, cols, rows) {
  ensureRunning(session, cols, rows);
  const host = hosts.get(session.id);
  if (!host) throw new Error('session failed to start');

  const sub = {
    onData: () => {},
    onExit: () => {},
    onGrid: () => {},
    want: preferredGrid(cols, rows, host),
  };
  host.subs.add(sub);
  if (!host.controller) host.controller = sub;
  // Existing viewers need to know that the session is now shared. The new
  // viewer receives the same role/count in its restore frame below.
  notifyGrid(host, false);
  if (host.controller === sub && (sub.want.cols !== host.cols || sub.want.rows !== host.rows)) scheduleGrid(host);

  return {
    onData: (cb) => { sub.onData = (d) => { try { cb(d); } catch {} }; },
    onExit: (cb) => { sub.onExit = () => { try { cb(); } catch {} }; },
    onGrid: (cb) => { sub.onGrid = (c, r, controller, viewers, reset) => { try { cb(c, r, controller, viewers, reset); } catch {} }; },
    // Input and terminal-query responses are accepted from one emulator only.
    write: (d) => {
      if (host.controller !== sub) return;
      try { host.pty.write(d); } catch {}
    },
    // Every viewer remembers what it can display, but only the current
    // controller's request changes the PTY.
    resize: (c, r) => {
      if (!Number.isFinite(c) || !Number.isFinite(r)) return;
      const want = preferredGrid(c, r, host);
      const had = sub.want;
      sub.want = want;
      if (had && had.cols === want.cols && had.rows === want.rows) return;
      if (host.controller === sub) scheduleGrid(host);
    },
    claim: () => {
      if (!host.subs.has(sub) || host.controller === sub) return;
      host.controller = sub;
      notifyGrid(host, false);
      scheduleGrid(host);
    },
    restore: () => {
      let snap;
      try { snap = host.vt.snapshot({ includeCells: true, includeScrollback: true }); } catch { return null; }
      return {
        ansi: viewerRestoreAnsi(host, host.vt, snap),
        cols: snap.cols,
        rows: snap.rows,
        viewers: host.subs.size,
        controller: host.controller === sub,
      };
    },
    // Detach this viewer only. The session, its grid and its scrollback stay.
    kill: () => {
      const controlled = host.controller === sub;
      host.subs.delete(sub);
      if (controlled) host.controller = host.subs.values().next().value || null;
      notifyGrid(host, false);
      if (controlled && host.controller) scheduleGrid(host);
    },
  };
}

/** Type a line into the session's terminal (works with no browser attached). */
export async function sendInput(id, text) {
  const host = hosts.get(id);
  if (!host || stopping.has(id)) throw new Error('session is not running');
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

/** Insert text into a running terminal's composer without submitting it. */
export function pasteInput(id, text) {
  const host = hosts.get(id);
  if (!host || stopping.has(id)) throw new Error('session is not running');
  const value = String(text || '');
  if (!value) return;
  const payload = value.includes('\n') ? `\x1b[200~${value}\x1b[201~` : value;
  host.pty.write(payload);
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
  stopping.add(id);
  try { host.pty.kill(); } catch {}
}

/**
 * Kill every session. Without tmux nothing outlives this process, so a clean
 * shutdown should not leave orphaned PTYs behind holding the workspace.
 */
export function stopAll() {
  for (const host of hosts.values()) {
    stopping.add(host.id);
    try { host.pty.kill(); } catch {}
  }
}
