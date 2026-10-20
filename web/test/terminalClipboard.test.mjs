// OSC 52 in a real TerminalPane + xterm; only the websocket and the clipboard
// are fake. A program in a pane must never read the clipboard, and its copies
// reach the clipboard only through Cmd+C or a click while they are on screen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { clipboardPreview, clipboardSize, PROGRAM_COPY_MS } from '../src/lib/programCopy.ts';

// The preview is one line, and shows what would be pasted.
assert.equal(clipboardPreview('plain text'), 'plain text');
assert.equal(clipboardPreview('a\nb\r\tc\x1b[31m\x07\x7f\u0085'), 'a\\nb\\r\\tc\\x1b[31m\\x07\\x7f\\x85');
assert.equal(clipboardPreview('rm -rf ~‮​﻿  x'), 'rm -rf ~\\u{202e}\\u{200b}\\u{feff}\\u{2028}\\u{a0}x');
assert.equal(clipboardPreview('a\\nb'), 'a\\\\nb', 'a literal backslash cannot pass for an escape');
assert.equal(clipboardPreview('x'.repeat(200)), `${'x'.repeat(80)}…`);
assert.equal(clipboardPreview('\n'.repeat(100)).length, 81, 'escapes count toward the limit');
assert.equal(clipboardPreview('é😀 ok'), 'é😀 ok');
assert.equal(clipboardSize('hi'), '2 chars');
assert.equal(clipboardSize('a\nb\nc'), '5 chars · 3 lines');
assert.equal(clipboardSize('😀'), '1 char');
assert.ok(PROGRAM_COPY_MS <= 120_000);

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = (isMobile) => build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import TerminalPane from './src/components/TerminalPane';
    window.sent=[]; window.reads=0; window.copies=[];
    // A synthetic clipboard. readText counts calls: only an explicit paste may make one.
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
      readText(){window.reads++;return Promise.resolve('SYNTHETIC_CLIPBOARD_VALUE');},
      writeText(t){window.copies.push(t);return Promise.resolve();},
    }});
    // copyText's first path; record what it put on the clipboard.
    document.execCommand=(cmd)=>{
      if(cmd!=='copy')return false;
      const ta=[...document.querySelectorAll('body > textarea[readonly]')].pop();
      window.copies.push(ta?ta.value:null);return true;
    };
    class Socket {
      static OPEN=1; readyState=1;
      constructor(){window.socket=this;setTimeout(()=>{this.onopen?.();this.grid(true);this.onmessage?.({data:'\\x1b[?2004hReady> '});},20);}
      send(data){window.sent.push(JSON.parse(data));}
      grid(controller){this.onmessage?.({data:'\\x00\\x00AM:'+JSON.stringify({t:'grid',cols:60,rows:12,controller})});}
      close(){this.readyState=3;}
    }
    window.WebSocket=Socket;
    createRoot(document.getElementById('root')).render(<TerminalPane
      session={{id:'clip',cli:'shell',name:'clip-fixture',state:'idle',running:true,everStarted:true,path:null}}
      mode="terminal" theme="light" zoom={100} isMobile={${isMobile}} focused active visible onClose={()=>{}}/>);
  ` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
}).then((r) => r.outputFiles[0].text);

const css = ['src/styles.css', 'src/conversation.css', 'node_modules/@xterm/xterm/css/xterm.css']
  .map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const browser = await chromium.launch(chromiumLaunchOptions());
const open = async (isMobile) => {
  const page = await browser.newPage(isMobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 900, height: 500 } });
  await page.clock.install();
  await page.route('http://clip.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root{height:100vh}</style><div id="root"></div>` }));
  await page.goto('http://clip.test/');
  await page.addScriptTag({ content: await bundle(isMobile) });
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('Ready>'));
  return page;
};
const out = (page, data) => page.evaluate((d) => window.socket.onmessage({ data: d }), data);
const inputs = (page) => page.evaluate(() => window.sent.filter((m) => m.t === 'i').map((m) => m.d));
const copies = (page) => page.evaluate(() => window.copies.slice());
const reads = (page) => page.evaluate(() => window.reads);
const toast = (page) => page.locator('.term-program-copy');
const clickTerm = async (page) => {
  const r = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.click(r.x + 40, r.y + r.height - 20);
};
// The copy is an async clipboard write: wait for it to land before reading
// what was copied (an absence is still checked after settle(), as before).
const copied = (page, n) => page.waitForFunction((k) => window.copies.length >= k, n, { timeout: 10_000 });
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

