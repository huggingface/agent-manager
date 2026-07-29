// Local smoke test: boots the server with a fake (cheap) session command and
// checks both attach paths end to end. Not shipped to the Space.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 7899;
const CTRL = '\x00\x00LAB:';
// More lines than the 32-row grid, so the held terminal accumulates real
// scrollback for the restore to replay.
const FAKE = `i=1; while [ $i -le 60 ]; do printf '\\033[1;32m>\\033[0m line %s . \\033[33mcolour\\033[0m\\r\\n' $i; i=$((i+1)); done; printf '\\033[1;36m+- ready -+\\033[0m\\r\\n'; sleep 600`;

const srv = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: './.smoke', LAB_COMMAND: FAKE, LAB_EAGER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`));
srv.stderr.on('data', (d) => process.stdout.write(`  [srv!] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://localhost:${PORT}`;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

/** A long-lived client whose control frames we can inspect as they arrive. */
function openWs(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/${id}`);
    const grids = [];
    ws.on('message', (data) => {
      const s = data.toString('utf8');
      if (!s.startsWith(CTRL)) return;
      try {
        const f = JSON.parse(s.slice(CTRL.length));
        if (f.type === 'grid') grids.push(f);
      } catch {}
    });
    ws.on('open', () => resolve({
      send: (obj) => ws.send(CTRL + JSON.stringify(obj)),
      lastGrid: () => grids[grids.length - 1] || null,
      open: () => ws.readyState === 1,
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}

function attach(id, ms = 4000, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/${id}`);
    const out = { ctrl: [], bytes: '', openedAt: 0, firstAt: 0, afterResize: '' };
    const t0 = Date.now();
    let resized = false;
    ws.on('open', () => {
      out.openedAt = Date.now() - t0;
      if (opts.resizeTo) {
        setTimeout(() => {
          resized = true;
          ws.send(`${CTRL}${JSON.stringify({ type: 'resize', ...opts.resizeTo })}`);
        }, Math.min(1500, ms / 2));
      }
    });
    ws.on('message', (data) => {
      const s = data.toString('utf8');
      if (!out.firstAt) out.firstAt = Date.now() - t0;
      if (s.startsWith(CTRL)) {
        try { out.ctrl.push(JSON.parse(s.slice(CTRL.length))); } catch {}
      } else {
        out.bytes += s;
        if (resized) out.afterResize += s;
      }
    });
    setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, ms);
  });
}

