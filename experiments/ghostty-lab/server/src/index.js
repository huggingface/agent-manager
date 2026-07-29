import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { PANELS, COLS, ROWS, CTRL, SEED_PROMPT } from './panels.js';
import { buildPaletteIndex, snapshotToAnsi } from './snapshot.js';

// Scrollback restore comes from a ring of raw PTY bytes rather than from
// snapshot(): snapshot returns history as plain LINES, not cells, so replaying
// it gave colourless scrollback above a fully styled screen. Replaying the
// bytes reconstructs history exactly as a browser that never left would have
// rendered it, and the snapshot repaint still lands on top as the authority for
// the visible screen — so a ring that starts mid-frame can't leave it wrong.
const REPLAY_BYTES = Number(process.env.LAB_REPLAY_BYTES || 256 * 1024);

const require = createRequire(import.meta.url);

// libghostty-vt ships prebuilts for linux x64/arm64 and macOS arm64 only. The
// lab must still boot without it (so the classic panel stays comparable and the
// page explains what's missing) — hence the guarded load.
let ghostty = null;
let ghosttyError = null;
try {
  ghostty = await import('@coder/libghostty-vt-node');
} catch (err) {
  ghosttyError = String(err && err.message ? err.message : err);
  console.warn('libghostty-vt unavailable:', ghosttyError);
}

if (ghostty) buildPaletteIndex(ghostty.createTerminal);

const PORT = Number(process.env.PORT || 7860);
const DATA_DIR = process.env.DATA_DIR || '/data';
const WORKSPACES = path.join(DATA_DIR, 'workspaces');
const STATE_DIR = path.join(DATA_DIR, 'state');
const STATE_FILE = path.join(STATE_DIR, 'lab.json');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), '..', 'web', 'dist');
// /app/tmux.conf in the image; the repo copy when running from a checkout.
// Without it tmux keeps its status bar, which would eat a row of the grid.
const TMUX_CONF = process.env.TMUX_CONF
  || (fs.existsSync('/app/tmux.conf') ? '/app/tmux.conf' : path.join(import.meta.dirname, '..', '..', 'tmux.conf'));
const USE_TMUX = process.env.USE_TMUX !== '0';

const TERM_ENV = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: process.env.LANG || 'C.UTF-8',
};

// ---------- persisted state (one Claude conversation id per panel) ----------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic, survives the FUSE bucket
}

function panelState(id) {
  const state = readState();
  if (!state[id]) {
    state[id] = { uuid: crypto.randomUUID(), everStarted: false };
    writeState(state);
  }
  return state[id];
}

function markStarted(id) {
  const state = readState();
  if (state[id] && !state[id].everStarted) {
    state[id].everStarted = true;
    writeState(state);
  }
}

// ---------- launching Claude ----------

