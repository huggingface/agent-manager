// Real React, real layout, real measured rows; a synthetic source only.
//
// Two properties this covers that no unit test can:
//   1. the first transcript a cold reader presents FILLS the reader, with real
//      conversation rows rather than estimated spacer height, and
//   2. the older pages that arrive afterwards do not push that text down the
//      screen — measured every frame, not only at the end.
//
// The fixture serves byte windows and HONOURS `bytes`/`min` the way
// server/src/traces.js does. A fixture that returns all of its synthetic turns
// whatever was asked for cannot fail when the reader asks for two, which is the
// defect this exists to catch.
//
// Run with:  node test/readerFirstViewport.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-first-viewport-'));
const bundle = path.join(tmp, 'fixture.js');

await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import ConversationView from './src/components/conversation/ConversationView';
    import {HISTORY_TARGET_EXCHANGES, HISTORY_MAX_EXCHANGES, FILL_MAX_REQUESTS} from './src/lib/traceWindows';
    window.HISTORY_TARGET_EXCHANGES = HISTORY_TARGET_EXCHANGES;
    window.HISTORY_MAX_EXCHANGES = HISTORY_MAX_EXCHANGES;
    window.FILL_MAX_REQUESTS = FILL_MAX_REQUESTS;
    window.WebSocket = class { static OPEN=1; readyState=1; send(){} close(){} };
    window.reads = []; window.__case = 0;

    // ---- a byte-addressed transcript, served as real windows ----
    const WINDOW_MIN_TURNS = 12, WINDOW_MAX_BYTES = 8*1024*1024;
    let cfg = {}, records = [], size = 0, root;
    function lay(options){
      const {count, promptBytes, toolBytes, answerLines, lastAnswerLines} = options;
      records = []; let at = 0;
      const put = (turn, bytes) => { records.push({at, size: bytes, turn}); at += bytes; };
      for (let i = 0; i < count; i++) {
        put({id:'u'+i, role:'user', ts:100000+i*10, blocks:[{type:'text', text:'Question '+i}]}, promptBytes);
        if (toolBytes) put({id:'t'+i, role:'assistant', ts:100001+i*10, blocks:[
          {type:'tool_use', id:'c'+i, name:'Bash', text:'{"command":"check '+i+'"}'},
          {type:'tool_result', id:'c'+i, text:'output for '+i}]}, toolBytes);
        const lines = (i === count-1 && lastAnswerLines) ? lastAnswerLines : answerLines;
        put({id:'a'+i, role:'assistant', ts:100002+i*10, kind:'final', blocks:[{type:'text',
          text:'Answer '+i+'.'+(lines>1 ? '\\n\\n'+Array.from({length:lines-1},(_,k)=>'body line '+k+' of answer '+i).join('\\n') : '')}]},
          Math.max(400, lines*60));
      }
      size = at;
    }
    const inside = (from,to) => records.filter((r) => r.at >= from && r.at + r.size <= to);
    const page = (from,to) => {
      const got = inside(from,to);
      const start = got.length ? got[0].at : to;
      const end = got.length ? got[got.length-1].at + got[got.length-1].size : to;
      return {harness:'claude',harnessLabel:'Fixture',sessionId:'s',title:'',model:null,cwd:null,
        firstTs:0,lastTs:0,usage:null,source:null,sharedBy:null,note:null,truncated:false,
        total:null,userTurns:null,activity:'waiting',generation:'g1',revision:'r1',turns:got.map((r)=>r.turn),
        window:{mode:'bytes',start,end,atStart:start<=0,atEnd:to>=size,generation:'g1',revision:'r1'}};
    };
    const wait = (ms) => ms ? new Promise((r)=>setTimeout(r,ms)) : Promise.resolve();
    window.fixtureApi = {
      async window(id, req, bytes, min){
        window.reads.push({id, at:req.at, bytes, min});
        if (id === 'child') { await wait(cfg.childDelay||0); return page(0, size); }
        await wait(req.at === 'before' ? (cfg.beforeDelay||0) : (cfg.tailDelay||0));
        if (req.at === 'after') return page(req.cursor, size);
        const to = req.at === 'before' ? req.cursor : size;
        const floor = Math.trunc(min) || WINDOW_MIN_TURNS;
        for (let span = bytes || 384*1024; ; span = Math.min(span*2, WINDOW_MAX_BYTES)) {
          const from = Math.max(0, to - span);
          if (inside(from,to).length >= floor || from === 0 || span >= WINDOW_MAX_BYTES) return page(from,to);
        }
      },
      summary(){ return wait(cfg.summaryDelay||0).then(()=>({...page(0,0), total:records.length, userTurns:[]})); },
      roster(){ return cfg.child ? [{agentId:'child',toolUseId:'c0',hasTranscript:true}] : []; },
    };

    // .pane-reader is what gives .cxv its definite height in the app; without
    // it the scroller has no resolved height and the layout under test is not
    // the layout that ships.
    function App(){ return <div style={{position:'absolute',inset:0,display:'flex'}}>
      <div className="pane-reader">
        <ConversationView session={{id:cfg.id,cli:'claude',name:'Fixture',state:'waiting',running:false,
          everStarted:true,path:null,createdAt:new Date().toISOString()}} isMobile={false} />
      </div></div>; }

    window.fixture = {
      mount(options){ window.t0 = performance.now();
        // A distinct id per case: reader stores are cached by session, so
        // reusing one would hand the next case the previous case's warm
        // history and spent budget.
        cfg = {id:'s'+(++window.__case), count:200, promptBytes:200, toolBytes:0, answerLines:1, ...options};
        lay(cfg);
        if (root) flushSync(()=>root.unmount());
        window.reads = [];
        root = createRoot(document.getElementById('fixture-root'));
        flushSync(()=>root.render(<App/>));
      },
      set(options){ Object.assign(cfg, options); },
      // Append a genuinely new exchange, the way a live agent would.
      append(){
        const i = cfg.count;
        cfg.count = i + 1;
        let at = size;
        records.push({at, size:200, turn:{id:'u'+i,role:'user',ts:100000+i*10,blocks:[{type:'text',text:'Question '+i}]}});
        records.push({at:at+200, size:400, turn:{id:'a'+i,role:'assistant',ts:100002+i*10,kind:'final',blocks:[{type:'text',text:'Answer '+i+'.'}]}});
        size = at + 600;
      },
    };

    // ---- measurement helpers, run in the page ----
    const scroller = () => document.querySelector('.cxv-body');
    window.probe = {
      exchanges(){ return Number((document.querySelector('.cxv-status span')?.textContent||'').replace(/[^0-9]/g,'')) || 0; },
      // Does the PRESENTED viewport consist of real conversation rows?
      // Spacer divs and estimated heights cannot satisfy this: it asks whether
      // measured row boxes span the visible band top to bottom.
      coverage(){
        const el = scroller(); if (!el) return null;
        // The band a reader can actually read in: the scroller's CONTENT box,
        // so its own padding is not counted as conversation.
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const top = box.top + parseFloat(style.paddingTop);
        const bottom = box.bottom - parseFloat(style.paddingBottom);
        const usable = Math.round(bottom - top);
        const rows = [...document.querySelectorAll('[data-x]')].map((r)=>r.getBoundingClientRect());
        if (!rows.length) return {usable, rowsTop:null, rowsBottom:null, covered:false, scrollable:false};
        const rowsTop = Math.min(...rows.map((r)=>r.top)), rowsBottom = Math.max(...rows.map((r)=>r.bottom));
        return {usable, top:Math.round(top), bottom:Math.round(bottom),
          rowsTop:Math.round(rowsTop), rowsBottom:Math.round(rowsBottom),
          scrollable: el.scrollHeight - el.clientHeight > 1,
          covered: rowsTop <= top + 1 && rowsBottom >= bottom - 1};
      },
      atBottom(){ const el = scroller(); return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 2; },
      // Is the transcript actually being SHOWN? Rows are laid out and measured
      // while the first page is prepared, so their existence is not the answer.
      shown(){ const r = document.querySelector('.cxv-rows, [data-x]');
        return !!r && getComputedStyle(r.closest('.cxv-rows') || r).visibility !== 'hidden'
          && document.querySelectorAll('[data-x]').length > 0; },
      // Sample the very first frame on which the transcript becomes visible.
      watchReveal(){
        window.reveal = null;
        const step = () => {
          if (!window.reveal && window.probe.shown()) {
            window.reveal = { ...window.probe.coverage(), ex: window.probe.exchanges(),
              atMs: Math.round(performance.now() - window.t0) };
          }
          window._rv = requestAnimationFrame(step);
        };
        step();
      },
      stopReveal(){ cancelAnimationFrame(window._rv); return window.reveal; },
      // What the reader TELLS the user about following, which drives the saved
      // reading position and whether a new reply scrolls into view.
      latestLabel(){ return [...document.querySelectorAll('.cxv-status button')]
        .map((b)=>b.textContent).find((s)=>s === 'At latest' || s === '↓ Latest') || null; },
      track(text){
        window.samples = []; window.trackText = text;
        const find = () => [...document.querySelectorAll('[data-x]')]
          .find((r)=>r.textContent && r.textContent.includes(text));
        window.labels = [];
        const step = () => {
          const el = find();
          if (el) {
            window.samples.push(Math.round(el.getBoundingClientRect().top * 100) / 100);
            window.labels.push(window.probe.latestLabel());
          }
          window._raf = requestAnimationFrame(step);
        };
        step();
      },
      stop(){ cancelAnimationFrame(window._raf); return window.samples || []; },
    };
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.?(?:\/\.\.)*\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: web, loader: 'ts', contents: `
      export * from ${JSON.stringify(path.join(web, 'src/api.ts'))};
      export const getTraceWindow=(id,...args)=>window.fixtureApi.window(id,...args);
      export const getTraceSummary=()=>window.fixtureApi.summary();
      export const getSubAgentWindow=(id,agentId,...args)=>window.fixtureApi.window(agentId,...args);
      export const getSubAgentSummary=()=>window.fixtureApi.summary();
      export const getSubAgents=()=>Promise.resolve({agents:window.fixtureApi.roster()});
      export const sendInput=()=>Promise.resolve({});
    ` }));
  } }],
});

