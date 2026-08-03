// Invariants for the server-held terminal model.
//
// The contract is explicit rather than heuristic: shell output uses ordinary
// reflow, while known primary-screen agent TUIs settle their SIGWINCH repaint in
// a scratch terminal so presentation bytes never become history. Exactly one
// viewer controls input and PTY geometry; Ghostty remains the durable authority.
//   node resize.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  TERMINAL_HISTORY_VERSION, createTerminalHistoryCheckpoint, loadTerminalHistory,
  traceHistoryLines,
} from './src/history-store.js';
import { mergeRepaintArchive, repaintArchiveView } from './src/runner.js';
import { snapshotToRestoreAnsi, styledTerminalRows } from './src/snapshot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-resize-'));
const FIXTURE = path.join(HERE, 'fixtures', 'repaint-tui.mjs');
const PORT = 7895;
const CTRL = '\x00\x00AM:';
const base = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};

const srv = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    AM_BASHRC: '/nonexistent',
    AM_HISTORY_SAVE_MS: '50',
    AM_STARTUP_CAPTURE_IDLE_MS: '300',
    AM_STARTUP_CAPTURE_MAX_MS: '3000',
    AM_TEST_REPAINT_CMD: `env FIXED_LINES=30 HISTORY_LINES=2105 DELAY_RESUME_MS=180 ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (data) => { log += data; });
srv.stderr.on('data', (data) => { log += data; });

let Headless = null;
try { Headless = (await import('@xterm/headless')).default.Terminal; } catch {}

function view(id, cols, rows, mirror = false) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?session=${id}&cols=${cols}&rows=${rows}`);
    const term = mirror && Headless
      ? new Headless({ cols, rows, scrollback: 20000, allowProposedApi: true })
      : null;
    const v = {
      bytes: '', frames: [], events: [], term,
      type: (data) => ws.send(JSON.stringify({ t: 'i', d: data })),
      resize: (nextCols, nextRows) => ws.send(JSON.stringify({ t: 'r', cols: nextCols, rows: nextRows })),
      claim: () => ws.send(JSON.stringify({ t: 'claim' })),
      lastFrame: (type) => [...v.frames].reverse().find((frame) => frame.t === type) || null,
      countFrames: (type) => v.frames.filter((frame) => frame.t === type).length,
      open: () => ws.readyState === WebSocket.OPEN,
      close: () => { try { ws.close(); } catch {} },
      screenText: async () => {
        if (!term) return '';
        await new Promise((done) => term.write('', done));
        const buf = term.buffer.active;
        let text = '';
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          const row = line?.translateToString(true) ?? '';
          // Snapshot restores use absolute cursor painting, which cannot carry
          // xterm's private isWrapped bit. A full row is nevertheless a visual
          // wrap and must be joined before checking transcript completeness.
          if (i > 0 && !line?.isWrapped) {
            const previous = buf.getLine(i - 1)?.translateToString(true) ?? '';
            if (previous.length < term.cols) text += '\n';
          }
          text += row;
        }
        return text;
      },
      scrollsBack: async () => {
        if (!term) return false;
        await new Promise((done) => term.write('', done));
        const buf = term.buffer.active;
        const bottom = buf.baseY;
        term.scrollToTop();
        const top = buf.viewportY;
        term.scrollToBottom();
        return bottom > 0 && top < bottom && buf.viewportY === bottom;
      },
      bufferState: async () => {
        if (!term) return null;
        await new Promise((done) => term.write('', done));
        const buf = term.buffer.active;
        const initialViewport = buf.viewportY;
        let coloredHistoryCells = 0;
        for (let y = 0; y < buf.baseY; y++) {
          const line = buf.getLine(y);
          if (!line) continue;
          for (let x = 0; x < line.length; x++) {
            const cell = line.getCell(x);
            if (cell?.getChars() && (!cell.isFgDefault() || !cell.isBgDefault())) {
              coloredHistoryCells++;
            }
          }
        }
        term.scrollToTop();
        const top = buf.viewportY;
        term.scrollToBottom();
        return {
          historyRows: buf.baseY,
          initialViewport,
          atBottom: initialViewport === buf.baseY,
          canReachBothEnds: buf.baseY > 0 && top === 0 && buf.viewportY === buf.baseY,
          coloredHistoryCells,
        };
      },
    };
    ws.on('message', (data) => {
      const text = data.toString('utf8');
      if (text.startsWith(CTRL)) {
        let frame;
        try { frame = JSON.parse(text.slice(CTRL.length)); } catch { return; }
        v.frames.push(frame);
        v.events.push({ type: 'frame', frame });
        if (term && (frame.t === 'grid' || frame.t === 'restore')) {
          const applyGrid = () => {
            if (frame.reset) { term.reset(); term.clear(); }
            if (frame.cols > 0 && frame.rows > 0
                && (term.cols !== frame.cols || term.rows !== frame.rows)) {
              term.resize(frame.cols, frame.rows);
            }
          };
          const geometryChanged = frame.cols > 0 && frame.rows > 0
            && (term.cols !== frame.cols || term.rows !== frame.rows);
          if (frame.reset || geometryChanged) term.write('', applyGrid);
          else applyGrid();
        }
      } else {
        v.bytes += text;
        v.events.push({ type: 'data', text });
        if (term) term.write(text);
      }
    });
    ws.on('open', () => resolve(v));
    ws.on('error', () => resolve(v));
  });
}

