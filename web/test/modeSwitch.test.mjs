// Reader <-> Terminal, through the real TerminalPane lifecycle (#127).
//
// Two operator reports, both reproduced here before they were fixed:
//
//   1. Showing the terminal took seconds. Measured, it was never the transport
//      or xterm: the canonical restore lands and the screen paints in tens of
//      milliseconds. It was the boot cover. That cover asks "has the harness
//      painted its upper two-thirds yet", which is the right question for a
//      COLD boot (an agent TUI draws its input bar first and loads history
//      seconds later) and the wrong one for re-attaching to a session this
//      page has already shown: every row of that screen came from the
//      backend's canonical output. A screen whose content sits low — a TUI
//      input bar, a mostly-empty screen with a prompt at the bottom — never
//      satisfied it, so the cover sat until its 20-second safety cap. On top
//      of that, the probe ran on a 150ms timer rather than on write()'s
//      completion callback, so every switch hid painted content for that long.
//
//   2. Coming back to the reader landed above the bottom. Measured, this was
//      not a switching bug at all: a reader following the end was ~340px short
//      of the bottom on FIRST OPEN. Following converges over several passes
//      (pin to the end, render the rows that lands on, measure them, pin
//      again), and `onScroll` re-derived the follow latch from the geometry
//      DURING that convergence, where the distance from the bottom is
//      briefly large. One such sample turned following off for good.
//
// Synthetic transport and trace API. Never starts an agent, never opens a real
// socket, never sends a prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