const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
const results = [];
try {
  const p = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  p.on('pageerror', (error) => errors.push(error.message));
  await p.route('**/*', (route) => route.abort());
  await p.setContent('<div id="fixture-root" style="position:absolute;inset:8px;display:flex"></div>');
  // The reader's own two stylesheets are the layout under test; the bundle
  // emits none of its own because ConversationView imports no CSS.
  await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
    + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
  await p.addScriptTag({ path: bundle });
  const TARGET = await p.evaluate(() => window.HISTORY_TARGET_EXCHANGES);
  const MAX = await p.evaluate(() => window.HISTORY_MAX_EXCHANGES);
  const MAX_REQUESTS = await p.evaluate(() => window.FILL_MAX_REQUESTS);

  const settled = async (least) => {
    try {
      await p.waitForFunction((n) => window.probe.exchanges() >= n, least, { timeout: 20_000 });
    } catch {
      assert.fail(`only ${await p.evaluate(() => window.probe.exchanges())} exchanges became `
        + `available on their own; expected at least ${least}. Backward reads: `
        + `${await p.evaluate(() => window.reads.filter((r) => r.at === 'before').length)}`);
    }
    await p.waitForFunction(() => {
      const now = window.probe.exchanges();
      if (window.__last === now) return true;
      window.__last = now; return false;
    }, null, { timeout: 20_000, polling: 400 });
    await p.evaluate(() => { delete window.__last; });
  };

  // ---------- 0. the FIRST transcript the user sees is a page of conversation ----------
  // Not "eventually covered": covered on the frame it first becomes visible.
  // The first window is two exchanges on this fixture, and older pages are slow,
  // so a reader that painted its first response would be caught here.
  await p.evaluate(() => window.fixture.mount({
    count: 200, toolBytes: 90 * 1024, answerLines: 6, beforeDelay: 250 }));
  await p.evaluate(() => window.probe.watchReveal());
  await p.waitForFunction(() => window.probe.shown(), null, { timeout: 20_000 });
  const reveal = await p.evaluate(() => window.probe.stopReveal());
  assert.ok(reveal, 'the transcript became visible');
  assert.ok(reveal.covered,
    `the first transcript the reader shows covers it (${JSON.stringify(reveal)})`);
  assert.ok(reveal.ex > 2,
    `and is more than the first window's two exchanges (${reveal.ex})`);
  assert.equal(await p.locator('.cxv-composer textarea').count(), 1,
    'the composer was never part of the wait');
  results.push({ case: 'first visible transcript', exchanges: reveal.ex,
    covered: reveal.covered, revealedAtMs: reveal.atMs });

  // A conversation with nothing more to load must not wait for anything.
  await p.evaluate(() => window.fixture.mount({ count: 3, answerLines: 2, beforeDelay: 5_000 }));
  await p.getByText('Question 2', { exact: true }).waitFor({ timeout: 3_000 });
  assert.ok(await p.evaluate(() => window.probe.shown()),
    'a short conversation is shown at once rather than held back');

  // ---------- 1. a tool-heavy cold open reaches the target on its own ----------
  await p.evaluate(() => window.fixture.mount({ count: 200, toolBytes: 90 * 1024, answerLines: 6 }));
  await p.getByText('Question 199', { exact: true }).waitFor();
  const firstWindow = await p.evaluate(() => window.probe.exchanges());
  assert.ok(firstWindow < TARGET,
    `the first window alone holds ${firstWindow} exchanges — the case that needs filling`);
  await settled(TARGET);
  const heavy = await p.evaluate(() => window.probe.exchanges());
  assert.ok(heavy >= TARGET, `a cold open reaches ${TARGET} exchanges without scrolling or search (got ${heavy})`);
  assert.equal(await p.evaluate(() => window.reads.some((r) => r.at === 'before')), true,
    'and it got there by paging backward, not by asking for one huge window');
  const cov = await p.evaluate(() => window.probe.coverage());
  assert.ok(cov.scrollable, 'the transcript is taller than the reader');
  assert.ok(cov.covered, `real rows span the visible band (${JSON.stringify(cov)})`);
  assert.ok(await p.evaluate(() => window.probe.atBottom()), 'and Latest is still the bottom');
  results.push({ case: 'tool-heavy cold open', firstWindow, exchanges: heavy, covered: cov.covered });

  // ---------- 2. no history-induced drift, measured every frame ----------
  // The source is fixed and older pages are slow, so any movement of already
  // visible text is the prepends' fault and nothing else's.
  await p.evaluate(() => window.fixture.mount({ count: 200, toolBytes: 90 * 1024, answerLines: 6, beforeDelay: 220 }));
  await p.getByText('Question 199', { exact: true }).waitFor();
  await p.evaluate(() => window.probe.track('Question 199'));
  await settled(TARGET);
  const samples = await p.evaluate(() => window.probe.stop());
  assert.ok(samples.length > 8, `the anchor was sampled across frames (${samples.length} samples)`);
  const drift = Math.max(...samples) - Math.min(...samples);
  assert.ok(drift <= 2, `already-visible text does not move while history loads (max ${drift}px over ${samples.length} frames)`);
  // Following is intent, not geometry. Our own corrections are reported back as
  // scroll events, and taking one for a deliberate scroll upward drops Latest
  // mid-preload: the indicator lies, the saved reading position stops being the
  // end, and the next reply no longer scrolls into view.
  const labels = await p.evaluate(() => window.labels);
  const lost = labels.filter((l) => l !== 'At latest').length;
  assert.equal(lost, 0, `Latest is never given up while history loads (${lost} of ${labels.length} frames said otherwise)`);
  results.push({ case: 'anchor drift while filling', samples: samples.length, driftPx: drift, framesNotAtLatest: lost });

  // ---------- 3. a transcript shorter than the reader sits at the TOP ----------
  // This case used to assert the opposite, held there by a `margin-top: auto`
  // on the rows. The operator overruled it: a conversation shorter than the
  // window sitting on the floor of the pane, with the empty space above it,
  // reads as a layout fault rather than as a reader scrolled to the end.
  // Opening "at the latest" is a scroll POSITION; while nothing overflows there
  // is nothing to scroll and the ordinary thing is to sit at the top.
  //
  // The auto margin's other job was to make a later page grow the transcript
  // upward rather than push the readable text down. That needs a view both
  // shorter than the window AND with unread history above it — which is the
  // case this file's own preparation (case 1) exists to prevent, and which the
  // anchor measurement in case 2 covers once the reader does overflow. A view
  // that is short because the CONVERSATION is short has no older page to
  // prepend, so the margin was a second, cruder guard for a case already held.
  await p.evaluate(() => window.fixture.mount({ count: 3, answerLines: 2 }));
  await p.getByText('Question 2', { exact: true }).waitFor();
  const short = await p.evaluate(() => {
    const el = document.querySelector('.cxv-body');
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const rows = [...document.querySelectorAll('[data-x]')].map((r) => r.getBoundingClientRect());
    return { scrollable: el.scrollHeight - el.clientHeight > 1,
      gapBelow: Math.round(box.bottom - parseFloat(style.paddingBottom) - Math.max(...rows.map((r) => r.bottom))),
      gapAbove: Math.round(Math.min(...rows.map((r) => r.top)) - (box.top + parseFloat(style.paddingTop))) };
  });
  assert.ok(!short.scrollable, 'three short exchanges really are shorter than the reader');
  // What is left above the first row is the reader's own chrome — the
  // beginning-of-conversation line — not free space: it does not grow as the
  // transcript gets shorter, which is exactly how it differs from the gap the
  // auto margin used to leave there.
  assert.ok(short.gapAbove < 40,
    `and start at the top of it (${short.gapAbove}px above, ${short.gapBelow}px below)`);
  assert.ok(short.gapBelow > short.gapAbove,
    `with the empty space below them, not above (${short.gapBelow} vs ${short.gapAbove})`);
  results.push({ case: 'short transcript anchoring', gapBelow: short.gapBelow, gapAbove: short.gapAbove });

  // ---------- 4. a tall answer covers the page but history still loads ----------
  // Slow older pages, so the state where ONE answer covers the reader and the
  // history target is still unmet is observable rather than a race.
  await p.evaluate(() => window.fixture.mount({
    count: 200, toolBytes: 90 * 1024, answerLines: 3, lastAnswerLines: 140, beforeDelay: 400 }));
  await p.getByText('Question 199', { exact: true }).waitFor();
  await p.waitForFunction(() => window.probe.coverage()?.covered, null, { timeout: 15_000 });
  const tallCover = await p.evaluate(() => ({ ...window.probe.coverage(), ex: window.probe.exchanges() }));
  assert.ok(tallCover.covered, 'one long answer already fills the reader');
  assert.ok(tallCover.ex < TARGET,
    `and it did so with only ${tallCover.ex} exchanges — coverage is not the history target`);
  await settled(TARGET);
  const tall = await p.evaluate(() => window.probe.exchanges());
  assert.ok(tall >= TARGET,
    `covering the viewport is not a reason to stop loading history (got ${tall} of ${TARGET})`);
  results.push({ case: 'tall answer fills page', exchanges: tall });

  // ---------- 5. very short exchanges: more than the target to fill a page ----------
  // One-line turns in a tall window. Each record is large in BYTES and small on
  // screen, which is the shape that makes the exchange target insufficient: the
  // window budget is spent long before the viewport is covered.
  await p.setViewportSize({ width: 820, height: 2600 });
  await p.evaluate(() => window.fixture.mount({ count: 400, promptBytes: 5200, answerLines: 1 }));
  await p.getByText('Question 399', { exact: true }).waitFor();
  // Non-vacuity is the OUTCOME here: the fill stops at the exchange target on
  // its own, so going past it can only be the coverage rule asking for more.
  await settled(TARGET + 1);
  const tinyCov = await p.evaluate(() => window.probe.coverage());
  const tiny = await p.evaluate(() => window.probe.exchanges());
  assert.ok(tinyCov.covered, `so it keeps going until they do (${tiny} exchanges, ${JSON.stringify(tinyCov)})`);
  assert.ok(tiny > TARGET, `which took more than the target (${tiny} > ${TARGET})`);
  const tinyReads = await p.evaluate(() => window.reads.filter((r) => r.at === 'before').length);
  assert.ok(tinyReads <= MAX_REQUESTS, `and stayed inside the request budget (${tinyReads} <= ${MAX_REQUESTS})`);
  results.push({ case: 'tiny exchanges, tall viewport', exchanges: tiny, backwardReads: tinyReads, covered: tinyCov.covered });
  await p.setViewportSize({ width: 1000, height: 760 });

  // ---------- 6. a genuinely short conversation settles at once ----------
  for (const count of [0, 1, 2, 5]) {
    await p.evaluate((n) => window.fixture.mount({ count: n }), count);
    if (count) await p.getByText(`Question ${count - 1}`, { exact: true }).waitFor();
    else await p.getByText('Start the conversation.', { exact: true }).waitFor();
    await p.waitForFunction((n) => window.probe.exchanges() === n, count, { timeout: 10_000 });
    assert.equal(await p.locator('.cxv-top').getAttribute('disabled'), '',
      `a ${count}-exchange conversation reports the beginning rather than spinning`);
    // Making the column fill the reader must not invent a scroll range for a
    // conversation that has nothing to scroll.
    const slack = await p.evaluate(() => { const el = document.querySelector('.cxv-body');
      return el.scrollHeight - el.clientHeight; });
    assert.ok(slack <= 1, `and nothing to scroll (${slack}px of slack at ${count} exchanges)`);
  }
  results.push({ case: 'short conversations', exchanges: 'all of them' });

  // ---------- 7. a live append still moves the view; that is not drift ----------
  await p.evaluate(() => window.fixture.mount({ count: 30, promptBytes: 200, answerLines: 4 }));
  await p.getByText('Question 29', { exact: true }).waitFor();
  await settled(Math.min(TARGET, 30));
  await p.evaluate(() => window.probe.track('Question 29'));
  await p.evaluate(() => window.fixture.append());
  await p.getByText('Question 30', { exact: true }).waitFor({ timeout: 20_000 });
  const live = await p.evaluate(() => window.probe.stop());
  assert.ok(Math.max(...live) - Math.min(...live) > 2,
    'a new reply scrolls the follower, which is Latest behaving, not history drift');
  assert.ok(await p.evaluate(() => window.probe.atBottom()), 'and Latest is the bottom again');
  results.push({ case: 'live append', movedPx: Math.round(Math.max(...live) - Math.min(...live)) });

  // ---------- 8. a slow summary cannot hold up history ----------
  await p.evaluate(() => window.fixture.mount({ count: 200, toolBytes: 90 * 1024, answerLines: 6, summaryDelay: 60_000 }));
  await p.getByText('Question 199', { exact: true }).waitFor();
  await settled(TARGET);
  assert.ok(await p.evaluate(() => window.probe.exchanges()) >= TARGET,
    'recent history does not wait for a whole-transcript summary');
  assert.equal(await p.locator('.cxv-composer textarea').count(), 1, 'and the composer is there throughout');
  results.push({ case: 'hung summary', exchanges: await p.evaluate(() => window.probe.exchanges()) });

  // ---------- 9. a child transcript keeps its own top-of-context policy ----------
  await p.evaluate(() => window.fixture.mount({ count: 200, toolBytes: 90 * 1024, answerLines: 6 }));
  await p.getByText('Question 199', { exact: true }).waitFor();
  await settled(TARGET);
  const parentReads = await p.evaluate(() => window.reads.filter((r) => r.id !== 'child').length);
  assert.ok(await p.evaluate(() => window.reads.every((r) => r.id !== 'child')),
    'no speculative child reader is created by the parent preload');
  assert.ok(parentReads <= 12, `the whole cold open is a bounded number of requests (${parentReads})`);
  assert.ok(await p.locator('[data-x]').count() < 40, 'and the rendered window stays virtualized');
  results.push({ case: 'requests for a cold open', reads: parentReads });

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 1));
console.log('reader-first-viewport: ok');