async function session(name, cli = 'shell') {
  const created = await (await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli, name }),
  })).json();
  if (!created.id) throw new Error(`no session: ${JSON.stringify(created).slice(0, 200)}`);
  return created.id;
}

const gridText = async (id, lines = 2000) => {
  const response = await fetch(`${base}/api/agents/${id}/tail?lines=${lines}`);
  const body = await response.json();
  return typeof body === 'string' ? body : (body.text || body.tail || '');
};

/** Every fixture token is unique, so repeats prove a frame entered history twice. */
function duplicateTokens(text) {
  const counts = new Map();
  for (const match of text.matchAll(/\b\d{3}\.\d{2}\b/g)) {
    counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

const uniqueTokens = (text) => new Set(text.match(/\b\d{3}\.\d{2}\b/g) || []).size;

const stop = async (id) => {
  await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' }).catch(() => {});
  await sleep(250);
};

try {
  {
    const directory = fs.mkdtempSync(path.join(DATA_DIR, 'history-schema-'));
    const legacyFile = path.join(directory, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, cols: 80, lines: ['old'] }));
    check('legacy checkpoints remain readable for unaffected shell sessions',
      loadTerminalHistory(directory, 'legacy')?.version === 1);

    const checkpoint = createTerminalHistoryCheckpoint({
      directory, id: 'current', delayMs: 1,
      snapshot: () => ({
        cols: 90, scrollbackLines: [{ text: 'clean', ansi: '\x1b[38;5;2mclean\x1b[0m' }],
      }),
      blocked: () => false,
    });
    checkpoint.flush();
    const wrote = await waitFor(() => loadTerminalHistory(directory, 'current')?.version
      === TERMINAL_HISTORY_VERSION);
    check('new checkpoints use the clean startup generation', wrote);
    check('checkpoints retain validated scrollback styling',
      loadTerminalHistory(directory, 'current')?.lines[0]?.ansi
      === '\x1b[38;5;2mclean\x1b[0m');

    const styled = styledTerminalRows({
      cols: 20, rows: 1,
      scrollbackLines: [{ row: 0, text: 'red history' }],
      visibleLines: [{ row: 0, text: 'live' }],
    }, '<div style="font-family: monospace; white-space: pre;"><div style="display: inline;color: var(--vt-palette-1);">red history</div>\nlive</div>');
    const restore = snapshotToRestoreAnsi({
      cols: 20, rows: 1, cursorRow: 0, cursorCol: 0, cells: [],
      scrollbackLines: styled.slice(0, 1),
    });
    check('Ghostty HTML scrollback colors convert back to ANSI',
      styled[0].ansi?.includes('\x1b[38;5;1m')
      && restore.includes('\x1b[38;5;1mred history'));
  }

  {
    const recovered = traceHistoryLines({ turns: [
      { role: 'user', blocks: [{ type: 'text', text: 'older prompt' }] },
      { role: 'assistant', kind: 'final', blocks: [{ type: 'text', text: 'older answer' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'live prompt' }] },
      { role: 'assistant', kind: 'final', blocks: [{ type: 'text', text: 'live answer' }] },
    ] });
    const text = recovered.map((line) => line.text).join('\n');
    check('trace recovery seeds only turns older than the live viewport',
      text.includes('older prompt') && text.includes('older answer')
      && !text.includes('live prompt') && !text.includes('live answer'));

    const alreadyVisible = traceHistoryLines({ turns: [
      { role: 'user', blocks: [{ type: 'text', text: 'hi there' }] },
      { role: 'assistant', kind: 'final', blocks: [{ type: 'text', text: 'Hey!' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'live prompt' }] },
    ] }, '❯ hi there\n\n● Hey!');
    check('trace recovery does not duplicate short turns replayed by the agent',
      alreadyVisible.length === 0);

    const archiveSeed = 'older unique turn\n❯ hi there\n\n● Hey!\n';
    const wide = 'Claude welcome frame\nolder unique turn\n❯ hi there\n\n● Hey!\nnewer live turn\n';
    const archive = mergeRepaintArchive(archiveSeed, wide);
    check('a wide repaint merges recovered turns into one full archive',
      archive === wide && archive.split('❯ hi there').length - 1 === 1);
    check('a wide repaint needs no duplicate scrollback',
      repaintArchiveView(archive, wide).history.length === 0);
    const narrow = 'newer live turn\n';
    const narrowView = repaintArchiveView(archive, narrow);
    const narrowHistory = narrowView.history.map((line) => line.text).join('\n');
    check('a narrow repaint restores the archive prefix above the viewport',
      narrowHistory.includes('Claude welcome frame') && narrowHistory.includes('❯ hi there'));
    check('a repaint replaces a volatile old footer after its transcript overlap',
      repaintArchiveView('deep history\nshared transcript\n[old 160x40]\n',
        'shared transcript\n[new 90x24]\n').archive
      === 'deep history\nshared transcript\n[new 90x24]\n');
    const poem = '❯ write me a poem about silicon\n\n● Silicon\n\n'
      + 'Second most common thing underfoot, plain as the beach you forget while you walk it —\n'
      + 'Someone thought to melt it, draw it out into a single perfect column, one lattice unbroken.\n';
    const volatilePrefix = repaintArchiveView(
      `older unique turn\n${poem}✻ Worked for 8s\n[old footer]\n`,
      `✻ Worked for 2s\n${poem}✻ Worked for 8s\n[new footer]\n`,
    ).archive;
    check('a volatile leading status cannot anchor after and duplicate the repainted turn',
      volatilePrefix.split('❯ write me a poem about silicon').length - 1 === 1
      && volatilePrefix.includes('[new footer]') && !volatilePrefix.includes('[old footer]'));
    check('zooming wide again exposes the archive without growing it',
      repaintArchiveView(narrowView.archive, wide).archive === wide);
  }

  const up = await waitFor(async () => {
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, 100_000);
  if (!up) throw new Error(`server never came up:\n${log.slice(-1200)}`);

  // A long logical line must survive ordinary Ghostty reflow. The former
  // screen-carry path cropped the right side before rebuilding a narrower grid.
  {
    const id = await session('long line reflow');
    const v = await view(id, 110, 24, true);
    await sleep(700);
    v.type(`printf 'LONG-%s-END-SENTINEL\\n' "$(printf 'x%.0s' {1..90})"\r`);
    const printed = await waitFor(async () => (await gridText(id)).includes('END-SENTINEL'));
    check('long line is present before resize', printed);
    v.resize(60, 24);
    const resized = await waitFor(() => v.lastFrame('grid')?.cols === 60);
    check('resize settles at the requested geometry', resized, JSON.stringify(v.lastFrame('grid')));
    const after = await gridText(id);
    check('narrowing does not crop the right side of a logical line', after.includes('END-SENTINEL'));
    check('resize does not retransmit all history', v.lastFrame('grid')?.reset === false);
    if (Headless) check('the ordered viewer reflow also retains the line', (await v.screenText()).includes('END-SENTINEL'));
    v.close();
    await stop(id);
  }

  // The geometry frame must precede output triggered by SIGWINCH. Otherwise a
  // TUI's repaint is interpreted at the old size and only reflowed afterward,
  // which can leave duplicate or displaced rows in a browser emulator.
  {
    const id = await session('ordered repaint');
    const v = await view(id, 100, 30, true);
    await sleep(500);
    v.type(`trap 'printf "\\033[2J\\033[HRESIZE-AT-%sx%s\\n" "$COLUMNS" "$LINES"' WINCH; printf 'TRAP-READY\\n'\r`);
    await waitFor(() => v.bytes.includes('TRAP-READY'));
    v.events.length = 0;
    v.resize(73, 21);
    const repainted = await waitFor(() => v.events.some((event) => event.type === 'data'
      && event.text.includes('RESIZE-AT-73x21')));
    const gridAt = v.events.findIndex((event) => event.type === 'frame'
      && event.frame.t === 'grid' && event.frame.cols === 73 && event.frame.rows === 21);
    const repaintAt = v.events.findIndex((event) => event.type === 'data'
      && event.text.includes('RESIZE-AT-73x21'));
    check('SIGWINCH repaint arrives after the confirmed grid', repainted && gridAt >= 0 && gridAt < repaintAt,
      `grid event ${gridAt}, repaint event ${repaintAt}`);
    if (Headless) {
      const screen = await v.screenText();
      check('ordered repaint is rendered once', screen.split('RESIZE-AT-73x21').length - 1 === 1);
    }
    v.close();
    await stop(id);
  }

  // Claude-style primary-screen TUIs print a complete frame on every SIGWINCH.
  // Some frames are taller than the pane; streaming those repaint bytes would
  // archive another welcome/conversation copy on every zoom step. Agent resizes
  // therefore settle in a scratch terminal and commit only the final screen.
  {
    const id = await session('captured agent repaint', 'test-repaint');
    const v = await view(id, 150, 40, true);
    const painted = await waitFor(async () => (await gridText(id)).includes('[fixture 150x40]'));
    check('Claude-style fixture paints its initial frame', painted);
    const beforeGrid = duplicateTokens(await gridText(id));
    const initialGridText = await gridText(id);
    const initialBrowserText = Headless ? await v.screenText() : '';
    const beforeBrowser = Headless ? duplicateTokens(initialBrowserText) : 0;
    const initialGridTokens = uniqueTokens(initialGridText);
    const initialBrowserTokens = Headless ? uniqueTokens(initialBrowserText) : 0;
    check('fixture starts without duplicate history', beforeGrid === 0 && beforeBrowser === 0,
      `grid=${beforeGrid}, browser=${beforeBrowser}`);
    if (Headless) {
      check('fixture starts with deep history', initialBrowserText.includes('history-0001'));
      check('browser viewport can scroll through that history', await v.scrollsBack());
      const state = await v.bufferState();
      check('fixture starts at the live bottom', state?.atBottom, JSON.stringify(state));
      check('fixture starts with styled history', state?.coloredHistoryCells > 0,
        JSON.stringify(state));
    }

    for (const [cols, rows] of [[120, 32], [90, 24], [120, 32], [150, 40]]) {
      v.resize(cols, rows);
      const settled = await waitFor(() => v.lastFrame('grid')?.cols === cols
        && v.lastFrame('grid')?.rows === rows);
      check(`agent repaint settles at ${cols}x${rows}`, settled, JSON.stringify(v.lastFrame('grid')));
      await sleep(150);
      const stepGridText = await gridText(id);
      check(`canonical history stays unique at ${cols}x${rows}`, duplicateTokens(stepGridText) === beforeGrid,
        `${duplicateTokens(stepGridText)} duplicate tokens`);
      if (Headless) {
        const stepBrowserText = await v.screenText();
        check(`browser history stays unique at ${cols}x${rows}`, duplicateTokens(stepBrowserText) === beforeBrowser,
          `${duplicateTokens(stepBrowserText)} duplicate tokens`);
        check(`browser history stays complete at ${cols}x${rows}`,
          uniqueTokens(stepBrowserText) === initialBrowserTokens,
          `${initialBrowserTokens} before, ${uniqueTokens(stepBrowserText)} after`);
        check(`browser deep history survives at ${cols}x${rows}`,
          stepBrowserText.includes('history-0001'));
        const state = await v.bufferState();
        check(`browser reaches both history ends at ${cols}x${rows}`,
          state?.canReachBothEnds, JSON.stringify(state));
        check(`browser remains at the live bottom at ${cols}x${rows}`,
          state?.atBottom, JSON.stringify(state));
        check(`styled history survives at ${cols}x${rows}`,
          state?.coloredHistoryCells > 0, JSON.stringify(state));
      }
    }

    const finalGridText = await gridText(id);
    const afterGrid = duplicateTokens(finalGridText);
    check('zoom round-trip adds no duplicate frame to canonical history', afterGrid === beforeGrid,
      `${beforeGrid} before, ${afterGrid} after`);
    check('zoom round-trip retains canonical history', uniqueTokens(finalGridText) === initialGridTokens,
      `${initialGridTokens} before, ${uniqueTokens(finalGridText)} after`);
    if (Headless) {
      const finalBrowserText = await v.screenText();
      const afterBrowser = duplicateTokens(finalBrowserText);
      check('zoom round-trip adds no duplicate frame to browser history', afterBrowser === beforeBrowser,
        `${beforeBrowser} before, ${afterBrowser} after`);
      check('zoom round-trip retains browser history', uniqueTokens(finalBrowserText) === initialBrowserTokens,
        `${initialBrowserTokens} before, ${uniqueTokens(finalBrowserText)} after`);
    }
    v.close();
    await sleep(250);
    const reattached = await view(id, 150, 40, true);
    const restored = await waitFor(() => reattached.lastFrame('restore')?.cols === 150);
    const restoredText = Headless ? await reattached.screenText() : '';
    check('reattach remains free of resize-generated frames', restored
      && (!Headless || duplicateTokens(restoredText) === beforeGrid),
    Headless ? `${duplicateTokens(restoredText)} duplicate tokens` : '');
    check('reattach retains complete and deep history', restored
      && (!Headless || (uniqueTokens(restoredText) === initialBrowserTokens
        && restoredText.includes('history-0001'))));
    if (Headless) {
      const state = await reattached.bufferState();
      check('reattach reaches both history ends and starts at bottom',
        state?.canReachBothEnds && state?.atBottom, JSON.stringify(state));
      check('reattach retains styled history', state?.coloredHistoryCells > 0,
        JSON.stringify(state));
    }
    reattached.close();
    await stop(id);

    // Stopping the PTY models a backend restart: a new host must load its
    // durable checkpoint before the resumed TUI paints, without duplicating
    // either the old frame or its welcome banner.
    const checkpoint = path.join(DATA_DIR, 'state', 'terminal-history', `${id}.json`);
    check('terminal history is checkpointed durably', await waitFor(() => fs.existsSync(checkpoint)));
    // A mobile pane opens its socket with xterm's provisional 80x24 geometry,
    // then reports the measured phone grid as soon as layout settles. Exercise
    // that change while the resumed TUI is still repainting, not only after the
    // startup transaction has committed.
    const restarted = await view(id, 80, 24, true);
    restarted.resize(40, 28);
    const resumed = await waitFor(async () => (await gridText(id)).includes('[fixture 40x28]'));
    const startupCommitted = await waitFor(() => restarted.frames.some((frame) =>
      frame.t === 'grid' && frame.reset));
    await sleep(350);
    const restartedText = Headless ? await restarted.screenText() : '';
    const restartDuplicates = Headless ? duplicateTokens(restartedText) : 0;
    check('host restart restores deep scrollback', resumed
      && (!Headless || restartedText.includes('history-0001')));
    check('delayed startup repaint commits as one transaction', startupCommitted);
    check('host restart does not duplicate delayed repaint content', !Headless
      || restartDuplicates === beforeBrowser,
    Headless ? `${restartDuplicates} duplicate tokens` : '');
    if (Headless) {
      check('host restart retains exact transcript cardinality',
        uniqueTokens(restartedText) === initialBrowserTokens,
        `${initialBrowserTokens} before, ${uniqueTokens(restartedText)} after`);
      const state = await restarted.bufferState();
      check('restored viewport reaches both ends and starts at bottom',
        state?.canReachBothEnds && state?.atBottom, JSON.stringify(state));
      check('host restart retains styled history', state?.coloredHistoryCells > 0,
        JSON.stringify(state));
    }

    // Exercise the actual failure combination: after a delayed restart, a
    // second viewer takes the geometry lease, zooms narrow, then zooms wide.
    // Every transition must preserve the same transcript and scroll model.
    const takeover = await view(id, 110, 28, true);
    await sleep(150);
    takeover.claim();
    const claimed = await waitFor(() => takeover.lastFrame('grid')?.controller === true
      && takeover.lastFrame('grid')?.cols === 110 && takeover.lastFrame('grid')?.rows === 28);
    check('post-restart watcher claims the narrow zoom geometry', claimed,
      JSON.stringify(takeover.lastFrame('grid')));
    await sleep(150);
    if (Headless) {
      const narrowText = await takeover.screenText();
      const state = await takeover.bufferState();
      check('post-restart narrow zoom keeps one complete transcript',
        duplicateTokens(narrowText) === beforeBrowser
        && uniqueTokens(narrowText) === initialBrowserTokens,
        `${duplicateTokens(narrowText)} duplicates, ${uniqueTokens(narrowText)} tokens`);
      check('post-restart narrow zoom keeps scroll and styling',
        state?.canReachBothEnds && state?.atBottom && state?.coloredHistoryCells > 0,
        JSON.stringify(state));
    }
    takeover.resize(150, 40);
    const widened = await waitFor(() => takeover.lastFrame('grid')?.cols === 150
      && takeover.lastFrame('grid')?.rows === 40);
    check('post-restart controller zooms wide again', widened,
      JSON.stringify(takeover.lastFrame('grid')));
    await sleep(150);
    if (Headless) {
      const wideText = await takeover.screenText();
      const state = await takeover.bufferState();
      check('post-restart wide zoom keeps one complete transcript',
        duplicateTokens(wideText) === beforeBrowser
        && uniqueTokens(wideText) === initialBrowserTokens,
        `${duplicateTokens(wideText)} duplicates, ${uniqueTokens(wideText)} tokens`);
      check('post-restart wide zoom keeps scroll and styling',
        state?.canReachBothEnds && state?.atBottom && state?.coloredHistoryCells > 0,
        JSON.stringify(state));
    }
    takeover.close();
    restarted.close();
    await stop(id);
  }

  // A drag should issue one final resize, not one SIGWINCH per animation frame.
  {
    const id = await session('resize storm');
    const v = await view(id, 120, 40);
    await sleep(400);
    for (let i = 0; i < 16; i++) {
      v.resize(120 - i * 2, 40 - i);
      await sleep(25);
    }
    v.resize(88, 24);
    const settled = await waitFor(() => v.lastFrame('grid')?.cols === 88 && v.lastFrame('grid')?.rows === 24);
    check('resize storm settles at its final size', settled, JSON.stringify(v.lastFrame('grid')));
    check('resize storm is coalesced', v.countFrames('grid') <= 3, `${v.countFrames('grid')} grid frames`);
    v.close();
    await stop(id);
  }

  // Low zoom on a large/high-DPI panel can legitimately exceed the former
  // 400x200 cap. The safety bound must not create dead space in that range.
  {
    const id = await session('large panel');
    const v = await view(id, 120, 40);
    await sleep(300);
    v.resize(640, 300);
    const expanded = await waitFor(() => v.lastFrame('grid')?.cols === 640
      && v.lastFrame('grid')?.rows === 300);
    check('large low-zoom panel is not clipped to the legacy grid cap', expanded,
      JSON.stringify(v.lastFrame('grid')));
    v.close();
    await stop(id);
  }

  // Reattachment is serialized from Ghostty state, not from a 256 KiB suffix
  // of raw PTY traffic. Both the oldest and newest retained rows must return.
  {
    const id = await session('full canonical restore');
    const a = await view(id, 110, 30);
    await sleep(600);
    a.type(`for i in $(seq 1 4500); do printf 'RESTORE-%04d-%070d\\n' "$i" "$i"; done\r`);
    const complete = await waitFor(async () => (await gridText(id, 5000)).includes('RESTORE-4500-'), 20_000);
    check('large history finishes printing', complete);
    a.close();
    await sleep(300);
    const b = await view(id, 110, 30, true);
    const restored = await waitFor(() => b.bytes.includes('RESTORE-4500-'), 12_000);
    check('reattach receives the canonical restore', restored && !!b.lastFrame('restore'));
    check('restore is not capped at the old raw replay limit', b.bytes.length > 262_144, `${b.bytes.length} bytes`);
    check('restore includes the oldest retained output', b.bytes.includes('RESTORE-0001-'));
    check('restore includes the newest retained output', b.bytes.includes('RESTORE-4500-'));
    if (Headless) {
      const rendered = await b.screenText();
      check('a fresh emulator can scroll to the oldest restored output', rendered.includes('RESTORE-0001-'));
      check('a fresh emulator contains the newest restored output', rendered.includes('RESTORE-4500-'));
    }
    b.close();
    await stop(id);
  }

  // One viewer owns both input and size. A watcher has no effect until an
  // explicit claim, after which the old controller becomes inert.
  {
    const id = await session('controller lease');
    const a = await view(id, 120, 35);
    await sleep(400);
    const b = await view(id, 60, 20);
    await sleep(400);
    check('first viewer is the controller', a.lastFrame('grid')?.controller === true
      && b.lastFrame('restore')?.controller === false);
    b.resize(50, 15);
    await sleep(400);
    check('watcher size cannot shrink the session', b.lastFrame('restore')?.cols === 120
      && !b.frames.some((frame) => frame.t === 'grid' && frame.cols === 50));
    b.type('echo WATCHER-MUST-NOT-RUN\r');
    await sleep(400);
    check('watcher input is rejected by the server', !a.bytes.includes('WATCHER-MUST-NOT-RUN'));

    b.claim();
    const claimed = await waitFor(() => b.lastFrame('grid')?.controller === true
      && b.lastFrame('grid')?.cols === 50 && b.lastFrame('grid')?.rows === 15);
    check('watcher can claim input and geometry together', claimed, JSON.stringify(b.lastFrame('grid')));
    b.type('echo CONTROLLER-RAN\r');
    check('new controller input reaches every viewer', await waitFor(() => a.bytes.includes('CONTROLLER-RAN')
      && b.bytes.includes('CONTROLLER-RAN')));
    a.resize(140, 45);
    await sleep(400);
    check('old controller becomes an inert watcher', b.lastFrame('grid')?.cols === 50
      && b.lastFrame('grid')?.rows === 15);

    b.close();
    const handed = await waitFor(() => a.lastFrame('grid')?.controller === true
      && a.lastFrame('grid')?.cols === 140 && a.lastFrame('grid')?.rows === 45);
    check('controller lease passes to a remaining viewer on disconnect', handed, JSON.stringify(a.lastFrame('grid')));
    a.close();
    await stop(id);
  }

  // Focus and unrelated layout events may re-report the same preference.
  {
    const id = await session('no-op size');
    const v = await view(id, 80, 24);
    await sleep(300);
    const before = v.countFrames('grid');
    for (let i = 0; i < 5; i++) v.resize(80, 24);
    await sleep(500);
    check('re-reporting the current size performs no reset', v.countFrames('grid') === before,
      `${v.countFrames('grid') - before} extra frames`);
    v.close();
    await stop(id);
  }
} catch (err) {
  check('no exceptions', false, String(err && err.message ? err.message : err));
  console.log('--- server log tail ---\n' + log.slice(-1600));
} finally {
  srv.kill('SIGTERM');
  await sleep(500);
  srv.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