// Measured on this fixture: every switch becomes usable in 11-102ms (p50 13-62)
// against 160-20026ms before. The budget is two orders of magnitude of
// headroom over the measurement, so it fails on the regression and not on a
// slow runner. Real transport latency is deliberately NOT inside it.
const USABLE_BUDGET_MS = 1500;
// A restored anchor is re-derived from freshly measured rows, so it lands within
// a row's own layout rounding rather than exactly.
const ANCHOR_TOLERANCE_PX = 40;

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-'));
const bundle = path.join(tmp, 'fixture.js');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import TerminalPane from './src/components/TerminalPane';
    const CTRL = '\\x00\\x00AM:';
    window.sockets = []; window.live = 0; window.sends = []; window.wsSends = []; window.marks = [];
    const mark = (name) => window.marks.push({ name, t: performance.now() });
    window.mark = mark;
    let config = {}, root;
    // Behaves like the backend: opens, sends the canonical grid/restore frame,
    // then the retained ANSI output. Counts live sockets so a hidden transport
    // in reader mode cannot pass unnoticed.
    class FakeSocket {
      static OPEN = 1;
      constructor(url) {
        this.url = url; this.readyState = 0; this.sent = [];
        window.sockets.push(this); window.live++; mark('ws.new');
        const open = () => {
          if (this.readyState === 3) return;
          this.readyState = 1; mark('ws.open'); this.onopen?.({});
          setTimeout(() => {
            if (this.readyState === 3) return;
            // attach() starts the session and THEN snapshots it, so a cold
            // start is sent a restore frame too — with an empty snapshot.
            // restoreAnsi is that snapshot; an empty one is the cold case.
            this.onmessage?.({ data: CTRL + JSON.stringify({ t: 'restore', controller: true,
              cols: 80, rows: 24, reset: false }) });
            const snapshot = config.restoreAnsi ?? (config.payload || [])[0] ?? '';
            this.onmessage?.({ data: snapshot });
            // Frames the harness paints afterwards, at their own times.
            for (const frame of config.frames || (config.payload || []).slice(1).map((data, i) => ({ at: (i + 1) * (config.chunkGap ?? 0), data }))) {
              setTimeout(() => { if (this.readyState !== 3) this.onmessage?.({ data: frame.data }); }, frame.at);
            }
          }, config.restoreDelay ?? 0);
        };
        config.openDelay ? setTimeout(open, config.openDelay) : Promise.resolve().then(open);
      }
      send(d) { this.sent.push(d); window.wsSends.push(d); }
      close(code) { if (this.readyState !== 3) window.live--; this.readyState = 3; this.onclose?.({ code: code ?? 1000 }); }
      // A transient drop, the way a sleeping Space or a flaky proxy delivers one.
      drop() { if (this.readyState !== 3) window.live--; this.readyState = 3; this.onclose?.({ code: 1006 }); }
    }
    window.WebSocket = FakeSocket;
    const empty = { harness:'claude',harnessLabel:'Fixture',sessionId:'s',title:'',model:null,cwd:null,
      firstTs:0,lastTs:0,usage:null,source:null,sharedBy:null,note:null,truncated:false,total:null,
      userTurns:null,activity:'waiting',generation:'g',revision:'r1' };
    const page = (turns, from=0, end=turns.length) => ({ ...empty, turns,
      window:{mode:'bytes',start:from,end,atStart:from===0,atEnd:true,generation:'g',revision:'r1'} });
    // Deliberately uneven rows: a follow latch that only works on a uniform
    // list is not the list this reader renders.
    const records = (count) => Array.from({length:count}, (_,i) => [
      {id:'u'+i,role:'user',ts:100000+i*1000,blocks:[{type:'text',text:'Question '+i}]},
      {id:'a'+i,role:'assistant',ts:100500+i*1000,kind:'final',blocks:[{type:'text',text:'Answer '+i+'.\\n\\n'+
        Array.from({length:1+(i*37)%90},(_,k)=>'line '+k+' of answer '+i).join('\\n')}]},
    ]).flat();
    window.fixtureApi = {
      window: (id, req) => {
        const all = records(config.count || 120);
        window.mark('trace.' + req.at);
        const answer = () => {
          if (req.at === 'after') return page(all.slice(req.cursor), req.cursor, all.length);
          if (req.at === 'before') return page(all.slice(0, req.cursor), 0, req.cursor);
          return page(all, 0, all.length);
        };
        return config.slowTrace
          ? new Promise((r) => setTimeout(() => r(answer()), config.slowTrace))
          : Promise.resolve(answer());
      },
      summary: () => Promise.resolve({ ...page([]), total: 2*(config.count||120), userTurns: [] }),
      roster: () => [],
    };
    function Pane({ id }) { return <div className="tile" style={{position:'relative',flex:1,minWidth:0}}><TerminalPane
      session={{id,cli:'claude',name:'Switch fixture',state:config.state||'waiting',
        running:config.running!==false,everStarted:config.everStarted!==false,path:null,createdAt:new Date().toISOString()}}
      cli={{id:'claude',label:'Fixture',color:'#777'}} mode={config.mode||'reader'} theme="light" zoom={config.zoom||100}
      focused active visible onClose={()=>{}} /></div>; }
    function App(){ return <>
      <Pane id={config.id||'switch'} />
      {config.second && <Pane id={config.second === 'same' ? (config.id||'switch') : 'second'} />}
    </>; }
    window.fixture = {
      mount(options){ if(root) flushSync(()=>root.unmount()); config={...options};
        root=createRoot(document.getElementById('fixture-root')); flushSync(()=>root.render(<App/>)); },
      change(options){ Object.assign(config, options); flushSync(()=>root.render(<App/>)); },
      reset(){ window.marks = []; },
      drop(){ for (const sock of window.sockets) if (sock.readyState === 1) sock.drop(); },
      live(){ return window.sockets.filter((s) => s.readyState === 1).length; },
    };
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.?(?:\/\.\.)*\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: web, loader: 'ts', contents: `
      export * from ${JSON.stringify(path.join(web, 'src/api.ts'))};
      export const getTraceWindow=(...a)=>window.fixtureApi.window(...a);
      export const getTraceSummary=()=>window.fixtureApi.summary();
      export const getSubAgents=()=>Promise.resolve({agents:[]});
      export const sendInput=(id,text)=>{window.sends.push({id,text});return Promise.resolve({});};
    ` }));
  } }],
});

