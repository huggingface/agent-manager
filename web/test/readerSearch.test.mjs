// Whole-conversation search in the real Reader: finding a message the reader
// never loaded, and opening it without dragging every page in between through
// the browser.
//
// The premise every case here depends on: the needle is in the FIRST exchange
// of a transcript far larger than the reader's history budget, so a test that
// could be satisfied by filtering loaded turns would fail immediately.
//
// Run with:  node test/readerSearch.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-search-'));
const bundle = path.join(tmp, 'fixture.js');

await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import ConversationView from './src/components/conversation/ConversationView';
    window.WebSocket = class { static OPEN=1; readyState=1; constructor(){window.sockets.push(this);} send(){} close(){} };
    window.sockets = []; window.sends = []; window.reads = []; window.searches = []; window.__case = 0;

    const WINDOW_MIN_TURNS = 12, WINDOW_MAX_BYTES = 8*1024*1024;
    let cfg = {}, records = [], size = 0, root;
    // Exchange 0 carries the needle; everything after it is bulk. 90 KiB of tool
    // output per exchange means the reader's whole budget covers a couple of
    // dozen at the tail and never reaches the start.
    function lay(o){
      records = []; let at = 0;
      const put = (turn,b)=>{records.push({at,size:b,turn}); at+=b;};
      for (let i=0;i<o.count;i++){
        const prompt = i === 0 ? 'first of all, check the ZEPHYRQUARTZ deployment' : 'Question '+i;
        put({id:'u'+i,role:'user',ts:100000+i*10,blocks:[{type:'text',text:prompt}]}, 300);
        put({id:'t'+i,role:'assistant',ts:100001+i*10,blocks:[
          {type:'tool_use',id:'c'+i,name:'Bash',text:'{"command":"check '+i+'"}'},
          {type:'tool_result',id:'c'+i,text:'output for '+i}]}, o.toolBytes);
        put({id:'a'+i,role:'assistant',ts:100002+i*10,kind:'final',
          blocks:[{type:'text',text:'Answer '+i+'.'+(i===0?' ZEPHYRQUARTZ looks fine.':'')}]}, 600);
      }
      size = at;
    }
    const inside=(f,t)=>records.filter(r=>r.at>=f&&r.at+r.size<=t);
    const page=(f,t)=>{const g=inside(f,t);const s=g.length?g[0].at:t;const e=g.length?g[g.length-1].at+g[g.length-1].size:t;
      return {harness:'claude',harnessLabel:'F',sessionId:'s',title:'',model:null,cwd:null,firstTs:0,lastTs:0,usage:null,
        source:null,sharedBy:null,note:null,truncated:false,total:null,userTurns:null,activity:'waiting',
        generation:'g1',revision:'r1',turns:g.map(r=>r.turn),
        window:{mode:'bytes',start:s,end:e,atStart:s<=0,atEnd:t>=size,generation:'g1',revision:'r1'}};};
    const wait=(ms)=>ms?new Promise(r=>setTimeout(r,ms)):Promise.resolve();

    // A stand-in for the server scan: same contract, same page-boundary cursors.
    const SCAN_PAGE = 256*1024;
    const textOf=(turn)=>turn.blocks.map(b=>[b.name||'',b.text||''].join('\\n')).join('\\n');
    window.fixtureApi = {
      async window(id, req, bytes, min, signal){
        window.reads.push({at:req.at, cursor:req.cursor, bytes});
        await wait(req.at==='before' ? (cfg.beforeDelay||0) : 0);
        if (signal?.aborted) throw Object.assign(new Error('aborted'), {name:'AbortError'});
        if (req.at==='after') return page(req.cursor, size);
        const to = req.at==='before' ? req.cursor : size;
        const floor = Math.trunc(min) || WINDOW_MIN_TURNS;
        for (let span = bytes || 384*1024;; span = Math.min(span*2, WINDOW_MAX_BYTES)) {
          const from = Math.max(0, to-span);
          if (inside(from,to).length>=floor || from===0 || span>=WINDOW_MAX_BYTES) return page(from,to);
        }
      },
      async search(id, q, cursor, generation, signal){
        const call = {q, cursor}; window.searches.push(call);
        // The ABANDONED query is the slow one, so its answer lands after the
        // newer query's. A stale result that arrives first is overwritten by
        // the fresh one anyway and proves nothing.
        await wait(cfg.slowQuery && q.includes(cfg.slowQuery) ? 800 : (cfg.searchDelay||0));
        // A transport that answers an abandoned request anyway. Suspended tabs
        // and cached responses both do this, and the reader's own window store
        // already carries a comment about it, so the guard cannot rely on the
        // abort arriving as a rejection.
        if (signal?.aborted && !cfg.searchIgnoresAbort) throw Object.assign(new Error('aborted'), {name:'AbortError'});
        if (cfg.searchFails) throw new Error('the search could not finish');
        const needle = q.toLowerCase();
        let at = cursor === null || cursor === undefined ? size : Number(cursor);
        const hits = []; let pages = 0; let atStart = at <= 0;
        while (!atStart && hits.length < (cfg.searchLimit||50) && pages < 200) {
          const from = Math.max(0, at - SCAN_PAGE);
          const got = inside(from, at); pages++;
          const end = got.length ? got[got.length-1].at+got[got.length-1].size : at;
          for (let i = got.length-1; i >= 0; i--) {
            const text = textOf(got[i].turn);
            const idx = text.toLowerCase().indexOf(needle);
            if (idx < 0) continue;
            hits.push({id:got[i].turn.id, role:got[i].turn.role, ts:got[i].turn.ts, occurrences:1, clipped:false,
              snippet:{text:text.slice(Math.max(0,idx-20), idx+needle.length+40), at:Math.min(20,idx), length:needle.length},
              window:{at:'before', cursor:end, bytes:SCAN_PAGE}});
          }
          const next = got.length ? got[0].at : from;
          if (next >= at) break;
          at = next; atStart = at <= 0;
        }
        return {query:q, mode:'bytes', hits, next: atStart ? null : String(at),
          complete: atStart, blocked:false, clipped:!!cfg.searchClipped, scanned:size-at, boundary:size,
          generation:'g1', revision:'r1'};
      },
      summary(){ return Promise.resolve({...page(0,0), total:records.length, userTurns:[]}); },
    };

    function App(){ return <div style={{position:'absolute',inset:0,display:'flex'}}><div className="pane-reader">
      <ConversationView session={{id:cfg.id,cli:'claude',name:'F',state:'waiting',running:false,everStarted:true,
        path:null,createdAt:new Date().toISOString()}} isMobile={false} searchOpen={cfg.searchOpen !== false}
        onCloseSearch={()=>{}} /></div></div>; }
    window.fixture = {
      mount(options){
        cfg = {id:'s'+(++window.__case), count:120, toolBytes:90*1024, searchOpen:true, ...options};
        lay(cfg);
        if (root) flushSync(()=>root.unmount());
        window.reads = []; window.searches = []; window.sends = []; window.sockets = [];
        root = createRoot(document.getElementById('fixture-root'));
        flushSync(()=>root.render(<App/>));
      },
      set(o){ Object.assign(cfg, o); },
    };
    window.probe = {
      exchanges(){ return Number((document.querySelector('.cxv-status span')?.textContent||'').replace(/[^0-9]/g,''))||0; },
      hitRows(){ return document.querySelectorAll('.cxv-hitrow').length; },
      historic(){ return document.querySelectorAll('[data-historic]').length; },
      shown(){ const r=document.querySelector('.cxv-rows');
        return !!r && getComputedStyle(r).visibility !== 'hidden' && document.querySelectorAll('[data-x]').length>0; },
      atBottom(){ const el=document.querySelector('.cxv-body'); return !!el && el.scrollHeight-el.scrollTop-el.clientHeight<2; },
      text(){ return document.querySelector('.cxv-body')?.innerText || ''; },
      // The TRANSCRIPT only. The results list quotes the match too, so reading
      // the whole pane would answer a different question than the one asked.
      transcript(){ return [...document.querySelectorAll('[data-x]')].map((r)=>r.innerText).join(' '); },
    };
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.?(?:\/\.\.)*\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: web, loader: 'ts', contents: `
      export * from ${JSON.stringify(path.join(web, 'src/api.ts'))};
      export const getTraceWindow=(id,...a)=>window.fixtureApi.window(id,...a);
      export const getTraceSummary=()=>window.fixtureApi.summary();
      export const searchTraceHistory=(id,...a)=>window.fixtureApi.search(id,...a);
      export const getSubAgentWindow=(i,a,...r)=>window.fixtureApi.window(a,...r);
      export const getSubAgentSummary=()=>window.fixtureApi.summary();
      export const getSubAgents=()=>Promise.resolve({agents:[]});
      export const sendInput=(id,text)=>{window.sends.push({id,text});return Promise.resolve({});};
    ` }));
  } }],
});

