// Real controlled textareas. No model calls or terminal processes.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import Composer from './src/components/conversation/Composer';
    window.sent=[];
    function App(){
      const [draft,setDraft]=useState(''); const [second,setSecond]=useState('');
      return <><section id="mobile"><Composer isMobile draft={draft} onChange={setDraft} onSend={()=>window.sent.push(draft)}/></section>
        <section id="desktop"><Composer draft={second} onChange={setSecond} onSend={()=>window.sent.push(second)}/></section></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('http://composer.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  const mount = async () => { await page.goto('http://composer.test/'); await page.addScriptTag({ content: result.outputFiles[0].text }); await page.locator('#mobile textarea').waitFor(); };
  await mount();
  const mobile = page.locator('#mobile textarea'), desktop = page.locator('#desktop textarea');
  assert.equal(await mobile.getAttribute('autocorrect'), 'on');
  assert.equal(await mobile.getAttribute('autocapitalize'), 'sentences');
  assert.equal(await mobile.getAttribute('spellcheck'), 'true');
  assert.equal(await desktop.getAttribute('autocorrect'), 'off');
  assert.equal(await page.locator('#desktop input[type=checkbox]').count(), 0);
  await mobile.fill('some');
  // A keyboard suggestion replaces the existing word through a normal input event.
  await mobile.evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'something');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'something' }));
  });
  await page.locator('#mobile button[title="Send"]').click();
  assert.deepEqual(await page.evaluate(() => window.sent), ['something']);
  await mobile.press('Enter');
  assert.equal((await page.evaluate(() => window.sent)).length, 1, 'mobile Enter cannot submit');
  await desktop.fill('composition');
  for (const event of [{key:'Enter',isComposing:true},{key:'Escape',isComposing:true},{key:'Enter',keyCode:229}]) {
    await desktop.dispatchEvent('keydown', event);
  }
  assert.equal(await desktop.inputValue(), 'composition');
  assert.equal((await page.evaluate(() => window.sent)).length, 1, 'IME confirmation never submits');
  await desktop.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sent), ['something', 'composition']);
  assert.equal(await page.locator('input[type=checkbox]').count(), 0, 'no assistance toggle');
  await page.evaluate(() => localStorage.setItem('am:writing-assistance', 'off'));
  await mount();
  assert.equal(await mobile.getAttribute('autocorrect'), 'on', 'old opt-out cannot disable assistance');
  assert.equal(await mobile.getAttribute('autocapitalize'), 'sentences');
  assert.equal(await mobile.getAttribute('spellcheck'), 'true');
  console.log('writing-assistance: always-on mobile hints, no toggle, replacements and IME passed');
} finally { await browser.close(); }