const ansi = (rows) => rows.join('\r\n') + '\r\n';
const shellScreen = ansi(['you/workspaces $ ls', 'docs  server  web', 'you/workspaces $ ']);
// The case that hit the 20-second cap: nothing in the upper two-thirds.
const bottomOnlyScreen = ansi(Array.from({ length: 22 }, () => '').concat(['> ask me anything']));
const tuiScreen = ansi(['\x1b[?1049h'].concat(Array.from({ length: 20 }, (_, i) => `  row ${i} of the TUI`), ['> prompt']));
const bigScreen = ansi(Array.from({ length: 2000 }, (_, i) => `line ${i} of retained scrollback with detail`));

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
try {
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  p.on('pageerror', (error) => errors.push(error.message));
  // A real origin, so readingPosition uses the localStorage it uses in the app
  // rather than silently falling back to its in-memory map.
  await p.route('**/*', (route) => (route.request().url() === 'http://fixture.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="fixture-root" style="display:flex;position:absolute;inset:10px"></div>' })
    : route.abort()));
  await p.goto('http://fixture.test/');
  await p.addStyleTag({ path: bundle.replace(/\.js$/, '.css') });
  await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
    + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
  await p.addScriptTag({ path: bundle });

  const open = (cfg) => p.evaluate((c) => window.fixture.mount({ mode: 'reader', ...c }), cfg)
    .then(() => p.waitForSelector('.cxv-body'));
  const toReader = async () => { await p.evaluate(() => window.fixture.change({ mode: 'reader' })); await p.waitForSelector('.cxv-body'); };
  const toTerminal = async () => {
    await p.evaluate(() => window.fixture.change({ mode: 'terminal' }));
    await p.waitForSelector('.xterm');
    await p.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent || '').trim().length > 1,
      null, { timeout: 10_000 });
  };
  // Long enough for the store's catch-up read, the row measurements it triggers
  // and the follow passes that follow them. Asserted state, never a sleep that
  // stands in for one.
  const settleReader = () => p.waitForFunction(() => {
    const el = document.querySelector('.cxv-body');
    if (!el) return false;
    const now = { h: el.scrollHeight, t: Math.round(el.scrollTop) };
    const last = window.__settle;
    window.__settle = now;
    return !!last && last.h === now.h && last.t === now.t;
  }, null, { timeout: 15_000, polling: 250 });
  const geometry = () => p.evaluate(() => {
    const el = document.querySelector('.cxv-body');
    const top = el.getBoundingClientRect().top;
    const row = [...document.querySelectorAll('[data-x]')].find((n) => n.getBoundingClientRect().bottom > top + 4);
    return { fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      key: row?.dataset.x || null, offset: Math.round((row?.getBoundingClientRect().top ?? 0) - top),
      label: document.querySelector('.cxv-status')?.textContent?.includes('At latest') || false };
  });
  // Time from the mode toggle to live content with nothing covering it.
  const usable = () => p.evaluate(async () => {
    const t0 = performance.now();
    window.fixture.change({ mode: 'terminal' });
    while (performance.now() - t0 < 24_000) {
      const rows = document.querySelector('.xterm-rows');
      const covered = document.querySelector('.term-preview, .term-boot');
      if (rows && rows.textContent.trim().length > 1 && !covered) return Math.round(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return -1;
  });
  // A gesture, in the two parts the reader reacts to: the input event that says
  // a person did this, and the movement it causes. Chromium's synthesized wheel
  // and key scrolling do not move this container reliably under automation, so
  // the test delivers both halves itself. The order is deliberately "event,
  // then movement" in one case and the reverse in another below, because a real
  // browser can dispatch them either way round and the fix must not depend on
  // which — see onScroll in ConversationView.
  const gestureUp = (px) => p.evaluate((amount) => {
    const el = document.querySelector('.cxv-body');
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -amount, bubbles: true }));
    el.scrollTop = Math.max(0, el.scrollTop - amount);
  }, px);
  const scrollBack = async () => { await gestureUp(6000); await settleReader(); };

  console.log('a reader following the end comes back to the end');
  await open({ id: 'bottom', payload: [shellScreen] });
  await settleReader();
  const opened = await geometry();
  check('it is at the bottom on first open, once measurement settles', () => {
    assert.equal(opened.fromBottom, 0, JSON.stringify(opened));
    assert.equal(opened.label, true, 'and says so');
  });
  for (let i = 1; i <= 3; i++) {
    await toTerminal(); await toReader(); await settleReader();
    const back = await geometry();
    check(`round trip ${i} returns to the geometric bottom`, () => {
      assert.equal(back.fromBottom, 0, JSON.stringify(back));
      assert.equal(back.label, true);
    });
  }

  console.log('\nand a transcript shorter than the window sits at the TOP');
  // "Scrolled to the end" and "aligned to the bottom" look identical while the
  // content overflows and nothing alike when it does not. A `margin-top: auto`
  // on the rows produced the second: a two-exchange conversation sat on the
  // floor of the pane with the free space above it, which reads as a layout
  // fault. Bottom scroll POSITION is what opening at the latest means.
  const geometry2 = () => p.evaluate(() => {
    const el = document.querySelector('.cxv-body');
    const rows = [...document.querySelectorAll('[data-x]')];
    const box = el.getBoundingClientRect();
    return {
      scrollable: el.scrollHeight > el.clientHeight,
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      above: rows[0] ? Math.round(rows[0].getBoundingClientRect().top - box.top) : null,
      below: rows.length ? Math.round(box.bottom - rows.at(-1).getBoundingClientRect().bottom) : null,
    };
  });
  for (const count of [1, 2]) {
    await open({ id: `short-${count}`, payload: [shellScreen], count });
    await settleReader();
    const g = await geometry2();
    check(`${count} exchange(s): the slack is below the text, not above it`, () => {
      assert.equal(g.scrollable, false, `the fixture must not overflow here: ${JSON.stringify(g)}`);
      // What is left above is the pane's own padding and chrome. Free space
      // would grow as the content shrinks; this does not.
      assert.ok(g.above < 60, `${g.above}px above the first exchange`);
      assert.ok(g.below > g.above, `${g.below}px below vs ${g.above}px above`);
    });
  }
  await open({ id: 'short-tall', payload: [shellScreen], count: 120 });
  await settleReader();
  const tall = await geometry2();
  check('and once it does overflow, it still opens at the end', () => {
    assert.equal(tall.scrollable, true);
    assert.equal(tall.fromBottom, 0, JSON.stringify(tall));
  });

  console.log('\nand to the NEW end when output arrived while the terminal was up');
  await open({ id: 'append', payload: [shellScreen] });
  await settleReader();
  const beforeAppend = await geometry();
  await toTerminal();
  await p.evaluate(() => window.fixture.change({ count: 130 }));
  await toReader(); await settleReader();
  const afterAppend = await geometry();
  check('ten new exchanges land and the reader is at the new bottom', () => {
    assert.equal(afterAppend.fromBottom, 0, JSON.stringify(afterAppend));
    assert.notEqual(afterAppend.key, beforeAppend.key, 'the bottom really moved');
  });
  // Appending DURING the restore, with the trace read made slow, must not strand it.
  await toTerminal();
  await p.evaluate(() => window.fixture.change({ count: 140, slowTrace: 400 }));
  await toReader();
  await p.evaluate(() => window.fixture.change({ count: 150 }));
  await settleReader();
  const late = await geometry();
  check('output arriving during a slow restoration still ends at the bottom', () => {
    assert.equal(late.fromBottom, 0, JSON.stringify(late));
  });
  await p.evaluate(() => window.fixture.change({ slowTrace: 0 }));

  console.log('\na reader that scrolled back stays where it was');
  await open({ id: 'manual', payload: [shellScreen] });
  await settleReader();
  await scrollBack();
  const beforeManual = await geometry();
  check('the gesture stopped it following', () => {
    assert.ok(beforeManual.fromBottom > 1000, `${beforeManual.fromBottom}px from the bottom`);
    assert.equal(beforeManual.label, false);
  });
  await toTerminal();
  await p.evaluate(() => window.fixture.change({ count: 130 }));
  await toReader(); await settleReader();
  const afterManual = await geometry();
  check('it returns to the same message, not to Latest', () => {
    assert.equal(afterManual.key, beforeManual.key, JSON.stringify({ beforeManual, afterManual }));
    assert.ok(Math.abs(afterManual.offset - beforeManual.offset) <= ANCHOR_TOLERANCE_PX,
      `offset moved ${afterManual.offset - beforeManual.offset}px`);
    assert.equal(afterManual.label, false, 'and was not dragged to the end');
  });

  console.log('\nthe newest intent wins');
  // Latest pressed while already at the end moves nothing, so there is no
  // scroll event to infer the intent from. The remembered manual position must
  // still give way to it.
  await p.getByRole('button', { name: /latest/i }).click();
  await settleReader();
  await p.getByRole('button', { name: /latest/i }).click();
  await toTerminal(); await toReader(); await settleReader();
  const afterLatest = await geometry();
  check('Latest, then a switch, returns to the end and not to the old anchor', () => {
    assert.equal(afterLatest.fromBottom, 0, JSON.stringify(afterLatest));
    assert.equal(afterLatest.label, true);
  });
  // Switching inside the 150ms save debounce keeps the gesture's position.
  await open({ id: 'debounce', payload: [shellScreen] });
  await settleReader();
  // Movement first, event second: the reverse order of scrollBack.
  await p.evaluate(() => {
    const el = document.querySelector('.cxv-body');
    el.scrollTop = Math.max(0, el.scrollTop - 4000);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -4000, bubbles: true }));
  });
  await p.waitForTimeout(20);          // inside the 150ms save debounce
  const beforeDebounce = await geometry();
  await toTerminal(); await toReader(); await settleReader();
  const afterDebounce = await geometry();
  check('a switch inside the save debounce keeps the message it was on', () => {
    assert.equal(afterDebounce.key, beforeDebounce.key, JSON.stringify({ beforeDebounce, afterDebounce }));
    assert.equal(afterDebounce.label, false);
  });
  await open({ id: 'draft', payload: [shellScreen] });
  await p.locator('.cxv-composer textarea').fill('half-written prompt');
  await toTerminal(); await toReader();
  const draft = await p.locator('.cxv-composer textarea').inputValue();
  const sent = await p.evaluate(() => window.sends);
  check('a draft survives the round trip and nothing is sent', () => {
    assert.equal(draft, 'half-written prompt');
    assert.deepEqual(sent, [], 'a mode switch never sends a prompt');
  });

  console.log('\nthe terminal is usable promptly, and the wait that is left is real');
  for (const [label, payload] of [['a shell prompt at the top', shellScreen],
    ['a bottom-anchored input bar', bottomOnlyScreen], ['an alternate-screen TUI', tuiScreen],
    ['2000 lines of retained scrollback', bigScreen]]) {
    await open({ id: `ready-${label.length}`, payload: [payload] });
    const first = await usable();
    await toReader();
    const repeats = [];
    for (let i = 0; i < 5; i++) { repeats.push(await usable()); await toReader(); }
    check(`${label}: first visit ${first}ms, repeats ${JSON.stringify(repeats)}`, () => {
      assert.ok(first >= 0 && first < USABLE_BUDGET_MS, `first visit took ${first}ms`);
      for (const ms of repeats) assert.ok(ms >= 0 && ms < USABLE_BUDGET_MS, `a repeat switch took ${ms}ms`);
    });
  }
  await open({ id: 'latency', payload: [shellScreen], openDelay: 120, restoreDelay: 120 });
  const slow = await usable();
  check(`transport latency is not hidden: 240ms of it costs ${slow}ms`, () => {
    assert.ok(slow >= 200, `${slow}ms — real delay must not be papered over`);
    assert.ok(slow < USABLE_BUDGET_MS, `${slow}ms`);
  });

  console.log('\na cold start keeps its cover until the harness paints for real');
  // The sequence the real server produces for a session it starts on this
  // request: attach() runs ensureRunning() and then snapshots, so a restore
  // frame arrives carrying an EMPTY screen, and the harness paints afterwards —
  // its bottom input bar first, its banner and history a beat later. Uncovering
  // on that first bottom-only frame would show a terminal that is not ready,
  // which is a worse version of the delay this PR set out to remove.
  // Clear + home first: a harness repaints its screen, it does not append to
  // whatever was there. Appending would scroll the banner into the bottom third
  // and the fixture would silently stop testing the upper-region rule.
  const bannerScreen = '\x1b[2J\x1b[H' + ansi(['  Fixture harness 1.0', '  Loaded 12 files from the workspace', '', '> prompt']);
  await open({ id: 'cold', running: false, everStarted: false, restoreAnsi: '',
    frames: [{ at: 400, data: bottomOnlyScreen }, { at: 900, data: bannerScreen }] });
  const cold = await p.evaluate(async () => {
    const t0 = performance.now();
    window.fixture.change({ mode: 'terminal' });
    let bottomOnlyAt = 0;
    while (performance.now() - t0 < 6000) {
      const rows = document.querySelector('.xterm-rows');
      const text = (rows?.textContent || '').trim();
      const covered = !!document.querySelector('.term-preview, .term-boot');
      if (!bottomOnlyAt && text.includes('ask me anything')) bottomOnlyAt = performance.now() - t0;
      if (text.length > 1 && !covered) return { lift: Math.round(performance.now() - t0),
        bottomOnlyAt: Math.round(bottomOnlyAt) };
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { lift: -1, bottomOnlyAt: Math.round(bottomOnlyAt) };
  });
  // The probe reads xterm's BUFFER; its DOM rows land a frame later. So the
  // banner is asserted as arriving, not as already rendered at the exact
  // millisecond the cover went away.
  const bannerShown = await p.waitForFunction(
    () => (document.querySelector('.xterm-rows')?.textContent || '').includes('Loaded 12 files'),
    null, { timeout: 5000 }).then(() => true).catch(() => false);
  check(`the bottom-only startup frame does not uncover it (lifted at ${cold.lift}ms)`, () => {
    assert.ok(cold.bottomOnlyAt > 0, 'the bottom-only frame never arrived; the fixture is not exercising this');
    assert.ok(cold.lift > cold.bottomOnlyAt + 100,
      `uncovered ${cold.lift - cold.bottomOnlyAt}ms after the bottom-only frame`);
  });
  check('it uncovers once the harness paints its upper screen', () => {
    // The banner frame is delivered at 900ms; uncovering before it would mean
    // some earlier, bottom-only frame did it.
    assert.ok(cold.lift >= 850, `lifted at ${cold.lift}ms, before the upper-screen frame`);
    assert.ok(cold.lift < 3000, `lifted at ${cold.lift}ms`);
    assert.equal(bannerShown, true, 'the banner never reached the screen');
  });

  console.log('\nthe cover shows the screen that was just torn down');
  // Leaving the terminal flushes its final screen to storage, but the cover
  // used to render a value read once when the pane mounted — so it showed a
  // screen from an earlier page load, or the bare `connecting` line, while the
  // screen the operator had just been looking at sat unused. The wait itself is
  // real (a fresh socket and the canonical restore, measured above); what it
  // shows during that wait should be the last view it claims to be.
  const coverContent = () => p.evaluate(async () => {
    const t0 = performance.now();
    window.fixture.change({ mode: 'terminal' });
    while (performance.now() - t0 < 5000) {
      const shown = document.querySelector('.term-preview');
      const boot = document.querySelector('.term-boot');
      if (shown) return { kind: 'preview', text: (shown.querySelector('pre')?.textContent || '').split('\n')[0] };
      if (boot) return { kind: 'boot', text: boot.textContent };
      const rows = document.querySelector('.xterm-rows');
      if (rows && (rows.textContent || '').trim().length > 1) return { kind: 'none', text: '' };
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { kind: 'timeout', text: '' };
  });
  const firstScreen = ansi(['FIRST-SCREEN in the terminal', 'you/workspaces $ ']);
  const secondScreen = ansi(['SECOND-SCREEN after working', 'you/workspaces $ ']);
  await p.evaluate(() => { try { localStorage.clear(); } catch { /* storage may be denied */ } });
  // Enough latency that the cover is reached before the restore lands.
  await open({ id: 'lastview', payload: [firstScreen], openDelay: 150, restoreDelay: 150 });
  const noStoredView = await coverContent();
  check('with nothing stored yet it still says connecting', () => assert.equal(noStoredView.kind, 'boot'));
  await p.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent || '').includes('FIRST-SCREEN'), null, { timeout: 10_000 });
  await toReader();
  await p.waitForTimeout(250);
  await p.evaluate((data) => window.fixture.change({ payload: [data] }), secondScreen);
  const second = await coverContent();
  check('the next visit shows the screen the last one ended on', () => {
    assert.equal(second.kind, 'preview', JSON.stringify(second));
    assert.match(second.text, /FIRST-SCREEN/);
  });
  await p.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent || '').includes('SECOND-SCREEN'), null, { timeout: 10_000 });
  await toReader();
  await p.waitForTimeout(250);
  const third = await coverContent();
  check('and it moves on, rather than pinning the first screen forever', () => {
    assert.equal(third.kind, 'preview', JSON.stringify(third));
    assert.match(third.text, /SECOND-SCREEN/);
  });

  console.log('\nreconnect after an interruption');
  await open({ id: 'recon', payload: [shellScreen] });
  await usable();
  const dropped = await p.evaluate(async () => {
    window.fixture.drop();
    const t0 = performance.now();
    while (performance.now() - t0 < 15_000) {
      const rows = document.querySelector('.xterm-rows');
      if (window.fixture.live() === 1 && (rows?.textContent || '').trim().length > 1
        && !document.querySelector('.term-preview, .term-boot')) {
        return { backAt: Math.round(performance.now() - t0), live: window.fixture.live() };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { backAt: -1, live: window.fixture.live() };
  });
  check(`a transient drop reconnects on its own (${dropped.backAt}ms)`, () => {
    assert.ok(dropped.backAt >= 0 && dropped.backAt < 12_000, `never came back: ${JSON.stringify(dropped)}`);
    assert.equal(dropped.live, 1, 'exactly one transport after recovery');
  });

  console.log('\ninput readiness, measured separately from paint');
  await open({ id: 'input', payload: [shellScreen] });
  const paintedAt = await usable();
  await p.locator('.xterm-helper-textarea').focus();
  await p.keyboard.type('ls');
  const typed = await p.waitForFunction(() => {
    const frames = window.wsSends.filter((d) => typeof d === 'string' && d.includes('"t":"i"'));
    return frames.length ? frames.length : null;
  }, null, { timeout: 10_000 }).then((h) => h.jsonValue()).catch(() => 0);
  check(`keystrokes reach the transport after ${paintedAt}ms of paint (${typed} input frames)`, () => {
    assert.ok(typed > 0, 'the terminal painted but never accepted input');
  });

  console.log('\nsmall viewport and zoom');
  for (const [label, width, height, zoom] of [['phone', 390, 844, 100], ['desktop at 150%', 1000, 700, 150]]) {
    await p.setViewportSize({ width, height });
    await open({ id: `vp-${width}-${zoom}`, payload: [bottomOnlyScreen], zoom });
    const first = await usable();
    await toReader();
    const again = await usable();
    check(`${label}: ${first}ms then ${again}ms`, () => {
      assert.ok(first >= 0 && first < USABLE_BUDGET_MS, `first ${first}ms`);
      assert.ok(again >= 0 && again < USABLE_BUDGET_MS, `repeat ${again}ms`);
    });
  }
  await p.setViewportSize({ width: 1000, height: 700 });

  console.log('\na second viewer of the same session');
  await p.evaluate((screen) => window.fixture.mount({ mode: 'terminal', id: 'shared',
    second: 'same', payload: [screen] }), shellScreen);
  await p.waitForSelector('.xterm');
  await p.waitForTimeout(600);
  const viewers = await p.evaluate(() => ({
    live: window.fixture.live(),
    sessions: window.sockets.filter((s) => s.readyState === 1).map((s) => new URL(s.url).searchParams.get('session')),
    painted: [...document.querySelectorAll('.xterm-rows')].map((n) => n.textContent.includes('you/workspaces $')),
  }));
  check('both viewers attach as the same session and both paint', () => {
    assert.equal(viewers.live, 2, JSON.stringify(viewers));
    assert.deepEqual([...new Set(viewers.sessions)], ['shared']);
    assert.deepEqual(viewers.painted, [true, true], 'a second viewer must not blank the first');
  });

  console.log('\nlifecycle safety');
  await open({ id: 'lifecycle', payload: [shellScreen] });
  await p.evaluate(() => { window.sockets.length = 0; });
  const readerSockets = await p.evaluate(() => window.sockets.length);
  check('a reader-only load opens no socket at all', () => assert.equal(readerSockets, 0));
  await toTerminal();
  await toReader();
  const idle = await p.evaluate(() => ({ live: window.live, total: window.sockets.length }));
  check('leaving the terminal closes its transport and keeps none open', () => {
    assert.equal(idle.live, 0, JSON.stringify(idle));
    assert.equal(idle.total, 1);
  });
  const bleed = await p.evaluate(() => ({ fill: document.querySelectorAll('.term-fill').length,
    xterm: document.querySelectorAll('.xterm').length, cover: document.querySelectorAll('.term-preview, .term-boot').length }));
  check('nothing of the terminal is left rendered under the reader', () => {
    assert.deepEqual(bleed, { fill: 0, xterm: 0, cover: 0 });
  });
  for (let i = 0; i < 6; i++) { await toTerminal(); await toReader(); }
  const churn = await p.evaluate(() => ({ live: window.live, total: window.sockets.length,
    emulators: document.querySelectorAll('.xterm').length }));
  check('six more round trips open one transport each and leak none', () => {
    assert.equal(churn.live, 0, JSON.stringify(churn));
    assert.equal(churn.total, 7, JSON.stringify(churn));
    assert.equal(churn.emulators, 0);
  });
  await toTerminal();
  const duplication = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean);
    return { prompts: rows.filter((r) => r.includes('you/workspaces $')).length };
  });
  check('the restored screen is not replayed twice', () => {
    assert.equal(duplication.prompts, 2, JSON.stringify(duplication));
  });

  console.log('\ntwo panes stay independent');
  await p.evaluate(() => { window.sockets.length = 0; });
  await p.evaluate((screen) => window.fixture.mount({ mode: 'reader', id: 'pane-a', second: true, payload: [screen] }), shellScreen);
  await p.waitForSelector('.cxv-body');
  await p.evaluate(() => window.fixture.change({ mode: 'terminal' }));
  await p.waitForSelector('.xterm');
  const panes = await p.evaluate(() => ({ sockets: window.sockets.map((s) => new URL(s.url).searchParams.get('session')) }));

  check('each pane connects as itself', () => {
    assert.deepEqual([...new Set(panes.sockets)].sort(), ['pane-a', 'second']);
  });

  // The wall-clock budget above cannot see a 150ms regression, so pin the
  // mechanism: the cover asks whether the screen has content from write()'s
  // completion callback, which is when the bytes are actually parsed onto it,
  // not from a timer guessing how long that takes.
  console.log('\nthe cover is driven by the parse, not by a timer');
  const source = fs.readFileSync(path.join(web, 'src/components/TerminalPane.tsx'), 'utf8');
  check('the boot probe runs in the write completion callback', () => {
    const write = source.match(/term\.write\(d, \(\) => \{[^}]*\}\)/s);
    assert.ok(write, 'output is no longer written with a completion callback');
    assert.match(write[0], /bootLive && screenHasContent\(\) *\) *endBoot\(\)/);
  });
  check('and no timer is left probing on a delay', () => {
    assert.doesNotMatch(source, /setTimeout\([^)]*screenHasContent/s);
    assert.doesNotMatch(source, /screenHasContent\(\)\) endBoot\(\);?\s*\}, *\d+\)/s);
  });
  check('the cold-boot rule is keyed on the snapshot content, not on the frame', () => {
    // A restore FRAME is not evidence of a warm reattachment: attach() calls
    // ensureRunning() before restore(), so a session started for this very
    // request is sent one too, carrying an empty screen. Only a snapshot that
    // actually has content may switch the probe to whole-screen.
    assert.match(source, /if \(canonical && screenHasContent\(true\)\) restored = true;/);
    assert.match(source, /const rows = whole \? term\.rows : Math\.max\(2, Math\.floor\(term\.rows \* 2 \/ 3\)\)/);
    assert.match(source, /if \(m\.t === 'restore'\) restoring = true;/);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(failed ? `\n${failed} failed` : '\nmode-switch: terminal readiness and reader intent hold across the round trip');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
