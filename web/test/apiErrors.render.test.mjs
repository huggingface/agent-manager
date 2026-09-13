// Real controls and real fetch/XHR over local HTTP; all backend data is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-api-controls-'));
const bundle = path.join(root, 'fixture.js');
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
  import Sidebar from './src/components/Sidebar'; import ShareDialog from './src/components/ShareDialog';
  import TerminalPane from './src/components/TerminalPane'; import FilesPane from './src/components/FilesPane';
  import * as api from './src/api';
  const cli={id:'claude',label:'Fixture',available:true,ready:true,color:'#777'};
  const session={id:'one',cli:'claude',name:'Fixture',state:'stopped',running:false,everStarted:false,path:'.',createdAt:new Date().toISOString()};
  class FakeSocket { static OPEN=1; readyState=1; send(){} close(){this.readyState=3;} } window.WebSocket=FakeSocket;
  const noop=()=>{}; window.api=api; let root;
  window.mount=(mode)=>{
    if(root)flushSync(()=>root.unmount()); root=createRoot(document.getElementById('root'));
    flushSync(()=>root.render(mode==='share'?<ShareDialog session={session} onClose={noop}/>
      :mode==='reader'?<div style={{height:650,display:'flex'}}><TerminalPane session={session} cli={cli} mode="reader" theme="light" zoom={100} focused active visible onClose={noop}/></div>
      :mode==='file'?<FilesPane session={session} zoom={100} focused onClose={noop}/>
      :<Sidebar clis={[cli]} tree={{sessions:[],groups:[],order:[]}} activeRef={null} focusedId={null} defaultPath="."
        onActivate={noop} onOpenSession={noop} onOpenSettings={noop} onNewSession={noop}
        onNewGroup={async(name)=>{await api.createGroup(name);}} onRenameGroup={noop} onRenameSession={noop} onDeleteGroup={noop}
        onArchiveSession={noop} onUnarchiveSession={noop} onSetRemotePaused={noop} onDeleteSession={noop}
        onTraceHandover={async()=>({path:'.'})} handoverFor={null} onHandoverHandled={noop} onMove={noop}
        theme="light" onToggleTheme={noop} onQuickStart={async(cli,prompt,name)=>{await api.quickStart(cli,prompt,name);}}
        onPrepareQuickStart={async()=>session} onAbandonQuickStart={async()=>{}}
        archived={new Set()} retired={new Set()} showArchived={false} onToggleArchived={noop} overviewHidden={new Set()} onToggleOverviewHidden={noop}/>));
  };
