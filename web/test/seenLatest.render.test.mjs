// When is a reply "shown to the operator"?
//
// This drives the real hook in a real browser with a real IntersectionObserver,
// because every interesting case here is one where the component rendered
// perfectly well and the operator still saw nothing: the answer is below the
// fold, or the tab is in the background. A test that called the acknowledgement
// path directly would agree with itself and prove none of it.
//
// am-test: manual — needs Chromium; run with `npm run test:render`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
const entry = path.join(dir, 'entry.tsx');

// A page that is deliberately taller than the viewport, with the observed
// answer at the bottom — the shape of a conversation you have to scroll.
fs.writeFileSync(entry, `
import { createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useSeenLatest } from ${JSON.stringify(path.join(HERE, '../src/components/useSeenLatest'))};

const version = { id: 's1', src: 'gen1', seq: 3, hash: 'h3' };
(window as any).acks = [];

function Harness({ eligible }: { eligible: boolean }) {
  const ref = useSeenLatest({
    version,
    eligible,
    onSeen: (marks) => { (window as any).acks.push(marks.map((m) => m.hash)); },
  });
  return h('div', null,
    h('div', { style: { height: '2000px' }, id: 'filler' }, 'earlier history'),
    h('div', { ref, id: 'answer', style: { height: '200px', background: '#eee' } }, 'the latest reply'),
  );
}

(window as any).mount = (eligible: boolean) => {
  (window as any).acks = [];
  const el = document.getElementById('root');
  createRoot(el).render(h(StrictMode, null, h(Harness, { eligible })));
};
`);

const outfile = path.join(dir, 'bundle.js');
await build({
  entryPoints: [entry], outfile, bundle: true, format: 'iife', logLevel: 'error', jsx: 'automatic',
  // The entry lives in a temp dir, so point the resolver at this package's
  // modules rather than the temp dir's (empty) neighbourhood.
  nodePaths: [path.join(HERE, '../node_modules')],
});
const bundle = fs.readFileSync(outfile, 'utf8');

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
const ctx = await browser.newContext({ viewport: { width: 700, height: 500 } });
const page = await ctx.newPage();
const load = async (eligible = true) => {
  await page.setContent('<body style="margin:0"><div id="root"></div></body>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate((e) => window.mount(e), eligible);
  await page.waitForTimeout(120);
};
const acks = () => page.evaluate(() => window.acks.flat());

console.log('\nrendering is not reading');
await load();
{
  const rendered = await page.locator('#answer').count();
  const got = await acks();
  check('an answer below the fold is in the DOM and is NOT acknowledged', () => {
    assert.equal(rendered, 1, 'it really is rendered');
    assert.deepEqual(got, []);
  });
}

console.log('\nscrolling it into view is');
await page.evaluate(() => document.getElementById('answer').scrollIntoView());
await page.waitForTimeout(200);
{
  const got = await acks();
  check('the reply is acknowledged once it is actually on screen', () => assert.deepEqual(got, ['h3']));
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.evaluate(() => document.getElementById('answer').scrollIntoView());
await page.waitForTimeout(200);
{
  const got = await acks();
  check('and only once, however many times it comes back into view', () => assert.equal(got.length, 1));
}

console.log('\na background tab sees nothing');
await load();
// A real hidden document: the observer still fires, which is exactly why the
// hook cannot trust it alone.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.evaluate(() => document.getElementById('answer').scrollIntoView());
await page.waitForTimeout(200);
{
  const got = await acks();
  check('an on-screen reply in a hidden tab is not acknowledged', () => assert.deepEqual(got, []));
}
{
  const intersecting = await page.evaluate(() => new Promise((res) => {
    const io = new IntersectionObserver((es) => { res(es.some((e) => e.isIntersecting)); io.disconnect(); });
    io.observe(document.getElementById('answer'));
  }));
  check('(the element was intersecting all along)', () => assert.equal(intersecting, true));
}
// Coming back to the tab with the reply still on screen counts.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(200);
{
  const got = await acks();
  check('returning to the tab with it on screen does acknowledge', () => assert.deepEqual(got, ['h3']));
}

console.log('\nthe caller can veto');
await load(false); // eligible: false — e.g. paged back to an older turn
await page.evaluate(() => document.getElementById('answer').scrollIntoView());
await page.waitForTimeout(200);
{
  const got = await acks();
  check('a visible answer the caller says is not the latest is not acknowledged', () => assert.deepEqual(got, []));
}

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
