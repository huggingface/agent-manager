// Real TerminalPane + xterm; only the websocket transport is fake. No agents start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import TerminalPane from './src/components/TerminalPane';
    window.sent=[];
    class Socket {
      static OPEN=1; readyState=1;
      constructor(){window.socket=this;setTimeout(()=>{this.onopen?.();this.grid(true);this.onmessage?.({data:'\\x1b[?2004hReady> '});},20);}
      send(data){window.sent.push(JSON.parse(data));}
      grid(controller){this.onmessage?.({data:'\\x00\\x00AM:'+JSON.stringify({t:'grid',cols:40,rows:12,controller})});}
      close(){this.readyState=3;}
    }
    window.WebSocket=Socket;
    createRoot(document.getElementById('root')).render(<TerminalPane
      session={{id:'keyboard',cli:'shell',name:'Keyboard fixture',state:'idle',running:true,everStarted:true,path:null}}
      mode="terminal" theme="light" zoom={100} isMobile focused active visible onClose={()=>{}}/>);
  ` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const css = ['src/styles.css', 'src/conversation.css', 'node_modules/@xterm/xterm/css/xterm.css']
    .map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');
  await page.route('http://keyboard.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<style>${css}\n#root{height:100vh}.slot{height:100%}</style><div id="root"></div>` }));
  await page.goto('http://keyboard.test/');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByRole('button', { name: 'write', exact: true }).click();
  const input = page.getByPlaceholder('write a prompt…');
  await input.fill('a corrected prompt');
  assert.equal(await input.getAttribute('autocorrect'), 'on');
  assert.equal(await page.locator('.xterm-helper-textarea').getAttribute('autocorrect'), 'off', 'raw input remains literal');
  const inputs = () => page.evaluate(() => window.sent.filter((m) => m.t === 'i').map((m) => m.d));
  assert.deepEqual(await inputs(), [], 'draft typing does not reach the transport');
  await page.getByRole('button', { name: 'Paste draft into terminal', exact: true }).click();
  assert.deepEqual(await inputs(), ['\x1b[200~a corrected prompt\x1b[201~'], 'xterm bracketed paste, no appended Enter');
  await page.getByRole('button', { name: 'write', exact: true }).click();
  await input.fill('keep this draft');
  await page.evaluate(() => window.socket.grid(false));
  await page.waitForFunction(() => document.querySelector('button[title="Paste draft into terminal"]')?.disabled);
  assert.equal(await page.getByRole('button', { name: 'Paste draft into terminal', exact: true }).isDisabled(), true);
  assert.equal(await input.inputValue(), 'keep this draft', 'loss of control preserves text');
  assert.equal((await inputs()).length, 1);
  await page.getByRole('button', { name: 'Close terminal draft' }).click();
  await page.getByRole('button', { name: 'write', exact: true }).click();
  assert.equal(await input.inputValue(), 'keep this draft', 'closing and reopening preserves text');
  console.log('mobile-terminal-draft: real xterm paste framing, no keystroke streaming, control guard and draft retention passed');
} finally { await browser.close(); }