try {
  const page = await open(false);
  await clickTerm(page);
  await page.waitForFunction(() => window.sent.some((m) => m.t === 'claim'));

  // Queries: every selection, both terminators, get an empty answer.
  for (const q of ['\x1b]52;c;?\x07', '\x1b]52;p;?\x07', '\x1b]52;s;?\x1b\\', '\x1b]52;;?\x07', '\x1b]52;0;?\x07']) {
    await out(page, q);
  }
  await page.waitForFunction(() => window.sent.filter((m) => m.t === 'i').length >= 5);
  await settle(page);
  assert.deepEqual(await inputs(page), ['\x1b]52;c;\x07', '\x1b]52;p;\x07', '\x1b]52;s;\x07', '\x1b]52;;\x07', '\x1b]52;0;\x07'],
    'clipboard queries are answered empty');
  assert.equal(await reads(page), 0, 'navigator.clipboard.readText is never called for a query');
  assert.ok(!(await inputs(page)).join('').includes(b64('SYNTHETIC_CLIPBOARD_VALUE')));

  // Nothing pending: Cmd+C copies nothing and sends nothing.
  await page.keyboard.press('Meta+c');
  assert.deepEqual(await copies(page), []);

  // A program copy shows the session, the size and an escaped preview.
  const payload = 'echo hi\x1b[31m\nrm -rf ~‮';
  await out(page, `\x1b]52;c;${b64(payload)}\x07`);
  await toast(page).waitFor();
  const shown = await toast(page).textContent();
  assert.match(shown, /clip-fixture wants to copy 22 chars · 2 lines/);
  assert.ok(shown.includes('echo hi\\x1b[31m\\nrm -rf ~\\u{202e}'), shown);
  assert.equal(await copies(page).then((c) => c.length), 0, 'a program copy alone writes nothing');
  await settle(page);
  await page.keyboard.press('Meta+c');
  await copied(page, 1);
  assert.deepEqual(await copies(page), [payload], 'Cmd+C copies the text on show');
  await page.getByText('copied', { exact: true }).waitFor();
  await page.keyboard.press('Meta+c');
  await settle(page);
  assert.equal((await copies(page)).length, 1, 'once used, it is not on offer any more');
  await page.clock.runFor(2000);
  assert.equal(await toast(page).count(), 0);

  // A newer copy replaces the older one.
  await out(page, `\x1b]52;c;${b64('first')}\x07`);
  await out(page, `\x1b]52;c;${b64('second')}\x07`);
  await page.getByText('second').waitFor();
  assert.equal(await toast(page).count(), 1);
  await settle(page);
  await page.keyboard.press('Meta+c');
  await copied(page, 2);
  assert.deepEqual((await copies(page)).slice(1), ['second']);
  await page.clock.runFor(2000);

  // Dismissed: Cmd+C copies nothing hidden.
  await out(page, `\x1b]52;c;${b64('dismiss me')}\x07`);
  await toast(page).waitFor();
  await toast(page).getByRole('button', { name: 'Dismiss copy' }).click();
  await toast(page).waitFor({ state: 'detached' });
  await clickTerm(page);
  await page.keyboard.press('Meta+c');
  await settle(page);
  assert.equal((await copies(page)).length, 2, 'dismissed text is gone');

  // Expired: same.
  await out(page, `\x1b]52;c;${b64('expire me')}\x07`);
  await toast(page).waitFor();
  await page.clock.runFor(PROGRAM_COPY_MS + 1000);
  assert.equal(await toast(page).count(), 0);
  await page.keyboard.press('Meta+c');
  await settle(page);
  assert.equal((await copies(page)).length, 2, 'expired text is gone');

  // An empty write withdraws the offer.
  await out(page, `\x1b]52;c;${b64('withdrawn')}\x07`);
  await toast(page).waitFor();
  await out(page, '\x1b]52;c;\x07');
  await toast(page).waitFor({ state: 'detached' });
  await page.keyboard.press('Meta+c');
  await settle(page);
  assert.equal((await copies(page)).length, 2);

  // A visible selection wins over pending text.
  await out(page, '\r\nSELECTME\r\n');
  await out(page, `\x1b]52;c;${b64('program text')}\x07`);
  await toast(page).waitFor();
  // The terminal draws on its own render tick: wait for the row to be there.
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some((r) => r.textContent.includes('SELECTME')));
  const box = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].find((r) => r.textContent.includes('SELECTME'));
    const r = row.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  });
  await page.mouse.dblclick(box.x, box.y);
  await page.keyboard.press('Meta+c');
  await copied(page, 3);
  assert.equal((await copies(page)).at(-1), 'SELECTME', 'the selection is copied, not the program text');
  assert.equal(await toast(page).count(), 1, 'and the program copy stays on offer');
  // A click on the notice copies it too.
  await toast(page).locator('.tpc-copy').click();
  await copied(page, 4);
  assert.equal((await copies(page)).at(-1), 'program text');

  // Paste is the operator's: a paste event reaches the PTY, bracketed.
  const before = (await inputs(page)).length;
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'PASTED\ntext');
    document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction((n) => window.sent.filter((m) => m.t === 'i').length > n, before);
  assert.equal((await inputs(page)).at(-1), '\x1b[200~PASTED\rtext\x1b[201~');
  assert.equal(await reads(page), 0);
  await page.close();

  // Phone: the paste button still reads the clipboard (an explicit request),
  // and a tap on the notice copies.
  const phone = await open(true);
  await phone.waitForFunction(() => window.sent.some((m) => m.t === 'claim'));
  await out(phone, '\x1b]52;c;?\x07');
  await phone.waitForFunction(() => window.sent.some((m) => m.t === 'i'));
  assert.deepEqual(await inputs(phone), ['\x1b]52;c;\x07']);
  assert.equal(await reads(phone), 0);
  await phone.getByRole('button', { name: 'paste', exact: true }).click();
  await phone.waitForFunction(() => window.sent.some((m) => m.t === 'i' && m.d.includes('SYNTHETIC')));
  assert.equal(await reads(phone), 1, 'one read, from the paste button');
  await out(phone, `\x1b]52;c;${b64('from the phone')}\x07`);
  await toast(phone).waitFor();
  assert.match(await toast(phone).textContent(), /tap to copy/);
  await toast(phone).locator('.tpc-copy').tap();
  await copied(phone, 1);
  assert.deepEqual(await copies(phone), ['from the phone']);
  assert.equal(await reads(phone), 1);
  if (process.env.AM_CLIP_SCREENSHOT) await phone.screenshot({ path: process.env.AM_CLIP_SCREENSHOT });
  await phone.close();
  console.log('terminal-clipboard: queries answered empty, program copies shown and copied only while shown, paste intact');
} finally { await browser.close(); }