const shq = (t) => `'${String(t).replace(/'/g, `'\\''`)}'`;
const tmuxName = (id) => `lab-${id}`;

// Same resume-vs-fresh rule agent-manager uses: decide by whether the transcript
// exists on disk, never by `resume || fresh` (that chain also fires when claude
// exits non-zero, silently respawning a crashed session as a new conversation).
function claudeCommand(panelId) {
  const st = panelState(panelId);
  const q = st.everStarted ? '' : ` ${shq(SEED_PROMPT)}`;
  const fresh = `claude --session-id ${st.uuid}${q} || exec claude`;
  if (!st.everStarted) return fresh;
  const projects = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"';
  const hasTranscript = `[ -n "$(find ${projects} -name '${st.uuid}*' -print -quit 2>/dev/null)" ]`;
  return `if ${hasTranscript}; then exec claude --resume ${st.uuid}; else ${fresh}; fi`;
}

// Escape hatch for local smoke tests: run something cheap instead of a real
// Claude session. Unset on the Space.
function commandFor(panelId) {
  return process.env.LAB_COMMAND || claudeCommand(panelId);
}

function workdirFor(panel) {
  const dir = path.join(WORKSPACES, panel.dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Spawn a PTY running the panel's Claude session. Under tmux this attaches to
 * (or creates) a durable session; `-D` detaches any other client so exactly one
 * PTY drives it. Both panels use the SAME fixed grid, so the only variable in
 * the comparison is how a returning browser gets its screen back.
 */
function spawnPty(panel) {
  const workdir = workdirFor(panel);
  const command = commandFor(panel.id);
  markStarted(panel.id);

  if (!USE_TMUX || panel.tmux === false) {
    return pty.spawn('bash', ['-lc', command], {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: workdir, env: TERM_ENV,
    });
  }

  const args = [];
  if (fs.existsSync(TMUX_CONF)) args.push('-f', TMUX_CONF);
  args.push(
    'new-session', '-A', '-D', '-s', tmuxName(panel.id), '-c', workdir,
    '-e', `LAB_PANEL=${panel.id}`,
    'sh', '-lc', command,
  );
  return pty.spawn('tmux', args, {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: workdir, env: TERM_ENV,
  });
}

function tmuxAlive(id) {
  if (!USE_TMUX) return false;
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------- panel B: the server holds the terminal ----------
//
// This is the whole point of the experiment. The server keeps ONE long-lived PTY
// client attached to tmux and feeds every byte into a libghostty-vt terminal, so
// the authoritative screen lives here and stays warm whether or not a browser is
// looking. Attaching a browser costs one snapshot, not a tmux redraw.

const holders = new Map(); // panelId -> holder

function ensureHolder(panel) {
  const existing = holders.get(panel.id);
  if (existing) return existing;
  if (!ghostty) throw new Error(`libghostty-vt unavailable: ${ghosttyError}`);

  const vt = ghostty.createTerminal({ cols: COLS, rows: ROWS, scrollbackLimit: 5000 });
  const term = spawnPty(panel);
  const holder = {
    panel, vt, pty: term, clients: new Set(),
    bytes: 0, feeds: 0, feedMs: 0, startedAt: Date.now(), lastByteAt: 0,
    cols: COLS, rows: ROWS,
    sizes: new Map(), // ws -> the grid that client can display
    history: [], historyBytes: 0, historyDropped: false,
  };

  term.onData((chunk) => {
    const t0 = performance.now();
    try { vt.feed(chunk); } catch (err) { console.warn('vt.feed failed:', err.message); }
    holder.feedMs += performance.now() - t0;
    holder.feeds++;
    holder.bytes += chunk.length;
    holder.lastByteAt = Date.now();

    holder.history.push(chunk);
    holder.historyBytes += chunk.length;
    while (holder.historyBytes > REPLAY_BYTES && holder.history.length > 1) {
      holder.historyBytes -= holder.history.shift().length;
      holder.historyDropped = true;
    }

    for (const ws of holder.clients) {
      if (ws.readyState === 1) ws.send(chunk);
    }
  });

  term.onExit(() => {
    holders.delete(panel.id);
    try { vt.dispose(); } catch {}
    for (const ws of holder.clients) {
      if (ws.readyState === 1) ws.close(4000, 'session exited');
    }
  });

  holders.set(panel.id, holder);
  return holder;
}

/** The restore payload a returning browser gets: an ANSI repaint plus a
 *  server-rendered HTML preview it can paint before wasm has even loaded. */
/**
 * One grid, shared by every attached viewer, sized to the SMALLEST of them.
 *
 * Letting each client size itself is what distorts a second device: the phone
 * resizes the PTY to 40 columns while the desktop keeps rendering into its own
 * 150-column layout, so it draws 40-column output into the wrong geometry. With
 * the server authoritative, the desktop just shows a smaller grid — correct,
 * only letterboxed. When the phone detaches the grid grows back.
 */
function effectiveGrid(holder) {
  if (!holder.sizes.size) return { cols: holder.cols, rows: holder.rows };
  let cols = Infinity;
  let rows = Infinity;
  for (const s of holder.sizes.values()) {
    cols = Math.min(cols, s.cols);
    rows = Math.min(rows, s.rows);
  }
  return { cols, rows };
}

/** Apply the shared grid and tell every viewer what it is. Returns true if it moved. */
function applyGrid(holder) {
  const { cols, rows } = effectiveGrid(holder);
  if (cols === holder.cols && rows === holder.rows) return false;
  holder.cols = cols;
  holder.rows = rows;
  try { holder.pty.resize(cols, rows); } catch {}
  try { holder.vt.resize(cols, rows); } catch {}
  const shared = holder.sizes.size > 1;
  for (const ws of holder.clients) sendCtrl(ws, { type: 'grid', cols, rows, shared, viewers: holder.clients.size });
  return true;
}

/**
 * The bytes to replay for scrollback. A ring that has wrapped almost certainly
 * starts mid-escape-sequence, so drop everything before the first newline —
 * cheap, and the repaint that follows fixes the visible screen regardless.
 */
function replayBytes(holder) {
  const joined = holder.history.join('');
  if (!holder.historyDropped) return joined;
  const nl = joined.indexOf('\n');
  return nl >= 0 ? joined.slice(nl + 1) : joined;
}

function restoreFrame(holder) {
  const t0 = performance.now();
  const snap = holder.vt.snapshot({ includeCells: true });
  const snapMs = performance.now() - t0;
  const t1 = performance.now();
  const replay = replayBytes(holder);
  const ansi = snapshotToAnsi(snap);
  const ansiMs = performance.now() - t1;
  let html = '';
  try { html = holder.vt.formatHtml ? holder.vt.formatHtml() : ''; } catch {}
  return {
    type: 'restore',
    replay,
    ansi,
    html,
    cols: snap.cols,
    rows: snap.rows,
    cursorRow: snap.cursorRow,
    cursorCol: snap.cursorCol,
    isAltScreen: snap.isAltScreen,
    server: {
      snapshotMs: round(snapMs),
      ansiMs: round(ansiMs),
      ansiBytes: ansi.length,
      htmlBytes: html.length,
      replayBytes: replay.length,
      replayTruncated: holder.historyDropped,
      cols: holder.cols,
      rows: holder.rows,
      heldForMs: Date.now() - holder.startedAt,
      bytesFed: holder.bytes,
      avgFeedUs: holder.feeds ? round((holder.feedMs / holder.feeds) * 1000) : 0,
    },
  };
}

const round = (n) => Math.round(n * 100) / 100;

// ---------- http ----------

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/panels', (_req, res) => {
  res.json({
    cols: COLS,
    rows: ROWS,
    tmux: USE_TMUX,
    ghostty: ghostty
      ? { ok: true, ...ghostty.getNativeInfo(), ...pkgInfo() }
      : { ok: false, error: ghosttyError },
    panels: PANELS.map((p) => ({
      ...p,
      alive: p.mode === 'ghostty' ? holders.has(p.id) : tmuxAlive(p.id),
      held: p.mode === 'ghostty' && holders.has(p.id),
    })),
  });
});

function pkgInfo() {
  try {
    const p = require('@coder/libghostty-vt-node/package.json');
    return { packageVersion: p.version };
  } catch {
    return {};
  }
}

/**
 * The server-side grid, as text, with no browser attached and no per-CLI
 * transcript parsing. The classic panel has no equivalent — that asymmetry is
 * the finding, so the endpoint answers honestly for both.
 */
app.get('/api/panels/:id/peek', (req, res) => {
  const panel = PANELS.find((p) => p.id === req.params.id);
  if (!panel) return res.status(404).json({ error: 'no such panel' });
  if (panel.mode !== 'ghostty') {
    return res.json({
      available: false,
      reason: 'The classic path streams bytes straight to the browser. With no client attached, the server has no idea what is on screen.',
    });
  }
  const holder = holders.get(panel.id);
  if (!holder) return res.json({ available: false, reason: 'Session not started yet. Open the lab once.' });
  const t0 = performance.now();
  const text = holder.vt.getVisibleText();
  let html = '';
  try { html = holder.vt.formatHtml ? holder.vt.formatHtml() : ''; } catch {}
  return res.json({
    available: true,
    text,
    html,
    ms: round(performance.now() - t0),
    lastByteAgeMs: holder.lastByteAt ? Date.now() - holder.lastByteAt : null,
  });
});

/** Type a prompt into a session with no browser attached. */
app.post('/api/panels/:id/prompt', async (req, res) => {
  const panel = PANELS.find((p) => p.id === req.params.id);
  if (!panel) return res.status(404).json({ error: 'no such panel' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'empty prompt' });

  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  // Enter must land as its own keypress: agent TUIs read a fast burst as a
  // paste and turn the CR into a newline in the composer instead of a submit.
  const gap = () => new Promise((r) => setTimeout(r, 300));

  try {
    if (panel.mode === 'ghostty') {
      const holder = ensureHolder(panel);
      holder.pty.write(payload);
      await gap();
      holder.pty.write('\r');
      return res.json({ ok: true, via: 'held pty' });
    }
    if (!USE_TMUX) return res.status(409).json({ error: 'classic panel needs an attached browser without tmux' });
    if (!tmuxAlive(panel.id)) {
      const args = [];
      if (fs.existsSync(TMUX_CONF)) args.push('-f', TMUX_CONF);
      args.push('new-session', '-d', '-s', tmuxName(panel.id), '-c', workdirFor(panel),
        '-x', String(COLS), '-y', String(ROWS), 'sh', '-lc', commandFor(panel.id));
      execFileSync('tmux', args, { stdio: 'ignore', env: TERM_ENV });
      markStarted(panel.id);
      await new Promise((r) => setTimeout(r, 3500)); // let the TUI boot
    }
    execFileSync('tmux', ['send-keys', '-t', tmuxName(panel.id), '-l', '--', payload], { stdio: 'ignore' });
    await gap();
    execFileSync('tmux', ['send-keys', '-t', tmuxName(panel.id), 'Enter'], { stdio: 'ignore' });
    return res.json({ ok: true, via: 'tmux send-keys' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

/** Kill a session so the next attach starts a fresh conversation. */
app.post('/api/panels/:id/restart', (req, res) => {
  const panel = PANELS.find((p) => p.id === req.params.id);
  if (!panel) return res.status(404).json({ error: 'no such panel' });
  const holder = holders.get(panel.id);
  if (holder) {
    holders.delete(panel.id);
    try { holder.pty.kill(); } catch {}
    try { holder.vt.dispose(); } catch {}
  }
  if (USE_TMUX) {
    try { execFileSync('tmux', ['kill-session', '-t', tmuxName(panel.id)], { stdio: 'ignore' }); } catch {}
  }
  const state = readState();
  delete state[panel.id];
  writeState(state);
  res.json({ ok: true });
});

app.use(express.static(PUBLIC_DIR));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ghostty-lab on :${PORT}  (tmux=${USE_TMUX}, libghostty=${ghostty ? 'ok' : 'MISSING'})`);
  console.log(`  workspaces: ${WORKSPACES}`);
});

