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
    import MobileTerminalDraft from './src/components/MobileTerminalDraft';
    window.sent=[]; window.inserted=[];
    function App(){
      const [draft,setDraft]=useState(''); const [second,setSecond]=useState('');
      const [terminal,setTerminal]=useState(''); const [control,setControl]=useState(false);
      window.control=setControl;
      return <><section id="mobile"><Composer isMobile draft={draft} onChange={setDraft} onSend={()=>window.sent.push(draft)}/></section>
        <section id="desktop"><Composer draft={second} onChange={setSecond} onSend={()=>window.sent.push(second)}/></section>
        <section id="terminal"><MobileTerminalDraft draft={terminal} onChange={setTerminal} canInsert={control}
          onInsert={()=>{window.inserted.push(terminal);setTerminal('');}} onClose={()=>{}}/></section></>;
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
  await page.locator('#mobile input').uncheck();
  assert.equal(await mobile.getAttribute('autocorrect'), 'off');
  assert.equal(await page.locator('#terminal textarea').getAttribute('autocorrect'), 'off', 'same-page composers share the preference');
  assert.equal(await mobile.inputValue(), 'something\n', 'toggling preserves the draft');
  await mount();
  assert.equal(await mobile.getAttribute('autocorrect'), 'off', 'preference survives reload');
  await page.locator('#mobile input').check();
  const terminal = page.locator('#terminal textarea');
  await terminal.fill('two\nlines');
  assert.deepEqual(await page.evaluate(() => window.inserted), [], 'typing sends nothing');
  assert.equal(await page.locator('#terminal button[title="Paste draft into terminal"]').isDisabled(), true);
  await page.evaluate(() => window.control(true));
  await page.locator('#terminal button[title="Paste draft into terminal"]').click();
  assert.deepEqual(await page.evaluate(() => window.inserted), ['two\nlines'], 'explicit paste preserves text without adding Enter');
  // A denied storage write must not prevent the preference working in memory.
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage denied'); }; });
  await page.locator('#mobile input').uncheck();
  assert.equal(await mobile.getAttribute('autocorrect'), 'off');
  console.log('writing-assistance: mobile hints, preference, replacements, IME and buffered terminal draft passed');
} finally { await browser.close(); }