const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
const results = [];
try {
  const p = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('**/*', (r) => r.abort());
  await p.setContent('<div id="fixture-root" style="position:absolute;inset:8px;display:flex"></div>');
  await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
    + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
  await p.addScriptTag({ path: bundle });

  const box = p.locator('.cxv-search');
  const searchAll = p.getByRole('button', { name: /Search all history|Searching all/ });
  const open = async (options = {}) => {
    await p.evaluate((o) => window.fixture.mount(o), options);
    await p.waitForFunction(() => window.probe.shown(), null, { timeout: 20_000 });
  };

  // ---------- the premise: the needle is nowhere near the loaded stretch ----------
  await open();
  const loaded = await p.evaluate(() => window.probe.exchanges());
  assert.ok(loaded > 1 && loaded < 100, `the reader loaded a tail, not the conversation (${loaded} of 120)`);
  assert.ok(!(await p.evaluate(() => window.probe.transcript())).includes('ZEPHYRQUARTZ'),
    'and the needle is not in it');
  await box.fill('ZEPHYRQUARTZ');
  await p.waitForFunction(() => document.querySelector('.cxv-hits')?.textContent === 'No matches');

  // ---------- typing never scans the transcript ----------
  assert.deepEqual(await p.evaluate(() => window.searches), [],
    'typing filters the loaded stretch and nothing else');

  // ---------- the explicit action finds it ----------
  await searchAll.click();
  await p.waitForFunction(() => window.probe.hitRows() > 0, null, { timeout: 20_000 });
  const found = await p.evaluate(() => window.probe.hitRows());
  assert.ok(found >= 2, `the whole conversation is searched (${found} matching messages)`);
  assert.equal(await p.evaluate(() => window.searches.length), 1, 'one scan, not one per keystroke');
  await p.getByText(/messages match “ZEPHYRQUARTZ”/).waitFor();
  results.push({ case: 'unloaded match found', loadedExchanges: loaded, hits: found });

  // ---------- opening a hit does not drag the transcript back to it ----------
  await p.locator('.cxv-hitrow').last().click();
  await p.waitForFunction(() => window.probe.historic() > 0, null, { timeout: 20_000 });
  // Counting reads outright would be flaky — the live reader keeps polling and
  // may still be filling. The invariants that actually distinguish a jump from
  // a walk are the SHAPE of the read and the total: reaching exchange 0 of this
  // fixture page by page is roughly 28 backward windows.
  const jump = await p.evaluate(() => {
    const opened = window.reads[window.reads.length - 1];
    return { opened, backward: window.reads.filter((r) => r.at === 'before').length };
  });
  assert.equal(jump.opened.at, 'before', 'a hit is opened with the locator the search handed back');
  assert.equal(jump.opened.bytes, 256 * 1024, 'including its window size, so it is that exact page');
  assert.ok(jump.backward <= 10,
    `and nothing walked the transcript back to it (${jump.backward} backward reads in total)`);
  assert.ok((await p.evaluate(() => window.probe.transcript())).includes('ZEPHYRQUARTZ'),
    'the match is on screen with its surrounding conversation');
  assert.ok(await p.evaluate(() => window.probe.historic()) <= 30, 'with a bounded number of rows');
  await p.getByText(/Showing an older part of the conversation/).waitFor();
  // The reader was following the latest message when this hit was opened. The
  // header must not go on saying so while the pane shows something from the
  // middle of the conversation — the old window's geometry is not the live
  // view's, and reading follow state out of it is how that claim gets made.
  await new Promise((r) => setTimeout(r, 400));
  assert.notEqual(await p.evaluate(() => [...document.querySelectorAll('.cxv-status button')]
    .map((b) => b.textContent)[1]), 'At latest',
    'the reader does not claim to be at the latest message while showing an old one');
  assert.equal(await p.evaluate(() => window.sockets.length), 0, 'reading old history starts no terminal');
  assert.deepEqual(await p.evaluate(() => window.sends), [], 'and types nothing into the agent');
  results.push({ case: 'jump to old hit', backwardReads: jump.backward });

  // ---------- and leaving it puts the reader back where it was ----------
  // The old window borrows the one scroller, so scrolling inside it must not
  // become the live view's reading position. With a query that DOES match
  // loaded turns, coming back has a definite right answer: the same row, in the
  // same place.
  await p.getByRole('button', { name: 'Back to the current view' }).click();
  await p.waitForFunction(() => window.probe.historic() === 0);
  assert.ok(!(await p.evaluate(() => window.probe.transcript())).includes('ZEPHYRQUARTZ'),
    'showing the live conversation again, not the old window');
  assert.ok(await p.evaluate(() => window.probe.hitRows()) > 0,
    'while the results you came from are still there to go back to');

  await box.fill('Question');
  await p.waitForFunction(() => document.querySelectorAll('[data-x]').length > 2);
  await p.evaluate(() => { document.querySelector('.cxv-body').scrollTop = 140; });
  await new Promise((r) => setTimeout(r, 250));
  const anchored = await p.evaluate(() => {
    const el = document.querySelector('.cxv-body');
    const edge = el.getBoundingClientRect().top;
    const row = [...document.querySelectorAll('[data-x]')].find((r) => r.getBoundingClientRect().bottom > edge);
    return { key: row.dataset.x, top: Math.round(row.getBoundingClientRect().top),
      st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight,
      rows: document.querySelectorAll('[data-x]').length };
  });
  await searchAll.click();
  await p.waitForFunction(() => window.probe.hitRows() > 0, null, { timeout: 20_000 });
  await p.locator('.cxv-hitrow').last().click();
  await p.waitForFunction(() => window.probe.historic() > 0, null, { timeout: 20_000 });
  // Opened from a position part-way up the live transcript, so the live list's
  // own anchor points at a row that is now hidden and measures as nothing. The
  // old window must still land on its match rather than being dragged to the
  // top by a correction computed against a display:none subtree.
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(await p.evaluate(() => {
    const el = document.querySelector('.cxv-body');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  }), 'the old window opens on its match, not wherever the hidden live list points');
  // Scrolling to the top of a BORROWED window is not the reader reaching the
  // top of the live transcript, and must not make it page backward — with the
  // query cleared, the live view's own "near the top, load earlier" rule would
  // otherwise fire on someone else's scroll position.
  await box.fill('');
  await new Promise((r) => setTimeout(r, 200));
  const beforeScroll = await p.evaluate(() => window.reads.filter((r) => r.at === 'before').length);
  await p.evaluate(() => { document.querySelector('.cxv-body').scrollTop = 0; });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await p.evaluate(() => window.reads.filter((r) => r.at === 'before').length), beforeScroll,
    'scrolling inside an old window does not page the live transcript');
  await box.fill('Question');
  await new Promise((r) => setTimeout(r, 200));
  await p.getByRole('button', { name: 'Back to the current view' }).click();
  await p.waitForFunction(() => window.probe.historic() === 0);
  await new Promise((r) => setTimeout(r, 400));
  const returned = await p.evaluate((key) => {
    const row = document.querySelector(`[data-x="${key}"]`);
    return row ? Math.round(row.getBoundingClientRect().top) : null;
  }, anchored.key);
  assert.notEqual(returned, null, 'the row that was being read is still rendered');
  assert.ok(Math.abs(returned - anchored.top) <= 2,
    `and in the same place (${anchored.top}px before opening a hit, ${returned}px after coming back)`);
  results.push({ case: 'return from an old hit', anchorDriftPx: Math.abs(returned - anchored.top) });

  // ---------- a term that is nowhere is reported as nowhere, once complete ----------
  await open();
  await box.fill('NOTHINGLIKETHISEXISTS');
  await searchAll.click();
  await p.getByText(/No message in this conversation contains/).waitFor({ timeout: 20_000 });
  results.push({ case: 'no matches', reported: 'complete' });

  // ---------- a partial scan never claims to be complete ----------
  await open({ searchLimit: 2 });
  await box.fill('Question');
  await searchAll.click();
  await p.waitForFunction(() => window.probe.hitRows() > 0, null, { timeout: 20_000 });
  await p.getByText(/not the whole conversation yet/).waitFor();
  const more = p.getByRole('button', { name: 'Keep searching earlier' });
  await more.waitFor();
  const firstPage = await p.evaluate(() => window.probe.hitRows());
  await more.click();
  await p.waitForFunction((n) => window.probe.hitRows() > n, firstPage, { timeout: 20_000 });
  assert.equal(await p.evaluate(() => window.searches.length), 2, 'continuing is one more bounded request');
  assert.ok(await p.evaluate(() => window.searches[1].cursor) !== null, 'and it continues from a cursor');
  results.push({ case: 'partial scan', firstPage, thenMore: await p.evaluate(() => window.probe.hitRows()) });

  // ---------- a failed scan says so and can be retried ----------
  await open({ searchFails: true });
  await box.fill('ZEPHYRQUARTZ');
  await searchAll.click();
  await p.getByText(/could not finish/).waitFor({ timeout: 20_000 });
  await p.evaluate(() => window.fixture.set({ searchFails: false }));
  await p.getByRole('button', { name: 'Try again' }).click();
  await p.waitForFunction(() => window.probe.hitRows() > 0, null, { timeout: 20_000 });
  results.push({ case: 'failed then retried', ok: true });

  // ---------- a late answer to an abandoned query cannot win ----------
  // Twice: once where the abandoned request rejects on abort, and once where it
  // resolves anyway — only the second reaches the code that binds a result to
  // the run that asked for it.
  for (const searchIgnoresAbort of [false, true]) {
  await open({ searchDelay: 30, slowQuery: 'ZEPHYRQUARTZ', searchIgnoresAbort });
  // The button disables itself while a scan runs, so overlap has to come from
  // the keyboard shortcut — which is exactly the path a user hurrying through
  // a re-typed query takes.
  await box.fill('ZEPHYRQUARTZ');
  await box.press('Control+Enter');
  await p.waitForFunction(() => window.searches.length === 1);
  await box.fill('Answer 5');
  await box.press('Control+Enter');
  await p.waitForFunction(() => window.searches.length === 2);
  await p.waitForFunction(() => window.probe.hitRows() > 0, null, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 1200));
  const shownQuery = await p.evaluate(() => document.querySelector('.cxv-scan .cxv-msg')?.textContent || '');
  assert.ok(shownQuery.includes('Answer 5'), `the newest query owns the results (${shownQuery.slice(0, 80)})`);
  assert.ok(!shownQuery.includes('ZEPHYRQUARTZ'),
    `the abandoned one does not come back (abort ${searchIgnoresAbort ? 'ignored' : 'honoured'})`);
  results.push({ case: `stale scan discarded (abort ${searchIgnoresAbort ? 'ignored' : 'honoured'})`, ok: true });
  }

  // ---------- clipped coverage is disclosed rather than glossed over ----------
  await open({ searchClipped: true });
  await box.fill('ZEPHYRQUARTZ');
  await searchAll.click();
  await p.getByText(/searched only as far as the reader displays them/).waitFor({ timeout: 20_000 });
  results.push({ case: 'clipped disclosure', ok: true });

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 1));
console.log('reader-search: ok');
