// Real pane-scoped reader/xterm clicks, plus the explicit retained Files pane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-preview-'));
const bundle = path.join(tmp, 'fixture.js');
await build({ stdin: { resolveDir: web, loader: 'tsx', contents: `
  import React, { useEffect, useRef, useState } from 'react'; import { createRoot } from 'react-dom/client';
  import PaneFilePreview from './src/components/PaneFilePreview';
  import Manager from './src/App';
  import FileLinkContent, { FileLinkScope, useFilePreview } from './src/components/FileLinkContent';
  import FilesPane from './src/components/FilesPane';
  import { retainFileViewer } from './src/lib/fileViewer';
  import { recall, remember } from './src/components/filesMemory';
  import { renderMarkdown } from './src/lib/markdown';
  import { Terminal } from '@xterm/xterm'; import { WebLinksAddon } from '@xterm/addon-web-links';
  import { installTerminalFileLinks, terminalLinkHandler, openTerminalLink } from './src/lib/terminalFileLinks';
  import '@xterm/xterm/css/xterm.css';
  window.recall = recall;
  function Source() {
    const open = useFilePreview(), host=useRef(null);
    useEffect(()=>{
      window.mounts=(window.mounts||0)+1;
      const term=new Terminal({cols:60,rows:5,fontSize:14,linkHandler:terminalLinkHandler('team',open)});
      term.loadAddon(new WebLinksAddon((event,text)=>openTerminalLink(event,text,'team',open)));
      term.open(host.current); installTerminalFileLinks(term,'team',open);
      term.write('code.ts:42:3\\r\\nhttps://example.test/terminal\\r\\n\\x1b]8;;file:///data/workspaces/team/readme.md\\x1b\\\\open readme\\x1b]8;;\\x1b\\\\');
      window.term=term; return ()=>term.dispose();
    },[open]);
    return <div className="slot">
      <header className="pane-head">Research session</header>
      <div id="conversation" style={{overflow:'auto',flex:1,padding:16}}>
        <div style={{height:300}}>Earlier conversation</div>
        <FileLinkScope session="team"><FileLinkContent html={renderMarkdown('[Readme](./readme.md) · [Code](./code.ts:42:3) · [Missing](./missing.md) · [Website](https://example.test/reader)')}/></FileLinkScope>
        <textarea aria-label="Draft" defaultValue="Keep this draft"/>
        <div style={{height:700}}>Later conversation</div>
      </div>
      <div ref={host}/>
    </div>;
  }
  function App() {
    const [pane,setPane]=useState(()=>JSON.parse(localStorage.getItem('fixture-pane')||'null'));
    const [shown,setShown]=useState(!!pane);
    const [fail,setFail]=useState(false);
    window.failKeep=()=>setFail(true);
    return <div style={{display:'flex',height:'100%',gap:12,padding:12}}>
      <div className="tile" style={{width:'100%',maxWidth:700}}><PaneFilePreview onOpenInViewer={async (request)=>{
        if(fail){setFail(false);throw new Error('Viewer unavailable — retry');}
        const next=await retainFileViewer(request,pane?[pane]:[],'group-1');
        setPane(next);setShown(true);localStorage.setItem('fixture-pane',JSON.stringify(next));
      }}><Source/></PaneFilePreview></div>
      <aside style={{display:'flex',flexDirection:'column',width:500,minWidth:0}}>
        <button onClick={()=>setShown(!shown)}>Toggle retained viewer</button>
        <button id="neighbor">Other session</button>
        {shown&&pane&&<FilesPane session={pane} onClose={()=>setShown(false)}/>}
      </aside>
    </div>;
  }
  createRoot(document.getElementById('root')).render(location.search.includes('manager') ? <Manager/> : <App/>);
` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const css = ['styles.css', 'conversation.css'].map((name) => fs.readFileSync(path.join(web, 'src', name), 'utf8')).join('\n');
const calls = [];
const managerTree = { order: ['g:group-1'], hidden: [],
  groups: [{ id: 'group-1', name: 'Research', sessionIds: ['team'], layout: { cols: 1, rows: 1 } }],
  sessions: [{ id: 'team', name: 'Research session', cli: 'remote', path: 'team', state: 'waiting', running: false,
    createdAt: new Date().toISOString(), remote: { name: 'research', paused: false } }],
};
const files = {
  'team/readme.md': { kind: 'markdown', text: '# Readme preview\n\n[Next](next.md)\n\n![Picture](pixel.svg)' },
  'team/next.md': { kind: 'markdown', text: '# Nested document' },
  'team/code.ts': { kind: 'text', text: Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') },
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(bundle)); }
  if (url.pathname === '/fixture.css') { res.setHeader('content-type', 'text/css'); return res.end(css + fs.readFileSync(bundle.replace('.js', '.css'))); }
  if (url.pathname.startsWith('/api/')) {
    const call = { method: req.method, path: url.pathname }; calls.push(call);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/tree') return res.end(JSON.stringify(managerTree));
    if (url.pathname === '/api/clis') return res.end(JSON.stringify([{id:'remote',label:'Remote',available:true,ready:true},{id:'files',label:'Files',available:true,ready:true}]));
    if (url.pathname === '/api/info') return res.end(JSON.stringify({locked:false,welcomeSeen:true}));
    if (url.pathname === '/api/config') return res.end(JSON.stringify({archive:{after:'never'}}));
    if (url.pathname === '/api/meta') return res.end(JSON.stringify({sessions:[]}));
    if (url.pathname.endsWith('/remote')) return res.end(JSON.stringify({connected:true,name:'research',paused:false,peer:null,state:'waiting',seq:1,deliveredThrough:1,
      messages:[{seq:1,role:'agent',ts:Date.now(),text:'[Readme](./readme.md)'}]}));
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      let body='';req.on('data',(part)=>body+=part);req.on('end',()=>{
        call.body=JSON.parse(body);
        const created={id:'retained',...call.body,state:'idle',running:false,createdAt:new Date().toISOString()};
        managerTree.sessions.push(created);managerTree.groups[0].sessionIds.push(created.id);
        res.end(JSON.stringify(created));
      }); return;
    }
    let file=url.searchParams.get('file')||'';
    if(file.startsWith('/data/workspaces/'))file=file.slice('/data/workspaces/'.length);
    else if(!url.searchParams.has('root'))file='team/'+file;
    file=path.posix.normalize(file);
    if(url.pathname.endsWith('/raw')&&file==='team/pixel.svg'){
      res.setHeader('content-type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
    }
    const entry=files[file];
    if(!entry){res.statusCode=404;return res.end(JSON.stringify({error:'File not found.'}));}
    if(url.pathname.endsWith('/resolve'))return res.end(JSON.stringify({root:'workspace',path:file,absolute:'/data/workspaces/'+file}));
    return res.end(JSON.stringify({...entry,path:file,name:path.basename(file),size:entry.text.length,mtime:1}));
  }
  res.setHeader('content-type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
});
server.listen(0,'127.0.0.1');await new Promise((resolve)=>server.once('listening',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch(chromiumLaunchOptions());
const context=await browser.newContext({viewport:{width:1200,height:800}});
context.setDefaultTimeout(10_000);
await context.route('https://example.test/**',(route)=>route.fulfill({body:'External destination'}));
const errors=[];context.on('page',(page)=>page.on('pageerror',(error)=>errors.push(error.message)));
const page=await context.newPage();
try {
  await page.goto(origin);
  const original=page.url(), title=await page.title();
  const reader=page.locator('#conversation'), dialog=page.getByRole('dialog',{name:'File preview'});
  await reader.getByRole('link',{name:'Readme',exact:true}).scrollIntoViewIfNeeded();
  const scroll=await reader.evaluate((el)=>el.scrollTop);
  const openReadme=async()=>{await reader.getByRole('link',{name:'Readme',exact:true}).click();await dialog.getByRole('heading',{name:'Readme preview'}).waitFor();};
  await openReadme();
  assert.equal(context.pages().length,1);assert.equal(page.url(),original);assert.equal(await page.title(),title);
  assert.equal(await page.evaluate(()=>window.mounts),1);
  assert.equal(await page.locator('.pane-file-session').evaluate((el)=>el.inert),true);
  assert.equal(await page.locator('.xterm').count(),1,'original terminal stays mounted');
  await page.locator('#neighbor').click(); // other tiles are not blocked
  await dialog.getByRole('link',{name:'Next',exact:true}).click();
  await dialog.getByRole('heading',{name:'Nested document'}).waitFor();
  await dialog.getByRole('button',{name:'Back',exact:true}).click();
  await dialog.getByRole('heading',{name:'Readme preview'}).waitFor();
  if(process.env.FILE_LINK_SHOTS){fs.mkdirSync(process.env.FILE_LINK_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.FILE_LINK_SHOTS,'session-preview-desktop.png')});}
  await dialog.getByRole('button',{name:'Close preview',exact:true}).click();
  assert.equal(await reader.evaluate((el)=>el.scrollTop),scroll);
  assert.equal(await reader.getByRole('textbox',{name:'Draft'}).inputValue(),'Keep this draft');
  assert.equal(await page.locator('.pane-file-session').evaluate((el)=>el.inert),false);
  assert.equal(await reader.getByRole('link',{name:'Readme',exact:true}).evaluate((el)=>el===document.activeElement),true,'focus returns to source');
  const clickCell=async(row)=>{
    const box=await page.locator('.xterm-screen').boundingBox();
    await page.mouse.move(box.x+3.5*box.width/60,box.y+(row+.5)*box.height/5);
    await page.waitForTimeout(100);await page.mouse.down();await page.mouse.up();
  };
  await clickCell(0);await dialog.locator('.cm-activeLine').filter({hasText:'const line42'}).waitFor();
  assert.equal(await dialog.locator('.cm-content').getAttribute('contenteditable'),'false');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await clickCell(2);await dialog.getByRole('heading',{name:'Readme preview'}).waitFor();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  for(const action of [()=>clickCell(1),()=>reader.getByRole('link',{name:'Website'}).click()]){
    const next=context.waitForEvent('page');await action();const tab=await next;await tab.waitForLoadState();
    assert.equal(await tab.evaluate(()=>window.opener),null);await tab.close();assert.equal(page.url(),original);
  }
  await reader.getByRole('link',{name:'Missing'}).click();await dialog.getByRole('alert').filter({hasText:'File not found'}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Open in file viewer'}).isDisabled(),true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.ok(calls.every((call)=>call.method==='GET'),'transient previews make no writes');
  await openReadme();await page.evaluate(()=>window.failKeep());
  await dialog.getByRole('button',{name:'Open in file viewer'}).click();await dialog.getByRole('alert').filter({hasText:'Viewer unavailable'}).waitFor();
  await dialog.getByRole('button',{name:'Open in file viewer'}).click();await dialog.waitFor({state:'hidden'});
  await page.locator('aside').getByRole('heading',{name:'Readme preview'}).waitFor();
  assert.deepEqual(calls.filter((call)=>call.method==='POST').map((call)=>call.body),[{name:'File: readme.md',cli:'files',groupId:'group-1',path:'.'}]);
  assert.equal(context.pages().length,1);assert.equal(await page.evaluate(()=>window.mounts),1);
  await page.getByRole('button',{name:'Toggle retained viewer'}).click();await page.getByRole('button',{name:'Toggle retained viewer'}).click();
  await page.locator('aside').getByRole('heading',{name:'Readme preview'}).waitFor();
  await page.reload();await page.locator('aside').getByRole('heading',{name:'Readme preview'}).waitFor();
  await openReadme();await dialog.getByRole('button',{name:'Open in file viewer'}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(calls.filter((call)=>call.method==='POST').length,1,'same retained file reuses its pane');
  await page.setViewportSize({width:390,height:844});await page.locator('aside').evaluate((el)=>el.style.display='none');
  await openReadme();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await dialog.getByRole('button',{name:'Open in file viewer'}).isVisible(),true);
  if(process.env.FILE_LINK_SHOTS)await page.screenshot({path:path.join(process.env.FILE_LINK_SHOTS,'session-preview-mobile.png')});
  // Exercise the actual App wrappers/navigation too. Fixed 1x1 groups must
  // reveal the newly appended viewer on page 2, not leave it off screen.
  const app = await context.newPage();
  await app.goto(origin);await app.evaluate(()=>{
    localStorage.clear();localStorage.setItem('am-active-ref','g:group-1');localStorage.setItem('am-focused-id','team');
  });
  managerTree.sessions=managerTree.sessions.slice(0,1);managerTree.groups[0].sessionIds=['team'];
  await app.goto(origin+'/?manager');
  await app.locator('.rp-agent').getByRole('link',{name:'Readme'}).click();
  await app.getByRole('dialog').getByRole('heading',{name:'Readme preview'}).waitFor();
  assert.equal(await app.locator('.rp-agent').count(),1,'actual session remains mounted behind the preview');
  await app.getByRole('dialog').getByRole('button',{name:'Open in file viewer'}).click();
  await app.getByRole('dialog').waitFor({state:'hidden'});
  await app.locator('.tile .file-link-page').getByRole('heading',{name:'Readme preview'}).waitFor();
  assert.equal(await app.getByRole('dialog').count(),0);
  assert.equal(await app.locator('.rp-agent').count(),0,'group pager selects the new Files pane');
  assert.equal(await app.evaluate(()=>localStorage.getItem('am-focused-id')),'retained');
  if(process.env.FILE_LINK_SHOTS)await app.screenshot({path:path.join(process.env.FILE_LINK_SHOTS,'app-retained-viewer.png')});
  await app.close();
  assert.deepEqual(errors,[]);
  console.log('session-file-preview: in-pane reader + terminal/OSC8, back/close, source state, retained viewer/reload/reuse, external tabs, errors and mobile passed');
} finally {await browser.close();await new Promise((resolve)=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
