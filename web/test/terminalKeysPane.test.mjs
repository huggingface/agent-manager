// Real TerminalPane + xterm, fake websocket: what bytes reach the PTY for the
// shortcut keys, and whether the browser's default action is cancelled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = (isMobile) => build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import TerminalPane from './src/components/TerminalPane';
    window.sent=[];
    // Every keydown, to read defaultPrevented once xterm has had its turn.
    window.keys=[];
    document.addEventListener('keydown',(e)=>window.keys.push(e),true);
    class Socket {
      static OPEN=1; readyState=1;
      constructor(){window.socket=this;setTimeout(()=>{this.onopen?.();this.grid(true);this.onmessage?.({data:'\\x1b[?2004hReady> '});},20);}
      send(data){window.sent.push(JSON.parse(data));}
      grid(controller){this.onmessage?.({data:'\\x00\\x00AM:'+JSON.stringify({t:'grid',cols:60,rows:12,controller})});}
      close(){this.readyState=3;}
    }
    window.WebSocket=Socket;
    createRoot(document.getElementById('root')).render(<TerminalPane
      session={{id:'keys',cli:'shell',name:'keys-fixture',state:'idle',running:true,everStarted:true,path:null}}
      mode="terminal" theme="light" zoom={100} isMobile={${isMobile}} focused active visible onClose={()=>{}}/>);
  ` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
}).then((r) => r.outputFiles[0].text);

const css = ['src/styles.css', 'src/conversation.css', 'node_modules/@xterm/xterm/css/xterm.css']
  .map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');

const browser = await chromium.launch(chromiumLaunchOptions());
const open = async (platform) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  await page.addInitScript((p) => Object.defineProperty(navigator, 'platform', { get: () => p }), platform);
  await page.route('http://keys.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root{height:100vh}</style><div id="root"></div>` }));
  await page.goto('http://keys.test/');
  await page.addScriptTag({ content: await bundle(false) });
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('Ready>'));
  const r = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.click(r.x + 40, r.y + r.height - 20);
  await page.waitForFunction(() => window.sent.some((m) => m.t === 'claim'));
  return page;
};
const inputs = (page) => page.evaluate(() => window.sent.filter((m) => m.t === 'i').map((m) => m.d));
// xterm reads the legacy keyCode, which a synthetic event only has if given.
const KEY_CODES = { Enter: 13, Tab: 9, KeyB: 66, KeyK: 75, KeyL: 76, KeyR: 82, KeyT: 84, KeyJ: 74,
  ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46 };
// Dispatch a keydown at the terminal; returns what it sent and whether the
// browser default was cancelled.
const press = async (page, init) => {
  const before = (await inputs(page)).length;
  const prevented = await page.evaluate(([i, k]) => {
    const t = document.querySelector('.xterm-helper-textarea');
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: k[i.code], ...i });
    t.dispatchEvent(e);
    return e.defaultPrevented;
  }, [init, KEY_CODES]);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
  return { sent: (await inputs(page)).slice(before), prevented };
};

try {
  const mac = await open('MacIntel');
  // Option+B: macOS reports "∫"; it must become ESC b, not the character.
  assert.deepEqual(await press(mac, { key: '∫', code: 'KeyB', altKey: true }), { sent: ['\x1bb'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'Enter', code: 'Enter', altKey: true }), { sent: ['\x1b\r'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'Enter', code: 'Enter', shiftKey: true }), { sent: ['\x1b\r'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'Enter', code: 'Enter' }), { sent: ['\r'], prevented: true }, 'plain Enter is xterm\'s');
  // A German-layout Option character is left to the layout (it types on keypress).
  assert.deepEqual(await press(mac, { key: '@', code: 'KeyL', altKey: true }), { sent: [], prevented: false });
  // Ctrl combos: the byte is sent once and the browser is stopped.
  assert.deepEqual(await press(mac, { key: 'r', code: 'KeyR', ctrlKey: true }), { sent: ['\x12'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'l', code: 'KeyL', ctrlKey: true }), { sent: ['\x0c'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'Tab', code: 'Tab', shiftKey: true }), { sent: ['\x1b[Z'], prevented: true });
  // iTerm2 "Natural Text Editing": Cmd+arrows and Cmd+Backspace become readline
  // bytes (xterm.js alone sends nothing for them), Option+Forward Delete is ESC d.
  assert.deepEqual(await press(mac, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }), { sent: ['\x01'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true }), { sent: ['\x05'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'Backspace', code: 'Backspace', metaKey: true }), { sent: ['\x15'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), { sent: ['\x1bb'], prevented: true });
  assert.deepEqual(await press(mac, { key: 'Delete', code: 'Delete', altKey: true }), { sent: ['\x1bd'], prevented: true });
  // Cmd+K clears the local scrollback and sends nothing.
  await mac.evaluate(() => window.socket.onmessage({ data: '\r\n' + Array.from({ length: 30 }, (_, i) => `old-line-${i}`).join('\r\n') + '\r\nReady> ' }));
  await mac.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('old-line-29'));
  assert.deepEqual(await press(mac, { key: 'k', code: 'KeyK', metaKey: true }), { sent: [], prevented: true });
  const left = await mac.evaluate(() => document.querySelector('.xterm-rows').textContent);
  assert.ok(!left.includes('old-line-29') && left.includes('Ready>'), left);
  // Other Cmd combos are left alone: nothing sent, nothing cancelled.
  assert.deepEqual(await press(mac, { key: 'r', code: 'KeyR', metaKey: true }), { sent: [], prevented: false });
  assert.deepEqual(await press(mac, { key: 't', code: 'KeyT', metaKey: true }), { sent: [], prevented: false });
  await mac.close();

  const linux = await open('Linux x86_64');
  assert.deepEqual(await press(linux, { key: 'Enter', code: 'Enter', shiftKey: true }), { sent: ['\x1b\r'], prevented: true });
  assert.deepEqual(await press(linux, { key: 'b', code: 'KeyB', altKey: true }), { sent: ['\x1bb'], prevented: true }, 'xterm\'s own Alt handling');
  assert.deepEqual(await press(linux, { key: 'j', code: 'KeyJ', ctrlKey: true }), { sent: ['\n'], prevented: true });
  await linux.close();
  console.log('terminal-keys: Option-as-Meta, iTerm2 Cmd keys, newline and reserved Ctrl combos reach the PTY, once');
} finally { await browser.close(); }
