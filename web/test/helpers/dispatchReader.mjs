// The real TerminalPane in reader mode over a synthetic conversation in which
// every turn launches two sessions from one Bash call — the fixture the
// dispatched-session preview tests share (dispatchPreview*.test.mjs).
// Never starts an agent, never opens a real socket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-preview-'));
const bundle = path.join(tmp, 'fixture.js');
export async function buildFixture() {
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import TerminalPane from './src/components/TerminalPane';
    class FakeSocket { static OPEN = 1; constructor(){ this.readyState = 0; } send(){} close(){ this.readyState = 3; } }
    window.WebSocket = FakeSocket;
    const T0 = 1759165000000;
    const COUNT = 30;
    const empty = { harness:'claude',harnessLabel:'Fixture',sessionId:'s',title:'',model:null,cwd:null,
      firstTs:0,lastTs:0,usage:null,source:null,sharedBy:null,note:null,truncated:false,total:null,
      userTurns:null,activity:'waiting',generation:'g',revision:'r1' };
    const page = (turns) => ({ ...empty, turns, window:{mode:'bytes',start:0,end:turns.length,atStart:true,atEnd:true,generation:'g',revision:'r1'} });
    // Every turn launches two sessions from one Bash call. The LAST turn's
    // answer is one line, so its icons sit near the bottom of the viewport —
    // where a card below them cannot fit.
    const ts = (i, k) => T0 + i * 60000 + k * 1000;
    const records = Array.from({length: COUNT}, (_, i) => [
      {id:'u'+i,role:'user',ts:ts(i,0),blocks:[{type:'text',text:'Launch the workers for step '+i}]},
      {id:'c'+i,role:'assistant',ts:ts(i,1),blocks:[{type:'tool_use',name:'Bash',text:'curl -X POST "$AM/api/agents?name=w'+i+'&from=$AM_ID"'},{type:'tool_result',text:'{"id":"w"}'}]},
      {id:'a'+i,role:'assistant',ts:ts(i,2),kind:'final',blocks:[{type:'text',text: i === COUNT - 1 ? 'Both are running.'
        : 'Step '+i+' is out.\\n\\n'+Array.from({length: 8 + (i*7)%20},(_,k)=>'line '+k+' of answer '+i).join('\\n')}]},
    ]).flat();
    const longAnswer = Array.from({length: 14}, (_, k) => '- finding ' + k + ': the change is correct and the tests cover it').join('\\n');
    const dispatches = Array.from({length: COUNT}, (_, i) => [0, 1].map((k) => ({
      id: 'd'+i+'-'+k, at: ts(i,1) + 300, kind: 'launch', status: 201, ok: true,
      prompt: 'Review part '+k+' of step '+i+'. Report anything that would break in production.',
      target: { id: 'peer-'+i+'-'+k, name: 'reviewer-'+i+'-'+k, cli: 'claude', color: '#d97757', exists: true, state: 'waiting' },
      exchange: { ended: true, truncated: false, turns: [
        {role:'user',ts:ts(i,1)+900,blocks:[{type:'text',text:'Review part '+k}]},
        {role:'assistant',ts:ts(i,1)+5000,blocks:[{type:'tool_use',name:'Read',text:''},{type:'tool_result',text:''}],usage:{in:900,out:50}},
        {role:'assistant',ts:ts(i,1)+9000,kind:'final',blocks:[{type:'text',text:'**Verdict: ready.**\\n\\n'+longAnswer}],usage:{in:1200,out:300}},
      ] },
    }))).flat();
    window.fixtureApi = {
      window: () => Promise.resolve(page(records)),
      summary: () => Promise.resolve({ ...page([]), total: records.length, userTurns: [] }),
      dispatches: () => Promise.resolve({ id: 'boss', dispatches }),
    };
    let root;
    window.fixture = { mount() {
      root = createRoot(document.getElementById('fixture-root'));
      flushSync(() => root.render(<div className="tile" style={{position:'relative',flex:1,minWidth:0}}><TerminalPane
        session={{id:'boss',cli:'claude',name:'boss',state:'waiting',running:false,everStarted:true,path:null,createdAt:new Date().toISOString()}}
        cli={{id:'claude',label:'Fixture',color:'#777'}} mode="reader" theme="light" zoom={100}
        focused active visible onClose={()=>{}} /></div>));
    } };
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.?(?:\/\.\.)*\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: web, loader: 'ts', contents: `
      export * from ${JSON.stringify(path.join(web, 'src/api.ts'))};
      export const getTraceWindow=(...a)=>window.fixtureApi.window(...a);
      export const getTraceSummary=()=>window.fixtureApi.summary();
      export const getSubAgents=()=>Promise.resolve({agents:[]});
      export const getDispatches=()=>window.fixtureApi.dispatches();
      export const sendInput=()=>Promise.resolve({});
    ` }));
  } }],
});
return bundle;
}

/** A page with the fixture mounted in a pane `paneHeight` px tall (default: the window). */
export async function mountReader(browser, { width, height, touch = false, paneHeight = null }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const inset = paneHeight ? `top:10px;left:10px;right:10px;height:${paneHeight}px` : 'inset:10px';
  await p.route('**/*', (route) => route.request().url() === 'http://fixture.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="fixture-root" style="display:flex;position:absolute;${inset}"></div>` })
    : route.abort());
  await p.goto('http://fixture.test/');
  if (fs.existsSync(bundle.replace(/\.js$/, '.css'))) await p.addStyleTag({ path: bundle.replace(/\.js$/, '.css') });
  await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
    + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
  await p.addScriptTag({ path: bundle });
  await p.evaluate(() => window.fixture.mount());
  await p.waitForSelector('.cxv-body');
  await p.waitForSelector('.dx-icon', { timeout: 20_000 });
  await p.waitForFunction(() => {
    const e = document.querySelector('.cxv-body');
    return e.scrollHeight > e.clientHeight && Math.abs(e.scrollHeight - e.scrollTop - e.clientHeight) < 2;
  }, null, { timeout: 20_000 });
  await p.waitForTimeout(600);
  return { context, p, errors };
}
