// Resize behaviour of a server-held grid.
//
// The bug this pins down: resizing a pane duplicated content in the scrollback
// (the same lines re-wrapped at every width the pane passed through) and left
// the browser's buffer disagreeing with the grid. Three causes, all here:
//
//   * REFLOW. Narrowing rewraps the outgoing screen — a 119-column row becomes
//     two rows at 110 — and the excess scrolls up into scrollback, where the
//     TUI's repaint of that same screen leaves it stranded as a copy. One copy
//     per resize, so one per zoom click. Fixed by clearing the screen before the
//     reflow and carrying it across by hand.
//   * a resize STORM — ResizeObserver fires per animation frame while a window
//     is dragged, and every tick used to resize the PTY, so one drag paid the
//     above dozens of times. Fixed by coalescing.
//   * the browser reflowing ITSELF (fit.fit()) before the server confirmed, so
//     its scrollback was a byte log wrapped at mixed widths while the grid held
//     a properly reflowed one. Fixed by making the browser ask, not act.
//
// Every duplication check has teeth: AM_RESIZE_CARRY=0 restores plain reflow and
// the zoom checks fail (63 duplicated tokens in the grid, 101 in the browser).
//
// fixtures/repaint-tui.mjs stands in for an agent TUI and repaints exactly the
// way Claude Code does, so this costs no agent tokens.
//   node resize.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '.resize');
const FIXTURE = path.join(HERE, 'fixtures', 'repaint-tui.mjs');
const PORT = 7895;
const CTRL = '\x00\x00AM:';
const base = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

// The browser's own emulator, so a viewer can be checked the way a user sees it
// rather than only through the grid. Optional: it is a devDependency, and the
// suite still runs (minus those checks) in a production install.
let Headless = null;
try { Headless = (await import('@xterm/headless')).default.Terminal; } catch {}