` }, outfile: bundle, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
let mutations = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const send = (status, body) => { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(bundle)); }
    else if (url.pathname === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(fs.readFileSync('src/styles.css')); }
    else res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    return;
  }
  if (req.method !== 'GET') mutations++;
  if (url.pathname.endsWith('/attachments')) {
    req.resume();
    req.once('end', () => {
      if (url.pathname.includes('/large/')) send(413, { error: 'File is too large.', code: 'payload-too-large' });
      else if (url.pathname.includes('/bad/')) { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>private proxy details</html>'); }
      else if (url.pathname.includes('/slow/')) { const timer = setTimeout(() => send(201, { id: 'attachment' }), 3000); res.once('close', () => clearTimeout(timer)); }
      else send(201, { id: 'attachment', name: 'fixture.txt', bytes: 10, kind: 'file', mime: 'text/plain', insertText: 'fixture' });
    }); return;
  }
  req.resume();
  if (req.method === 'POST' && url.pathname === '/api/groups') return send(400, { error: 'name: choose a different group name', code: 'invalid-input' });
  if (req.method === 'POST' && url.pathname === '/api/sessions') return send(400, { error: 'name: choose a different session name', code: 'invalid-input' });
  if (url.pathname.endsWith('/share')) return req.method === 'GET'
    ? send(200, { canShare: true, namespace: 'fixture', reason: null, lastShare: null })
    : send(409, { error: 'Refused by redaction', code: 'redaction-blocked', hits: { fixture_rule: 2 } });
  if (url.pathname.endsWith('/input')) return send(429, { error: 'Wait a moment before sending again.', code: 'rate-limited', retryAfter: 60 });
  if (url.pathname.endsWith('/preview')) return send(200, { kind: 'text', name: 'fixture.txt', mime: 'text/plain', size: 8, mtime: 1, tag: 'old', text: 'original' });
  if (url.pathname === '/api/files/one') return send(200, { root: 'fixture', path: '', entries: [{ name: 'fixture.txt', dir: false, size: 8, mtime: 1, kind: 'text' }] });
  if (url.pathname.endsWith('/write')) return send(409, { error: 'changed on disk since you opened it', code: 'file-changed', mtime: 2, tag: 'new' });
  if (url.pathname.startsWith('/api/trace/')) return send(404, { error: 'No trace yet', code: 'no-trace' });
  if (url.pathname.endsWith('/subagents')) return send(200, { agents: [], supported: true });
  if (url.pathname === '/api/next-name') return send(200, { name: 'fixture' });
  if (url.pathname === '/api/folders') return send(200, { path: '', folders: [] });
  send(200, {});
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => window.mount('sidebar'));
  await page.getByTitle('New agent or group').click();
  await page.getByTitle('Group — several agents created together, sharing a folder').click();
  await page.getByPlaceholder('Group name').fill('group draft');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'choose a different group name' }).waitFor();
  assert.equal(await page.getByPlaceholder('Group name').inputValue(), 'group draft');
  await page.locator('.quick-clis .quick-cli').first().click();
  const quickPrompt = page.locator('.quick textarea').first();
  await quickPrompt.fill('session prompt draft');
  await page.locator('input.quick-name').fill('session name draft');
  await page.getByRole('button', { name: 'Create & send', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'choose a different session name' }).waitFor();
  assert.equal(await quickPrompt.inputValue(), 'session prompt draft');
  assert.equal(await page.locator('input.quick-name').inputValue(), 'session name draft');
  await page.evaluate(() => window.mount('share'));
  await page.getByPlaceholder('alice, bob').fill('fixture-recipient');
  await page.getByRole('button', { name: 'Public', exact: true }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('Not published.', { exact: true }).waitFor();
  assert.match(await page.locator('.share-blocked').innerText(), /fixture_rule × 2/);
  await page.getByRole('button', { name: 'Private', exact: true }).click();
  assert.equal(await page.getByPlaceholder('alice, bob').inputValue(), 'fixture-recipient');
  await page.getByRole('link', { name: 'Download transcript' }).waitFor();
  await page.evaluate(() => window.mount('reader'));
  const composer = page.locator('.cxv-composer textarea').first();
  await composer.fill('reader draft');
  await composer.press('Enter');
  await page.getByText('Wait a moment before sending again.', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'reader draft');
  await page.evaluate(() => window.mount('file'));
  await page.getByText('fixture.txt', { exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('unsaved file draft');
  await page.keyboard.press('ControlOrMeta+S');
  await page.getByRole('button', { name: 'Reload', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Overwrite', exact: true }).waitFor();
  assert.equal(await editor.innerText(), 'unsaved file draft');
  const before = mutations;
  const upload = await page.evaluate(async () => {
    const file = new File(['x'.repeat(2 * 1024 * 1024)], 'fixture.txt', { type: 'text/plain' });
    const progress = [];
    const success = await window.api.uploadAttachment('one', file, { onProgress: (p) => progress.push(p.loaded) });
    const failures = [];
    for (const id of ['large', 'bad']) {
      try { await window.api.uploadAttachment(id, file); }
      catch (e) { failures.push({ status: e.status, code: e.code, message: e.message }); }
    }
    const ac = new AbortController();
    const canceled = window.api.uploadAttachment('slow', file, { signal: ac.signal }); setTimeout(() => ac.abort(), 30);
    try { await canceled; } catch (e) { failures.push({ code: e.code }); }
    try { await window.api.uploadAttachment('slow', file, { timeoutMs: 30 }); } catch (e) { failures.push({ code: e.code }); }
    const early = new AbortController();
    try { await window.api.uploadAttachment('one', file, { signal: early.signal, onProgress: () => early.abort() }); } catch (e) { failures.push({ code: e.code }); }
    return { success, progress, failures };
  });
  assert.equal(upload.success.id, 'attachment'); assert.ok(upload.progress.some((n) => n > 0));
  assert.equal(upload.failures[0].status, 413); assert.equal(upload.failures[1].status, 502); assert.ok(!upload.failures[1].message.includes('private'));
  assert.deepEqual(upload.failures.slice(2).map((e) => e.code), ['canceled', 'timeout', 'canceled']);
  assert.equal(mutations - before, 5, 'no mutation replay; canceled-before-send upload never starts');
  assert.deepEqual(errors, []);
  console.log('Actual controls retain drafts, show domain errors, keep reader composer and XHR progress/cancel/timeout');
} finally { await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
