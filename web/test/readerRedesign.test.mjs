// Real React, terminal pane and layout; synthetic APIs only. Never starts an agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-redesign-'));
const bundle = path.join(tmp, 'fixture.js');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import TerminalPane from './src/components/TerminalPane';
    import {TraceUnavailable} from './src/api';
    window.sockets = []; window.sends = []; window.reads = []; window.sharedSends=[]; window.sharedAnswers=[]; window.interrupts=[]; window.reconnections=[]; window.closes=0;
    const storage = new Map(); Object.defineProperty(window, 'localStorage', {value:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
    class FakeSocket { static OPEN=1; readyState=1; constructor(){window.sockets.push(this); if(window.refuseSockets)setTimeout(()=>{this.readyState=3;this.onclose?.({code:1006});},1);} send(){} close(){this.readyState=3;} }
    window.WebSocket = FakeSocket;
    let config = {}, root;
    const records = (count) => Array.from({length:count}, (_,i) => [
      {id:'u'+i,role:'user',ts:100000+i*1000,blocks:[{type:'text',text:'Question '+i}]},
      {id:'a'+i,role:'assistant',ts:100500+i*1000,kind:'final',blocks:[{type:'text',text:'Answer '+i+' — completed.\\n\\n'+
        Array.from({length:1+(i*37)%120},(_,k)=>'line '+k+' of answer '+i).join('\\n')}]},
    ]).flat();
    const page = (turns, from=0, end=turns.length) => ({
      harness:'claude',harnessLabel:'Fixture',sessionId:config.id,title:'',model:null,cwd:null,firstTs:100000,lastTs:100500,
      usage:null,source:null,sharedBy:null,note:null,truncated:false,total:null,userTurns:null,activity:config.activity||'waiting',generation:'fixture',revision:'r1',turns,
      ...((config.shared||config.bound)?{interaction:{canSend:!config.sharedBusy&&!config.sharedRequest,requests:config.sharedRequest?[config.sharedRequest]:[],error:null}}:{}),
      window:{mode:'bytes',start:from,end,atStart:from===0,atEnd:true,generation:'fixture',revision:'r1'},
    });
    window.fixtureApi = {
      window(id,req,bytes,min,signal){
        const call={id,req,bytes,aborted:false}; window.reads.push(call); signal?.addEventListener('abort',()=>call.aborted=true);
        if(config.behavior==='hang' && id!=='follower')return new Promise(()=>{});
        if(config.hangAfter && req.at==='after')return new Promise(()=>{});
        if(config.behavior==='no-trace')return Promise.reject(new TraceUnavailable('No trace found','no-trace'));
        if(config.child && id!=='child' && req.at==='tail')return Promise.resolve(page([
          {id:'parent-u',role:'user',ts:100000,blocks:[{type:'text',text:'Delegate this task'}]},
          {id:'parent-a',role:'assistant',ts:100500,blocks:[
            {type:'tool_use',id:'spawn',name:'Agent',text:JSON.stringify({description:'Inspect fixture',prompt:'Task: inspect the fixture'})},
            {type:'tool_result',id:'spawn',text:'Async agent launched successfully. agentId: child'}]},
        ]));
        const child=config.child && id==='child';
        const all=records(child?100:config.count||2);
        if(child)all[0].blocks[0].text='Task: inspect the fixture';
        if(req.at==='after')return Promise.resolve(config.incremental ? page(all.slice(req.cursor),req.cursor,all.length) : page([],req.cursor,req.cursor));
        if(req.at==='before')return Promise.resolve(page(all.slice(0,req.cursor),0,req.cursor));
        const from=child ? (config.childEarlier ? 160 : bytes>=2*1024*1024 ? 0 : 196) : (config.from||0)*2;
        return Promise.resolve(page(all.slice(from),from,all.length));
      },
      send(id,text){window.sends.push({id,text});if(config.shared||config.bound){window.sharedSends.push({id,text});if(config.failSharedSend){config.failSharedSend=false;return Promise.reject(new Error('Delivery uncertain'));}}return Promise.resolve({ok:true});},
      reconnect(id,recoveryKey){window.reconnections.push({id,recoveryKey});return config.rejectReconnect?Promise.reject(new Error('Saved task changed')):Promise.resolve({ok:true});},
      interrupt(id,turnId){window.interrupts.push({id,turnId});return config.rejectInterrupt?Promise.reject(new Error('That turn is no longer active')):Promise.resolve({ok:true,requested:true,turnId});},
      answer(id,key,response){window.sharedAnswers.push({id,key,response});config.sharedRequest=null;return Promise.resolve({ok:true});},
      summary(){return Promise.resolve({...page([]),total:2*(config.count||2),userTurns:[]});},
      roster(){return config.child?[{agentId:'child',toolUseId:'spawn',hasTranscript:true}]:[];},
    };
    function Pane({id}) {return <div className="tile" style={{position:'relative',flex:1,minWidth:0}}><TerminalPane
      session={{id,cli:config.shared?'codex':'claude',codexSharedOnly:config.shared,codexShared:config.bound,interruptTurnId:config.turnId,recoveryKey:config.recoveryKey,archivedAt:config.archivedAt,name:'Reader fixture',state:config.state||'waiting',running:true,everStarted:true,path:null,createdAt:new Date().toISOString()}}
      cli={{id:'claude',label:'Fixture',color:'#777'}} mode={config.mode||'reader'} theme="light" zoom={config.zoom||100}
      isMobile={config.mobile} focused active={config.active!==false} visible onClose={()=>{window.closes++;}} /></div>}
    function App(){return <><Pane id={config.id}/>{config.group&&<Pane id="follower"/>}</>}
    window.fixture = {
      mount(options){if(root)flushSync(()=>root.unmount()); config={...options}; root=createRoot(document.getElementById('fixture-root')); flushSync(()=>root.render(<App/>));},
      change(options){Object.assign(config,options); flushSync(()=>root.render(<App/>));},
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
      export const answerSessionRequest=(...args)=>window.fixtureApi.answer(...args);
      export const reconnectSession=(...args)=>window.fixtureApi.reconnect(...args);
      export const interruptSession=(...args)=>window.fixtureApi.interrupt(...args);
      export const sendInput=(...args)=>window.fixtureApi.send(...args);
    ` }));
  } }],
});
const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
try {
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  p.on('pageerror', (error) => errors.push(error.message));
  await p.route('**/*', (route) => route.request().url() === 'https://reader.test/' ? route.fulfill({contentType:'text/html',body:'<div id="fixture-root" style="display:flex;position:absolute;inset:10px"></div>'}) : route.abort());
  await p.goto('https://reader.test/');
  await p.addStyleTag({ path: bundle.replace(/\.js$/, '.css') });
  await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8') + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
  await p.addScriptTag({ path: bundle });
  await p.evaluate(() => window.fixture.mount({ id: 'new-session', behavior: 'no-trace' }));
  await p.getByText('Start the conversation.', { exact: true }).waitFor();
  await p.locator('.cxv-composer textarea').fill('First prompt from the reader');
  await p.locator('.cxv-composer textarea').press('Enter');
  await p.waitForFunction(() => window.sends.length === 1);
  assert.deepEqual(await p.evaluate(() => window.sends), [{ id: 'new-session', text: 'First prompt from the reader' }]);
  assert.equal(await p.evaluate(() => window.sockets.length), 0, 'reader never attaches or starts a PTY');

  // Lifecycle controls use the exact displayed turn and never retry or interrupt on close.
  for (const mode of ['reader','terminal']) {
    await p.evaluate(mode=>window.fixture.mount({id:'lifecycle-'+mode,shared:true,mode,turnId:'turn-'+mode}),mode);
    const before=await p.evaluate(()=>window.interrupts.length);
    await p.getByRole('button',{name:'Interrupt current turn',exact:true}).click();
    await p.getByText('Interruption requested…',{exact:true}).waitFor();
    assert.equal(await p.getByRole('button',{name:'Interrupt current turn',exact:true}).isDisabled(),true);
    assert.deepEqual(await p.evaluate(()=>window.interrupts.at(-1)),{id:'lifecycle-'+mode,turnId:'turn-'+mode});
    await p.getByRole('button',{name:'Close view',exact:true}).click();
    assert.equal(await p.evaluate(()=>window.interrupts.length),before+1);
    await p.evaluate(()=>window.fixture.change({turnId:'new-turn',rejectInterrupt:true}));
    await p.getByRole('button',{name:'Interrupt current turn',exact:true}).click();
    await p.getByRole('alert').filter({hasText:'That turn is no longer active'}).waitFor();
    await p.evaluate(()=>window.fixture.change({turnId:null}));
    assert.equal(await p.getByRole('button',{name:'Interrupt current turn',exact:true}).count(),0);
  }
  await p.evaluate(()=>window.fixture.mount({id:'legacy',turnId:'legacy-turn'}));
  assert.equal(await p.getByRole('button',{name:'Interrupt current turn',exact:true}).count(),0);
  await p.evaluate(()=>window.fixture.mount({id:'archived',shared:true,turnId:'still-active',archivedAt:'2026-10-10'}));
  assert.equal(await p.getByRole('button',{name:'Interrupt current turn',exact:true}).count(),0);
  // Reset socket observations: the following cases deliberately exercise Reader only.
  await p.evaluate(()=>{window.sockets=[];});

  // Reopening a saved task is an explicit separate action and carries the verified key.
  await p.evaluate(()=>window.fixture.mount({id:'recovery',shared:true,recoveryKey:'saved-settings',sharedBusy:true}));
  const recoverySends=await p.evaluate(()=>window.sharedSends.length);
  await p.getByRole('button',{name:'Reconnect task',exact:true}).click();
  await p.waitForFunction(()=>window.reconnections.length===1);
  assert.deepEqual(await p.evaluate(()=>window.reconnections[0]),{id:'recovery',recoveryKey:'saved-settings'});
  assert.equal(await p.getByRole('button',{name:'Reconnect task',exact:true}).isDisabled(),true);
  assert.equal(await p.evaluate(()=>window.sharedSends.length),recoverySends);
  await p.evaluate(()=>window.fixture.change({recoveryKey:'changed-settings',rejectReconnect:true}));
  await p.getByRole('button',{name:'Reconnect task',exact:true}).click();
  await p.getByRole('alert').filter({hasText:'Saved task changed'}).waitFor();
  await p.evaluate(()=>window.fixture.change({recoveryKey:null}));
  assert.equal(await p.getByRole('button',{name:'Reconnect task',exact:true}).count(),0);

  // Both kinds of shared binding can reply without creating a terminal.
  await p.setViewportSize({ width: 390, height: 844 });
  for (const flags of [{ shared: true }, { bound: true }]) {
    await p.evaluate((flags) => window.fixture.mount({ id: 'shared-' + JSON.stringify(flags), ...flags, mobile:true }), flags);
    await p.getByText('Question 1', { exact: true }).waitFor();
    await p.locator('.cxv-composer textarea').waitFor();
    assert.equal(await p.locator('.cxv-composer textarea').count(), 1);
    assert.equal(await p.locator('.cxv-composer textarea').getAttribute('autocorrect'),'on');
    assert.equal(await p.locator('.cxv-composer textarea').getAttribute('spellcheck'),'true');
    assert.equal(await p.getByRole('button', { name: 'Attach files' }).count(), 1);
    assert.equal(await p.locator('.term-fill, .xterm').count(), 0);
    assert.equal(await p.getByText('Connect live requests',{exact:true}).count(),0);
    assert.equal(await p.getByText('Live response',{exact:true}).count(),0);
    assert.equal(await p.evaluate(() => window.sockets.length), 0);
  }
  await p.evaluate(() => window.fixture.mount({id:'retry-shared',shared:true,failSharedSend:true}));
  await p.getByText('Question 1',{exact:true}).waitFor();
  await p.locator('.cxv-composer textarea').fill('Send directly to shared server');
  await p.getByTitle('Send', {exact:true}).click();
  await p.getByText('Delivery uncertain', {exact:true}).waitFor();
  assert.equal(await p.locator('.cxv-composer textarea').inputValue(),'Send directly to shared server');
  await p.getByTitle('Send', {exact:true}).click();
  await p.waitForFunction(()=>window.sharedSends.length===2);
  assert.equal(await p.evaluate(()=>window.sharedSends[0].text===window.sharedSends[1].text),true,'retry retains draft');
  await p.evaluate(()=>window.fixture.mount({id:'shared-approval',shared:true,sharedRequest:{key:'approval-1',kind:'permission',details:'printf fixture',choices:[{value:'accept',label:'Approve once'},{value:'decline',label:'Deny'}],terminalFallback:false}}));
  await p.getByText('printf fixture', {exact:true}).waitFor();
  assert.equal(await p.evaluate(()=>window.sharedAnswers.length),0,'never automatically approve');
  await p.getByRole('button',{name:'Approve once',exact:true}).click();
  await p.waitForFunction(()=>window.sharedAnswers.length===1);
  assert.deepEqual(await p.evaluate(()=>window.sharedAnswers[0].response),{decision:'accept'});
  await p.evaluate(()=>window.fixture.mount({id:'shared-question',shared:true,sharedRequest:{key:'question-1',kind:'question',details:'',questions:[{id:'choice',text:'Which fixture?',options:[{label:'First',description:'First fixture'}]}],choices:[],terminalFallback:false}}));
  await p.getByText('Which fixture?', {exact:true}).waitFor();
  await p.getByRole('button',{name:'First',exact:true}).click();
  await p.getByRole('button',{name:'Submit answers',exact:true}).click();
  await p.waitForFunction(()=>window.sharedAnswers.length===2);
  assert.deepEqual(await p.evaluate(()=>window.sharedAnswers[1].response),{answers:{choice:'First'}});
  assert.equal(await p.evaluate(()=>window.sockets.length),0,'Reader actions never attach a PTY');
  await p.setViewportSize({ width: 1000, height: 700 });
  // A hung leader cannot stop another pane, and it cannot hide the draft.
  await p.clock.install();
  await p.evaluate(() => window.fixture.mount({ id: 'hung', behavior: 'hang', group: true }));
  await p.getByText('Question 1', { exact: true }).waitFor();
  assert.equal(await p.locator('.cxv-composer textarea').count(), 2);
  await p.clock.runFor(12_100);
  await p.getByText(/transcript read timed out/).waitFor();
  assert.ok(await p.evaluate(() => window.reads.some((r) => r.id === 'hung' && r.aborted)), 'deadline abandons a request even if abort never settles it');
  await p.evaluate(() => window.fixture.change({ behavior: 'ready' }));
  await p.getByRole('button', { name: 'Retry now' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.cxv-welcome').length === 0);
  await p.clock.resume();

  await p.evaluate(() => window.fixture.mount({ id: 'long', count: 500, state: 'working' }));
  await p.getByText('Question 499', { exact: true }).waitFor();
  assert.equal(await p.locator('.cx-running').count(), 0, 'a screen-derived working state does not animate a completed transcript');
  assert.ok(await p.locator('[data-x]').count() < 60, '500 exchanges have a bounded rendered window');
  const heights = await p.locator('[data-x]').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  assert.ok(Math.max(...heights)-Math.min(...heights)>100, 'the fixture stresses measured rows, not uniform estimated heights');
  assert.equal(await p.locator('.term-fill, .xterm').count(), 0, 'there is no terminal behind the reader');
  await p.evaluate(() => window.fixture.change({ active: false }));
  await p.evaluate(() => window.fixture.change({ active: true }));
  assert.equal(await p.evaluate(() => window.sockets.length), 0, 'activating an existing reader cannot claim or resize a PTY');

  await p.getByRole('button', { name: 'Search this conversation', exact: true }).click();
  await p.locator('.cxv-search').fill('Question 123');
  await p.getByText('Question 123', { exact: true }).waitFor();
  assert.ok(await p.locator('mark.cx-hit').count() > 0);
  for (const [width, height, zoom] of [[1000,300,150],[390,844,100],[844,390,100]]) {
    await p.setViewportSize({ width, height });
    await p.evaluate((zoom) => window.fixture.change({ zoom }), zoom);
    await p.waitForTimeout(150);
    const geometry = await p.evaluate(() => {
      const host = document.querySelector('.term-host'), reader = document.querySelector('.pane-reader');
      host.scrollTop = 60;
      const h = host.getBoundingClientRect(), r = reader.getBoundingClientRect();
      return { scroll: host.scrollTop, delta: h.bottom-r.bottom, host: h.toJSON(), reader: r.toJSON(), bottomNode: document.elementFromPoint(h.left+20,h.bottom-3)?.className, covered: !!document.elementFromPoint(h.left+20,h.bottom-3)?.closest('.pane-reader') };
    });
    assert.equal(geometry.scroll, 0, 'reader host is not an independently scrollable overlay');
    assert.ok(Math.abs(geometry.delta) < 1 && geometry.covered, `reader covers the pane through resize, zoom and search: ${JSON.stringify(geometry)}`);
  }
  await p.locator('.cxv-search').fill('Question');
  await p.waitForFunction(() => document.querySelector('.cxv-hits')?.textContent.includes('500'));
  assert.ok(await p.locator('[data-x]').count() < 60, 'searching every exchange still has bounded DOM');
  await p.getByRole('button', { name: 'Next matching turn', exact: true }).click();
  await p.getByText('Question 1', { exact: true }).waitFor();
  await p.locator('.cxv-search').press('Escape');
  await p.getByRole('button', { name: /Latest|At latest/ }).click();
  await p.getByText('Question 499', { exact: true }).waitFor();
  const tailReads = await p.evaluate(() => window.reads.filter((r) => r.id === 'long' && r.req.at === 'tail').length);
  await p.evaluate(() => window.fixture.mount({ id: 'other', count: 2 }));
  await p.getByText('Question 1', { exact: true }).waitFor();
  await p.evaluate(() => window.fixture.mount({ id: 'long', count: 500 }));
  await p.getByText('Question 499', { exact: true }).waitFor();
  assert.equal(await p.evaluate(() => window.reads.filter((r) => r.id === 'long' && r.req.at === 'tail').length), tailReads, 'returning uses retained history and an incremental refresh');

  await p.setViewportSize({ width: 1000, height: 700 });
  await p.evaluate(() => window.fixture.mount({ id: 'anchored', count: 500, from: 200, incremental: true }));
  await p.getByText('Question 499', { exact: true }).waitFor();
  await p.evaluate(() => { const el=document.querySelector('.cxv-body'); el.scrollTop=el.scrollHeight*0.4; });
  await p.waitForTimeout(250);
  const anchor = () => p.evaluate(() => {
    const el=document.querySelector('.cxv-body'), top=el.getBoundingClientRect().top;
    const row=[...document.querySelectorAll('[data-x]')].find((node)=>node.getBoundingClientRect().bottom>top+4);
    return { key: row?.dataset.x, offset: row?.getBoundingClientRect().top-top };
  });
  const beforeAppend = await anchor();
  await p.evaluate(() => window.fixture.change({ count: 505 }));
  await p.getByRole('button', { name: 'Refresh transcript', exact: true }).click();
  await p.waitForTimeout(250);
  const afterAppend = await anchor();
  assert.equal(afterAppend.key, beforeAppend.key, 'an append does not move a manual reader');
  assert.ok(Math.abs(afterAppend.offset-beforeAppend.offset)<2, 'append preserves the pixel offset within the row');
  await p.getByRole('button', { name: 'Earlier', exact: true }).click();
  await p.waitForTimeout(250);
  const afterPrepend = await anchor();
  assert.equal(afterPrepend.key, beforeAppend.key, 'a prepend keeps the same keyed row');
  assert.ok(Math.abs(afterPrepend.offset-beforeAppend.offset)<2, 'prepend preserves the pixel offset within the row');
  await p.getByRole('button', { name: 'Search this conversation', exact: true }).click();
  await p.waitForTimeout(200);
  const beforeSearch = await anchor();
  await p.locator('.cxv-search').fill('Question 123');
  await p.getByText('Question 123', { exact: true }).waitFor();
  await p.locator('.cxv-search').fill('');
  await p.waitForTimeout(300);
  const afterSearch = await anchor();
  assert.equal(afterSearch.key, beforeSearch.key, 'clearing search restores the unfiltered reading position');
  assert.ok(Math.abs(afterSearch.offset-beforeSearch.offset)<2, 'clearing search preserves the offset within the original row');
  await p.locator('.cxv-search').press('Escape');
  await p.locator('.cxv-body').hover();
  await p.mouse.wheel(0, 120);
  await p.waitForTimeout(300);
  const beforeSwitch = await anchor();
  await p.evaluate(() => window.fixture.mount({ id: 'other', count: 2 }));
  await p.getByText('Question 1', { exact: true }).waitFor();
  await p.evaluate(() => window.fixture.mount({ id: 'anchored', count: 505, incremental: true }));
  await p.waitForTimeout(400);
  const afterSwitch = await anchor();
  assert.equal(afterSwitch.key, beforeSwitch.key, 'returning to a retained reader restores the manually read row');
  assert.ok(Math.abs(afterSwitch.offset-beforeSwitch.offset)<2, 'returning restores the manual pixel offset after measuring rows again');
  // `from` has to leave more history loaded than the reader now fetches by
  // itself: this case is about an explicit Earlier competing with a hung
  // refresh, and a first window smaller than the automatic recent-history
  // target would be filled to the beginning before the click, leaving nothing
  // earlier to page to and no Earlier button to click.
  await p.evaluate(() => window.fixture.mount({ id: 'paging-priority', count: 500, from: 400, hangAfter: true }));
  await p.getByText('Question 499', { exact: true }).waitFor();
  await p.getByRole('button', { name: 'Refresh transcript', exact: true }).click();
  await p.waitForFunction(() => window.reads.some((r) => r.id === 'paging-priority' && r.req.at === 'after'));
  assert.ok(await p.getByRole('button', { name: 'Earlier', exact: true }).isEnabled(), 'background refresh does not disable backward paging');
  await p.getByRole('button', { name: 'Earlier', exact: true }).click();
  await p.getByText('500 turns loaded', { exact: true }).waitFor();
  assert.ok(await p.evaluate(() => window.reads.some((r) => r.id === 'paging-priority' && r.req.at === 'after' && r.aborted)), 'the explicit page takes priority over a hung refresh');
  await p.evaluate(() => window.fixture.mount({ id: 'stale-working', activity: 'working' }));
  await p.locator('.cx-running').waitFor();
  await p.evaluate(() => window.fixture.mount({ id: 'other', count: 2 }));
  await p.evaluate(() => window.fixture.mount({ id: 'stale-working', activity: 'waiting', hangAfter: true }));
  await p.waitForFunction(() => window.reads.some((r) => r.id === 'stale-working' && r.req.at === 'after'));
  assert.equal(await p.locator('.cx-running').count(), 0, 'a hung warm refresh cannot animate retained working state');
  await p.evaluate(() => window.fixture.mount({ id: 'child-parent', child: true }));
  await p.getByTitle('Show the work', { exact: true }).click();
  await p.getByTitle('Show the task and what it did', { exact: true }).click();
  await p.getByText('Task: inspect the fixture', { exact: true }).waitFor();
  await p.waitForTimeout(200);
  assert.equal(await p.locator('.ca-reader').evaluate((el) => el.scrollTop), 0, 'child opens at the task, not at the bottom of its transcript');
  assert.ok(await p.evaluate(() => window.reads.some((r) => r.id === 'child' && r.req.at === 'tail' && r.bytes === 2*1024*1024)), 'child first reads use the bounded context window');
  await p.locator('.ca-reader').getByRole('button', { name: 'Latest', exact: true }).click();
  assert.ok(await p.locator('.ca-reader').evaluate((el) => el.scrollTop>0), 'following the child tail is an explicit choice');
  await p.evaluate(() => window.fixture.mount({ id: 'large-child-parent', child: true, childEarlier: true }));
  await p.getByTitle('Show the work', { exact: true }).click();
  await p.getByTitle('Show the task and what it did', { exact: true }).click();
  await p.getByText('Earlier history isn’t loaded; the task may be there.', { exact: true }).waitFor();
  await p.locator('.ca-reader').getByRole('button', { name: 'Load earlier', exact: true }).click();
  await p.waitForFunction(() => document.querySelector('.ca-reader > .ca-msg')?.textContent.startsWith('100 turns loaded'));
  await p.waitForTimeout(200);
  await p.locator('.ca-reader').evaluate((el) => { el.scrollTop = 0; });
  await p.getByText('Task: inspect the fixture', { exact: true }).waitFor();
  // Upgrade refusals must settle, and changing modes must not destroy a draft.
  await p.evaluate(() => window.fixture.mount({ id: 'admission-refusal', behavior: 'no-trace' }));
  await p.getByText('Start the conversation.', { exact: true }).waitFor();
  await p.locator('.cxv-composer textarea').fill('Retain this unsent draft');
  const socketCount = await p.evaluate(() => window.sockets.length);
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await p.evaluate(() => { window.refuseSockets = true; window.fixture.change({ mode: 'terminal' }); });
  await p.clock.runFor(30_000);
  await p.getByRole('button', { name: 'retry connection', exact: true }).waitFor();
  assert.equal(await p.evaluate(() => window.sockets.length), socketCount + 5, 'refused upgrades have a finite retry budget');
  await p.clock.runFor(60_000);
  assert.equal(await p.evaluate(() => window.sockets.length), socketCount + 5, 'a paused terminal does not reconnect indefinitely');
  await p.getByRole('button', { name: 'retry connection', exact: true }).click();
  assert.equal(await p.evaluate(() => window.sockets.length), socketCount + 6, 'retry is an explicit operator action');
  await p.evaluate(() => window.fixture.change({ mode: 'reader' }));
  assert.equal(await p.locator('.cxv-composer textarea').inputValue(), 'Retain this unsent draft');
  await p.clock.resume();
  assert.deepEqual(errors, []);
  if (process.env.AM_READER_SCREENSHOT) await p.screenshot({ path: process.env.AM_READER_SCREENSHOT });
  console.log('reader-redesign: first prompt, independent loading, timeout/retry, no PTY, bounded DOM/search, layout and retained history passed');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
