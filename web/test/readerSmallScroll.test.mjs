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



const browser = await chromium.launch(chromiumLaunchOptions());

/** Nearer than this to the end counts as "at the end" — see AT_END_PX in
 *  ConversationView. The gestures below are deliberately larger than it and
 *  much smaller than the 48px this used to require. */
const SMALL_WHEEL = 20;
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

try {
  for (const [label, width, height, touch] of [['desktop', 1100, 800, false], ['phone', 390, 844, true]]) {
    console.log(`\n### ${label} ${width}x${height}`);
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('**/*', (route) => route.request().url() === 'http://fixture.test/'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="fixture-root" style="display:flex;position:absolute;inset:10px"></div>' })
      : route.abort());
    await p.goto('http://fixture.test/');
    await p.addStyleTag({ path: bundle.replace(/\.js$/, '.css') });
    await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
      + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
    await p.addScriptTag({ path: bundle });

    /** A reader settled at the very end of a long conversation, nothing in
     *  flight — the state the operator is in when this happens. */
    const settledAtEnd = async (id) => {
      await p.evaluate((i) => window.fixture.mount({ mode: 'reader', id: i, count: 80,
        payload: ['fixture terminal content\r\n'] }), id);
      await p.waitForSelector('.cxv-body');
      await p.waitForFunction(() => {
        const e = document.querySelector('.cxv-body');
        return e.scrollHeight > e.clientHeight && Math.abs(e.scrollHeight - e.scrollTop - e.clientHeight) < 2;
      }, null, { timeout: 20_000 });
      await p.waitForTimeout(500);
    };
    const fromBottom = () => p.evaluate(() => {
      const e = document.querySelector('.cxv-body');
      return Math.round(e.scrollHeight - e.scrollTop - e.clientHeight);
    });
    const label_ = () => p.evaluate(() => (document.querySelector('.cxv-status')?.textContent || '').includes('At latest')
      ? 'At latest' : 'Latest');
    const overReader = async () => {
      const box = await p.locator('.cxv-body').boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };

    // ---- a gentle wheel, the way a person nudges a page back ----
    await settledAtEnd(`${label}-wheel`);
    await overReader();
    const steps = [await fromBottom()];
    for (let i = 0; i < 8; i++) { await p.mouse.wheel(0, -SMALL_WHEEL); await p.waitForTimeout(100); steps.push(await fromBottom()); }
    console.log(`  small wheel, distance from the end: ${JSON.stringify(steps)}`);
    check(`${SMALL_WHEEL}px wheel notches move the reader away from the end`, () => {
      assert.equal(steps[0], 0, 'the reader did not start at the end');
      // Each notch must land further back than the one before: this is what
      // "small movements accumulate" means, and on main every entry is 0.
      assert.ok(steps[1] >= SMALL_WHEEL - 2, `one notch moved it ${steps[1]}px`);
      assert.ok(steps.at(-1) > steps[1], `eight notches ended at ${steps.at(-1)}px, one at ${steps[1]}px`);
    });
    const movedLabel = await label_();
    check('and it stops claiming to be at the latest', () => {
      assert.equal(movedLabel, 'Latest', 'the status still says At latest');
    });

    // ---- it must STAY away while rows measure and the agent writes ----
    await p.evaluate(() => window.fixture.change({ count: 84 }));
    await p.waitForTimeout(1200);
    const afterGrowth = await fromBottom();
    check('a reader nudged away is not pulled back when content arrives', () => {
      assert.ok(afterGrowth >= SMALL_WHEEL,
        `content growth pulled it back to ${afterGrowth}px from the end`);
    });

    // ---- Latest still works, and following resumes ----
    await p.getByRole('button', { name: /Latest/ }).click();
    await p.waitForTimeout(600);
    const afterLatest = await fromBottom();
    const latestLabel = await label_();
    check('Latest returns to the end and resumes following', () => {
      assert.ok(afterLatest <= 4, `Latest left it ${afterLatest}px from the end`);
      assert.equal(latestLabel, 'At latest');
    });
    await p.evaluate(() => window.fixture.change({ count: 88 }));
    await p.waitForTimeout(1200);
    const followed = await fromBottom();
    check('and new content then keeps it at the end', () => {
      assert.ok(followed <= 4, `it drifted ${followed}px from the end`);
    });

    // ---- a slow trusted touch drag, on the phone ----
    if (touch) {
      await settledAtEnd(`${label}-touch`);
      const box = await p.locator('.cxv-body').boundingBox();
      const cdp = await context.newCDPSession(p);
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height * 0.3);
      const before = await fromBottom();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 12 }] });
        await p.waitForTimeout(25);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await p.waitForTimeout(400);
      const after = await fromBottom();
      console.log(`  slow touch drag: ${before}px -> ${after}px from the end`);
      check('a slow touch drag of 12px steps moves the reader', () => {
        assert.equal(before, 0, 'the reader did not start at the end');
        assert.ok(after > 24, `twelve 12px moves left it ${after}px from the end`);
      });
    }

    check('no page errors', () => assert.deepEqual(errors, [], errors.slice(0, 2).join(' | ')));
    await context.close();
  }
} finally {
  await browser.close();
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nreader-small-scroll: gentle upward input moves the reader and stays');
process.exit(failed ? 1 : 0);