function view(id, cols, rows, mirror = false) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?session=${id}&cols=${cols}&rows=${rows}`);
    // A stand-in for TerminalPane, mirroring its message handling EXACTLY — the
    // point is to catch the ordering hazard in it: xterm's write is asynchronous,
    // so a resize applied outside the write callback can overtake the bytes that
    // were sent before it.
    const term = mirror && Headless
      ? new Headless({ cols, rows, scrollback: 20000, allowProposedApi: true })
      : null;
    const v = {
      bytes: '', frames: [], term,
      type: (d) => ws.send(JSON.stringify({ t: 'i', d })),
      resize: (c, r) => ws.send(JSON.stringify({ t: 'r', cols: c, rows: r })),
      lastFrame: (t) => [...v.frames].reverse().find((f) => f.t === t) || null,
      countFrames: (t) => v.frames.filter((f) => f.t === t).length,
      close: () => { try { ws.close(); } catch {} },
      // Everything the viewer has: scrollback above the screen, then the screen.
      screenText: async () => {
        if (!term) return '';
        await new Promise((r) => term.write('', r));
        const buf = term.buffer.active;
        const out = [];
        for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
        return out.join('\n');
      },
    };
    ws.on('message', (data) => {
      const s = data.toString('utf8');
      if (s.startsWith(CTRL)) {
        let m = null;
        try { m = JSON.parse(s.slice(CTRL.length)); } catch { return; }
        v.frames.push(m);
        if (term && (m.t === 'grid' || m.t === 'restore') && m.cols > 0 && m.rows > 0
            && (term.cols !== m.cols || term.rows !== m.rows)) {
          if (m.clear) term.write('', () => term.resize(m.cols, m.rows));
          else term.resize(m.cols, m.rows);
        }
      } else {
        v.bytes += s;
        if (term) term.write(s);
      }
    });
    ws.on('open', () => resolve(v));
    ws.on('error', () => resolve(v));
  });
}

/** Tokens the fixture prints are unique, so a repeat is a duplicated line. */
function duplicateTokens(text) {
  const counts = new Map();
  for (const m of text.matchAll(/\b\d{3}\.\d{2}\b/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  return [...counts.values()].filter((n) => n > 1).length;
}

const gridText = async (id) => {
  const r = await (await fetch(`${base}/api/agents/${id}/tail?lines=500`)).json();
  return typeof r === 'string' ? r : (r.text || '');
};

async function session(name) {
  const created = await (await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name }),
  })).json();
  if (!created.id) throw new Error(`no session: ${JSON.stringify(created).slice(0, 200)}`);
  return created.id;
}

/** A pane showing the fixture, painted and settled. */
async function paintedFixture(name, cols = 120, rows = 40, mirror = false) {
  const id = await session(name);
  const v = await view(id, cols, rows, mirror);
  v.resize(cols, rows);
  await sleep(900);
  v.type(`node ${FIXTURE}\r`);
  await sleep(1500);
  return { id, v };
}

try {
  let up = false;
  // Generous: importing the dependency tree off a cold FUSE-mounted workspace can
  // take half a minute (express alone measured 32s), and a boot timeout looks
  // exactly like a broken server.
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) throw new Error(`server never came up:\n${log.slice(-800)}`);

  // --- one deliberate resize -----------------------------------------------
  {
    const { id, v } = await paintedFixture('resize once');
    const before = duplicateTokens(await gridText(id));
    check('a painted fixture starts with no duplicated lines', before === 0, `${before} duplicated tokens`);

    v.resize(80, 30);
    await sleep(1200);
    const after = duplicateTokens(await gridText(id));
    // One repaint at a new width cannot avoid leaving the rows the shrink pushed
    // into scrollback, so a handful is expected; a copy of the whole screen is
    // not.
    check('one resize duplicates at most a few lines', after <= 12, `${after} duplicated tokens`);
    check('the fixture followed the resize', (await gridText(id)).includes('[fixture 80x30]'));
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- a drag: ResizeObserver fires every frame ----------------------------
  {
    const { id, v } = await paintedFixture('resize storm');
    // 16 sizes in ~500ms is a slow drag; a real one is faster.
    for (let i = 0; i < 16; i++) {
      v.resize(120 - i * 2, 40 - i);
      await sleep(30);
    }
    v.resize(88, 24);
    await sleep(1500);

    const dupes = duplicateTokens(await gridText(id));
    check('a drag does not multiply scrollback', dupes <= 12, `${dupes} duplicated tokens`);
    check('the grid settles at the final size', (await gridText(id)).includes('[fixture 88x24]'));
    // Every viewer must be told the size that was actually applied, and the
    // coalescing must not swallow the last one.
    const last = v.lastFrame('grid');
    check('the last grid frame matches the final size', !!last && last.cols === 88 && last.rows === 24,
      last && `${last.cols}x${last.rows}`);
    check('the storm is coalesced into few PTY resizes', v.countFrames('grid') <= 4,
      `${v.countFrames('grid')} grid frames`);
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- the browser is repainted from the grid after a resize ---------------
  // An app that ignores SIGWINCH (a bash prompt, an agent sitting idle) would
  // otherwise leave the viewer showing its own reflow of a byte log, which is
  // exactly where the two disagree.
  {
    const { id, v } = await paintedFixture('resize repaint');
    const beforeBytes = v.bytes.length;
    v.resize(70, 26);
    await sleep(1200);
    const sent = v.bytes.slice(beforeBytes);
    check('a settled resize repaints the viewer from the grid', sent.includes('\x1b[2J'),
      `${sent.length}B after resize`);
    // The size must arrive BEFORE the bytes that assume it.
    check('the grid frame precedes the repaint',
      v.frames.some((f) => f.t === 'grid' && f.cols === 70 && f.rows === 26));
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- zooming: a sequence of deliberate, settled resizes ------------------
  // Each zoom click is a real resize, so coalescing cannot help here. What keeps
  // scrollback clean is clearing the screen before the reflow (nothing left to
  // rewrap into history) and carrying it across by hand instead.
  {
    const { id, v } = await paintedFixture('resize zoom');
    // The first resize is the one that teaches the host this app repaints (a
    // shell session is assumed not to), so measure from after it.
    v.resize(110, 36);
    await sleep(900);
    const learned = duplicateTokens(await gridText(id));

    for (const [c, r] of [[100, 32], [90, 28], [80, 24], [90, 28], [100, 32], [110, 36]]) {
      v.resize(c, r);
      await sleep(400);
    }
    await sleep(1200);
    const after = duplicateTokens(await gridText(id));
    check('zooming in and out adds no duplicated lines', after <= learned,
      `${learned} before, ${after} after six zoom steps`);
    check('the zoomed grid still shows the fixture', (await gridText(id)).includes('[fixture 110x36]'));
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- what the BROWSER ends up holding ------------------------------------
  // The grid being clean is only half the fix: the duplication a user sees is in
  // xterm's buffer, which reflows harder than libghostty does. This drives the
  // real emulator through the real protocol.
  if (!Headless) {
    console.log('SKIP  browser-side checks (@xterm/headless not installed)');
  } else {
    const { id, v } = await paintedFixture('resize browser', 120, 40, true);
    v.resize(110, 36);
    await sleep(900);
    const learned = duplicateTokens(await v.screenText());
    for (const [c, r] of [[100, 32], [90, 28], [80, 24], [90, 28], [100, 32], [110, 36]]) {
      v.resize(c, r);
      await sleep(400);
    }
    await sleep(1200);
    const seen = await v.screenText();
    check("zooming leaves no duplicates in the browser's own buffer", duplicateTokens(seen) <= learned,
      `${learned} before, ${duplicateTokens(seen)} after six zoom steps`);
    check('the browser ends at the grid size', v.term.cols === 110 && v.term.rows === 36,
      `${v.term.cols}x${v.term.rows}`);
    // Ordering: if resize overtook the repaint, the screen would be torn or stale.
    check('the browser shows the fixture at the final size', seen.includes('[fixture 110x36]'));
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- scrolling back still reaches everything -----------------------------
  // The first version of the carry cleared the screen and dropped the rows that
  // no longer fitted, so every zoom-in quietly ate history: a 40->24 shrink took
  // 16 lines with it and the pane could no longer scroll all the way up. Rows
  // that fall off the top have to be ARCHIVED, not discarded.
  if (!Headless) {
    console.log('SKIP  scrollback checks (@xterm/headless not installed)');
  } else {
    const id = await session('resize history');
    const v = await view(id, 120, 40, true);
    v.resize(120, 40);
    await sleep(900);
    // Teach the host that this session repaints, so the carry path is the one
    // under test, then leave a real log behind — that is what must survive.
    v.type(`node ${FIXTURE}\r`);
    await sleep(1500);
    v.resize(118, 38);
    await sleep(800);
    v.type('\x03');
    await sleep(800);
    // The trailing blank lines are load-bearing. Bash redraws its prompt on every
    // SIGWINCH and, when that prompt is wrapped, draws over the rows above it —
    // verified identical with AM_RESIZE_CARRY=0, so it is bash's doing and not the
    // resize path's. Without the padding this test would be asserting something no
    // terminal delivers.
    v.type('for i in $(seq 1 200); do echo "hist-$i"; done; echo; echo; echo\r');
    await sleep(2000);

    const missing = (text) => {
      const gone = [];
      for (let i = 1; i <= 200; i++) if (!new RegExp(`hist-${i}(?!\\d)`).test(text)) gone.push(i);
      return gone;
    };
    const before = missing(await v.screenText());
    check('the log is complete before zooming', before.length === 0, `${before.length} lines missing`);

    for (const [c, r] of [[100, 30], [90, 24], [100, 30], [110, 34], [120, 40], [90, 24]]) {
      v.resize(c, r);
      await sleep(400);
    }
    await sleep(1200);
    // The grid is the authority and has to be exact.
    const gridGone = missing(await gridText(id));
    check('zooming loses no scrollback in the grid', gridGone.length === 0,
      gridGone.length ? `${gridGone.length} lines gone, e.g. hist-${gridGone.slice(0, 5).join(', hist-')}` : '');
    // xterm's own reflow drops a couple of lines over a cycle this violent no
    // matter what we do — AM_RESIZE_CARRY=0 loses three in the same run, from the
    // same region — so this is a bound, not a promise. A reattach repaints the
    // pane from the grid, which is why the grid check above is the strict one.
    const after = missing(await v.screenText());
    check('zooming loses no more browser scrollback than plain reflow does', after.length <= 4,
      after.length ? `${after.length} lines gone, e.g. hist-${after.slice(0, 5).join(', hist-')}` : 'none');
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- the screen survives a resize the app ignores ------------------------
  // Clearing before the reflow is only safe because the screen is re-painted
  // afterwards. An app that never answers SIGWINCH is the case that proves it:
  // here the fixture teaches the host that this session repaints, then exits, so
  // the shell prompt below it gets the carry treatment while redrawing nothing.
  {
    const { id, v } = await paintedFixture('resize carry');
    v.resize(110, 36);          // teaches host.repaints = true
    await sleep(900);
    v.type('\x03');             // Ctrl-C: the fixture dies, prompt comes back
    await sleep(800);
    v.type('printf "carry-%s\\n" 1 2 3 4 5\r');
    await sleep(800);
    check('the lines are on screen before the resize', (await gridText(id)).includes('carry-5'));
    v.resize(84, 30);
    await sleep(1200);
    const text = await gridText(id);
    check('a screen the app never repaints survives the resize', text.includes('carry-5'),
      text.includes('carry-1') ? '' : 'lost the earlier lines too');
    check('and is not duplicated by the carry', (text.match(/carry-5/g) || []).length === 1,
      `${(text.match(/carry-5/g) || []).length} copies`);
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- a shell's rewrapped scrollback is the log, not a duplicate ----------
  // Nothing repaints it, so reflow is the only thing preserving it: the clear
  // must stay off until an app proves it repaints.
  {
    const id = await session('resize shell log');
    const v = await view(id, 120, 40);
    v.resize(120, 40);
    await sleep(900);
    v.type('for i in $(seq 1 60); do echo "log-line-$i"; done\r');
    await sleep(1200);
    v.resize(90, 30);
    await sleep(1200);
    const text = await gridText(id);
    check('a shell keeps its scrolled-off output across a resize', text.includes('log-line-5'),
      text.includes('log-line-55') ? '' : 'lost recent lines too');
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- a viewer that only re-asks for the same size costs nothing ----------
  // Tab focus and unrelated layout changes call resync() constantly.
  {
    const { id, v } = await paintedFixture('resize noop');
    const framesBefore = v.countFrames('grid');
    for (let i = 0; i < 5; i++) { v.resize(120, 40); await sleep(120); }
    await sleep(600);
    check('re-requesting the current size changes nothing', v.countFrames('grid') === framesBefore,
      `${v.countFrames('grid') - framesBefore} extra grid frames`);
    check('no duplication from no-op resyncs', duplicateTokens(await gridText(id)) === 0);
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }
} catch (err) {
  check('no exceptions', false, String(err && err.message ? err.message : err));
  console.log('--- server log tail ---\n' + log.slice(-1200));
} finally {
  srv.kill('SIGTERM');
  await sleep(600);
  srv.kill('SIGKILL');
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