try {
  check('server boots', await waitHealthy());

  const cfg = await (await fetch(`${base}/api/panels`)).json();
  check('libghostty loaded', cfg.ghostty.ok, cfg.ghostty.ok ? `${cfg.ghostty.ghosttyVersion} ${cfg.ghostty.platform}/${cfg.ghostty.arch}` : cfg.ghostty.error);
  check('two panels', cfg.panels.length === 2);

  // Let the eagerly-started held terminal (1.5s delay) boot tmux, run the fake
  // command to completion, and sit idle — all with nobody watching.
  await sleep(7000);

  const b1 = await attach('ghostty');
  const restore = b1.ctrl.find((c) => c.type === 'restore');
  check('B sends restore frame', !!restore);
  check('B restore has ansi', !!restore && restore.ansi.length > 0, restore && `${restore.ansi.length}B`);
  check('B restore carries the screen', !!restore && restore.ansi.includes('ready'),
    restore && `snapshot ${restore.server.snapshotMs}ms, serialize ${restore.server.ansiMs}ms`);
  check('B restore has html preview', !!restore && restore.html.length > 0, restore && `${restore.htmlBytes ?? restore.html.length}B`);
  check('B held before attach', !!restore && restore.server.heldForMs > 4000, restore && `held ${restore.server.heldForMs}ms`);
  check('B repaint uses indexed palette, not baked truecolor',
    !!restore && /\x1b\[38;5;\d+m/.test(restore.ansi) && !/\x1b\[38;2;/.test(restore.ansi));
  check('B repaint has no tmux status bar', !!restore && !restore.ansi.includes('lab-ghost'));
  // Without this the client has nothing to scroll: the wheel moves an empty
  // viewport and ghostty-web never forwards it to the app.
  check('B restore replays scrollback bytes', !!restore && restore.server.replayBytes > 0,
    restore && `${restore.server.replayBytes}B`);
  check('B restore includes an early line', !!restore && restore.replay.includes('line 1 '));
  // Replaying raw bytes rather than snapshot lines is what keeps history coloured.
  check('B replayed history keeps colour', !!restore && /\x1b\[\d+(;\d+)*m.*line 1 /.test(restore.replay));

  const a1 = await attach('classic');
  check('A streams bytes', a1.bytes.length > 0, `${a1.bytes.length}B`);
  check('A has no restore frame', !a1.ctrl.some((c) => c.type === 'restore'));

  // The asymmetry the lab exists to show.
  const peekB = await (await fetch(`${base}/api/panels/ghostty/peek`)).json();
  check('B peek works detached', peekB.available && peekB.text.includes('ready'), `read in ${peekB.ms}ms`);
  const peekA = await (await fetch(`${base}/api/panels/classic/peek`)).json();
  check('A peek honestly unavailable', peekA.available === false);

  // Second attach to B: the terminal is already warm, no respawn.
  const b2 = await attach('ghostty', 2000);
  const restore2 = b2.ctrl.find((c) => c.type === 'restore');
  check('B reattach reuses the held terminal', !!restore2 && restore2.server.heldForMs > restore.server.heldForMs);

  // Resize: both paths must accept the control frame, and B's held grid must
  // follow the PTY so the next restore is snapshotted at the new size.
  const b3 = await attach('ghostty', 3500, { resizeTo: { cols: 132, rows: 40 } });
  check('B accepts resize', !!b3, `${b3.afterResize.length}B of repaint after resize`);
  const b4 = await attach('ghostty', 1500);
  const restore4 = b4.ctrl.find((c) => c.type === 'restore');
  check('B held grid resized with the PTY', !!restore4 && restore4.server.cols === 132 && restore4.server.rows === 40,
    restore4 && `${restore4.server.cols}×${restore4.server.rows}`);
  // Nothing in the repaint may address a row outside the resized grid.
  const rowsAddressed = [...(restore4?.ansi || '').matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
  check('B repaint stays inside the resized grid',
    rowsAddressed.length > 0 && Math.max(...rowsAddressed) <= 40, `max row ${Math.max(...rowsAddressed, 0)}`);

  const a2 = await attach('classic', 3500, { resizeTo: { cols: 120, rows: 36 } });
  check('A accepts resize without dropping the socket', a2.bytes.length > 0,
    `${a2.afterResize.length}B of repaint after resize`);

  // The distortion case: a desktop is attached, then a phone joins. Every viewer
  // must be told the shared grid, or the desktop keeps drawing narrow output
  // into its old wide geometry.
  const desktop = await openWs('ghostty');
  desktop.send({ type: 'resize', cols: 150, rows: 40 });
  await sleep(600);
  const phone = await openWs('ghostty');
  phone.send({ type: 'resize', cols: 40, rows: 20 });
  await sleep(800);

  const desktopGrid = desktop.lastGrid();
  const phoneGrid = phone.lastGrid();
  check('desktop is told the grid shrank', !!desktopGrid && desktopGrid.cols === 40 && desktopGrid.rows === 20,
    desktopGrid && `${desktopGrid.cols}×${desktopGrid.rows}`);
  check('both viewers agree on the grid',
    !!phoneGrid && desktopGrid.cols === phoneGrid.cols && desktopGrid.rows === phoneGrid.rows);
  check('grid is flagged shared', !!desktopGrid && desktopGrid.shared === true && desktopGrid.viewers === 2);
  check('neither viewer was disconnected', desktop.open() && phone.open());

  // ...and it grows back for whoever is left.
  phone.close();
  await sleep(800);
  const grown = desktop.lastGrid();
  check('grid grows back when the phone leaves', !!grown && grown.cols === 150 && grown.rows === 40,
    grown && `${grown.cols}×${grown.rows}`);
  check('grid no longer flagged shared', !!grown && grown.shared === false);
  desktop.close();

  // --- WS origin check --------------------------------------------------------
  // A cross-site wss:// handshake skips CORS and carries browser cookies, so it
  // must be refused before any session is touched.
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/ghostty`, { origin: 'https://evil.example' });
    ws.on('open', () => { try { ws.close(); } catch {} resolve(false); });
    ws.on('error', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  check('cross-site origin refused', rejected === true);
  const sameSite = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/ghostty`, { origin: `http://localhost:${PORT}` });
    ws.on('open', () => { try { ws.close(); } catch {} resolve(true); });
    ws.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  check('same-site origin accepted', sameSite === true);
  const noOrigin = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/ghostty`);
    ws.on('open', () => { try { ws.close(); } catch {} resolve(true); });
    ws.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  check('no-Origin client accepted (curl, native)', noOrigin === true);

  // --- state detection, both methods ------------------------------------------
  const st = await (await fetch(`${base}/api/state`)).json();
  check('B reports state from the grid', st.ghostty && st.ghostty.method === 'grid'
    && ['working', 'waiting', 'idle', 'stopped'].includes(st.ghostty.state), st.ghostty && `${st.ghostty.state}`);
  check('A reports state via tmux capture-pane', st.classic && st.classic.method === 'tmux capture-pane',
    st.classic && `${st.classic.state}`);
  // The whole argument for holding the grid: same answer, no subprocess.
  check('grid read is far cheaper than the tmux shell-out',
    st.ghostty.readMs < st.classic.readMs,
    `grid ${st.ghostty.readMs}ms vs tmux ${st.classic.readMs}ms`);
  console.log(`      grid sampling cost: ${st.ghostty.avgSampleMs}ms avg over ${st.ghostty.samples} samples (on the feed path, no polling)`);

  // A busy session must actually read as working.
  await fetch(`${base}/api/panels/ghostty/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'for i in 1 2 3 4 5 6 7 8; do echo working $i; sleep 0.4; done' }),
  });
  await sleep(1800);
  const busy = await (await fetch(`${base}/api/state`)).json();
  check('B detects a busy session as working', busy.ghostty.state === 'working',
    `${busy.ghostty.state}, text changed ${busy.ghostty.ageSecs}s ago`);
  await sleep(5000);
  const quiet = await (await fetch(`${base}/api/state`)).json();
  check('B detects a finished session as your-turn', quiet.ghostty.state === 'waiting',
    `${quiet.ghostty.state}, text changed ${quiet.ghostty.ageSecs}s ago`);
} catch (err) {
  check('no exceptions', false, String(err.message || err));
} finally {
  srv.kill('SIGTERM');
  await sleep(500);
  try {
    const { execFileSync } = await import('node:child_process');
    for (const s of ['lab-classic', 'lab-ghostty']) {
      try { execFileSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' }); } catch {}
    }
  } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