// ---------- websockets ----------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/ws\/([a-z]+)$/);
  const panel = m && PANELS.find((p) => p.id === m[1]);
  if (!panel) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, panel));
});

const sendCtrl = (ws, obj) => {
  if (ws.readyState === 1) ws.send(CTRL + JSON.stringify(obj));
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

/** Parse a client control frame, or null if this is ordinary keyboard input. */
function readCtrl(raw) {
  if (!raw.startsWith(CTRL)) return null;
  try { return JSON.parse(raw.slice(CTRL.length)); } catch { return null; }
}

function attachClient(ws, panel) {
  if (panel.mode === 'ghostty') return attachHeld(ws, panel);
  return attachClassic(ws, panel);
}

/**
 * Classic path, exactly as agent-manager does it today: a fresh PTY per browser
 * attach. tmux replays the screen by REDRAWING it, so first paint waits on the
 * round trip and on whatever the inner TUI decides to emit.
 */
function attachClassic(ws, panel) {
  let term;
  try {
    term = spawnPty(panel);
  } catch (err) {
    sendCtrl(ws, { type: 'error', message: String(err.message || err) });
    return ws.close(4001, 'spawn failed');
  }

  sendCtrl(ws, { type: 'hello', mode: 'classic', cols: COLS, rows: ROWS });

  term.onData((chunk) => {
    if (ws.readyState === 1) ws.send(chunk);
  });
  term.onExit(() => {
    if (ws.readyState === 1) ws.close(4000, 'session exited');
  });

  ws.on('message', (data, isBinary) => {
    const s = isBinary ? data.toString('utf8') : String(data);
    const ctrl = readCtrl(s);
    if (ctrl) {
      // Resizing the PTY resizes tmux's window, which is exactly how production
      // behaves — including whatever the inner TUI does about reflow.
      if (ctrl.type === 'resize') {
        try { term.resize(clamp(ctrl.cols, 20, 400), clamp(ctrl.rows, 5, 200)); } catch {}
      }
      return;
    }
    try { term.write(s); } catch {}
  });

  // Killing the PTY only detaches the tmux client; the session keeps running.
  ws.on('close', () => { try { term.kill(); } catch {} });
}

/**
 * Held path: the terminal already exists server-side. The browser gets a
 * snapshot immediately and then rides the live byte stream.
 */
function attachHeld(ws, panel) {
  let holder;
  try {
    holder = ensureHolder(panel);
  } catch (err) {
    sendCtrl(ws, { type: 'error', message: String(err.message || err) });
    return ws.close(4001, 'holder failed');
  }

  sendCtrl(ws, { type: 'hello', mode: 'ghostty', cols: COLS, rows: ROWS });
  sendCtrl(ws, restoreFrame(holder));

  holder.clients.add(ws);

  ws.on('message', (data, isBinary) => {
    const s = isBinary ? data.toString('utf8') : String(data);
    const ctrl = readCtrl(s);
    if (ctrl) {
      // The PTY and the server's grid resize together, so libghostty reflows the
      // held scrollback itself. Last writer wins, matching tmux's window-size=latest.
      // A client REQUESTS a size; it does not get to impose one. The shared grid
      // is recomputed from every viewer and broadcast back.
      if (ctrl.type === 'resize') {
        holder.sizes.set(ws, { cols: clamp(ctrl.cols, 20, 400), rows: clamp(ctrl.rows, 5, 200) });
        if (!applyGrid(holder)) {
          // Already the right size, but this client may not know that yet.
          sendCtrl(ws, { type: 'grid', cols: holder.cols, rows: holder.rows, shared: holder.sizes.size > 1, viewers: holder.clients.size });
        }
      }
      return;
    }
    try { holder.pty.write(s); } catch {}
  });

  // Note the asymmetry: closing a browser tab does NOT kill anything here. The
  // server keeps the terminal warm, which is what makes the return trip cheap.
  // Dropping the client's size claim lets the grid grow back for whoever is left.
  ws.on('close', () => {
    holder.clients.delete(ws);
    holder.sizes.delete(ws);
    applyGrid(holder);
  });
}

// Start the held terminal at boot so "come back later" is a real test: the
// session has been running and producing output while nobody was watching.
if (ghostty && process.env.LAB_EAGER !== '0') {
  const b = PANELS.find((p) => p.mode === 'ghostty');
  setTimeout(() => {
    try { ensureHolder(b); } catch (err) { console.warn('eager holder failed:', err.message); }
  }, 1500);
}

process.on('SIGTERM', () => {
  for (const h of holders.values()) { try { h.pty.kill(); } catch {} }
  process.exit(0);
});
