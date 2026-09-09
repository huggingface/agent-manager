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
    window.sockets = []; window.live = 0; window.sends = []; window.marks = [];
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
            this.onmessage?.({ data: CTRL + JSON.stringify({ t: 'restore', controller: true,
              cols: 80, rows: 24, reset: false }) });
            (config.payload || []).forEach((chunk, i) => setTimeout(() => {
              if (this.readyState !== 3) this.onmessage?.({ data: chunk });
            }, i * (config.chunkGap ?? 0)));
          }, config.restoreDelay ?? 0);
        };
        config.openDelay ? setTimeout(open, config.openDelay) : Promise.resolve().then(open);
      }
      send(d) { this.sent.push(d); }
      close() { if (this.readyState !== 3) window.live--; this.readyState = 3; this.onclose?.({ code: 1000 }); }
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
      session={{id,cli:'claude',name:'Switch fixture',state:'waiting',running:true,everStarted:true,path:null,createdAt:new Date().toISOString()}}
      cli={{id:'claude',label:'Fixture',color:'#777'}} mode={config.mode||'reader'} theme="light" zoom={config.zoom||100}
      focused active visible onClose={()=>{}} /></div>; }
    function App(){ return <>
      <Pane id={config.id||'switch'} />
      {config.second && <Pane id="second" />}
    </>; }
    window.fixture = {
      mount(options){ if(root) flushSync(()=>root.unmount()); config={...options};
        root=createRoot(document.getElementById('fixture-root')); flushSync(()=>root.render(<App/>)); },
      change(options){ Object.assign(config, options); flushSync(()=>root.render(<App/>)); },
      reset(){ window.marks = []; },
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
  check('a session with no canonical snapshot keeps the cold boot rule', () => {
    // `restored` is only set by the frame that follows t:'restore'; a new or
    // starting session is sent none, so it keeps the upper-region rule and cap.
    assert.match(source, /restored \? term\.rows : Math\.max\(2, Math\.floor\(term\.rows \* 2 \/ 3\)\)/);
    assert.match(source, /if \(m\.t === 'restore'\) restoring = true;/);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(failed ? `\n${failed} failed` : '\nmode-switch: terminal readiness and reader intent hold across the round trip');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
