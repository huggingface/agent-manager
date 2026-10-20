// The reply composer must stay reachable once it hits its height cap.
//
// It auto-grows — Composer.tsx sets height to scrollHeight on every change —
// and CSS caps that at 140px. With `overflow: hidden` the cap meant the rest of
// a long draft was clipped and could not be reached by any means. The fix is a
// scrollable overflow, and these are the three things that has to not break:
// no scrollbar below the cap (the height is set to exactly scrollHeight, so
// there is nothing to scroll), the caret staying visible while typing past the
// cap, and a scroll that reaches the end of the draft not dragging the
// conversation behind it — which is where iOS chains by default.
//
// Run with:  node test/composerScroll.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-scroll-'));
const bundle = path.join(tmp, 'fixture.js');
const CAP = 140;   // .ov-live textarea max-height

await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import Composer from './src/components/conversation/Composer';
    const Host = ({ mobile, variant }) => {
      const [draft, setDraft] = React.useState('');
      const ref = React.useRef(null);
      window.__setDraft = setDraft;
      // A scrolling page behind it with range left on BOTH sides, so a chained
      // scroll has somewhere to go in either direction.
      return <div id="page" style={{ height: '300px', overflowY: 'auto' }}>
        <div style={{ height: '600px' }} />
        <Composer draft={draft} onChange={setDraft} inputRef={ref} isMobile={mobile}
          onKeyDown={() => {}} sending={false}
          className={variant.className} containerClassName={variant.containerClassName} />
        <div style={{ height: '600px' }} />
      </div>;
    };
    window.mount = (mobile, variant) => {
      document.getElementById('root').innerHTML = '';
      createRoot(document.getElementById('root')).render(<Host mobile={mobile} variant={variant} />);
    };
  ` },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
});

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  // The Reader composer is the one the operator reported, and it carries extra
  // classes that conversation.css targets with higher specificity than the
  // shared .ov-live rule. A fixture that renders only the bare Overview variant
  // stays green while a `.cxv-live textarea { overflow-y: hidden }` breaks the
  // Reader — which is exactly what review found.
  const VARIANTS = [
    { name: 'overview', className: '', containerClassName: '' },
    { name: 'reader', className: 'cxv-live', containerClassName: 'cxv-composer' },
  ];
  for (const [label, width, mobile] of [['desktop', 1000, false], ['phone', 390, true]]) {
   for (const variant of VARIANTS) {
    const label_ = `${label}/${variant.name}`;
    console.log(`\n${label_} ${width}px`);
    const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(`<style>${fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')}
      ${fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8')}</style><div id="root"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate(([m, v]) => window.mount(m, v), [mobile, variant]);
    await page.waitForSelector('.ov-live textarea');
    const ta = page.locator('.ov-live textarea');
    const classes = await page.evaluate(() => document.querySelector('.ov-live').className);
    await check(`${label_}: the fixture renders the ${variant.name} composer`, () =>
      assert.ok(variant.className === '' || classes.includes(variant.className),
        `.ov-live is "${classes}", expected to carry "${variant.className}"`));

    // ---- below the cap: grows, and has nothing to scroll ----
    await ta.click();
    await ta.fill('one line');
    await page.evaluate(() => {
      const el = document.querySelector('.ov-live textarea');
      el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`;
    });
    const small = await ta.evaluate((el) => ({ h: el.clientHeight, s: el.scrollHeight, w: el.clientWidth }));
    await check(`${label_}: a short draft is not scrollable`, () =>
      assert.ok(small.s <= small.h + 1, `scrollHeight ${small.s} > clientHeight ${small.h}`));

    // ---- grow past the cap one line at a time, watching for a flicker ----
    // A classic scrollbar appearing steals width; sampling clientWidth after
    // every grow catches it toggling, which is what a flicker IS.
    const widths = await page.evaluate((cap) => {
      const el = document.querySelector('.ov-live textarea');
      const seen = [];
      for (let i = 1; i <= 24; i++) {
        el.value = Array.from({ length: i }, (_, k) => `line ${k}`).join('\n');
        el.style.height = 'auto';
        seen.push({ n: i, w: el.clientWidth, over: el.scrollHeight > cap });
        el.style.height = `${el.scrollHeight}px`;
      }
      return seen;
    }, CAP);
    const below = widths.filter((x) => !x.over);
    await check(`${label_}: no scrollbar appears while it is still growing`, () => {
      const distinct = [...new Set(below.map((x) => x.w))];
      assert.equal(distinct.length, 1, `width changed below the cap: ${JSON.stringify(distinct)}`);
    });

    // ---- past the cap: capped, scrollable, and reachable ----
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    await page.evaluate((v) => window.__setDraft(v), long);
    await page.evaluate(() => {
      const el = document.querySelector('.ov-live textarea');
      el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`;
    });
    const big = await ta.evaluate((el) => ({ h: el.clientHeight, s: el.scrollHeight }));
    await check(`${label_}: a long draft is capped`, () => assert.ok(big.h <= CAP + 1, `height ${big.h}`));
    await check(`${label_}: and the rest can be reached`, () =>
      assert.ok(big.s > big.h + 10, `scrollHeight ${big.s} vs clientHeight ${big.h}`));
    await page.evaluate(() => {
      const el = document.querySelector('.ov-live textarea');
      el.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(120);
    await page.waitForTimeout(120);
    await ta.evaluate((el) => { el.scrollTop = 0; });
    const box = await ta.boundingBox();
    const onScreen = await page.evaluate((b) => b && b.y >= 0 && b.y + b.height <= window.innerHeight, box);
    await check(`${label_}: the draft is on screen for the wheel checks`, () =>
      assert.ok(onScreen, `composer box ${JSON.stringify(box)} is not in the viewport`));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(160);
    const byWheel = await ta.evaluate((el) => ({ top: el.scrollTop, overflow: getComputedStyle(el).overflowY }));
    await check(`${label_}: the operator can scroll it, not just a script`, () => {
      assert.notEqual(byWheel.overflow, 'hidden', 'overflow-y is hidden: the draft is unreachable');
      assert.ok(byWheel.top > 0, `a wheel over the draft moved it ${byWheel.top}px`);
    });

    // ---- the caret stays visible when typing at the bottom ----
    // Real typing, not execCommand: the latter is a no-op without user
    // activation here, and a check that silently inserts nothing would pass
    // whatever the overflow does.
    await page.evaluate(() => {
      const el = document.querySelector('.ov-live textarea');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = 0;                       // look away from the caret
    });
    const lengthBefore = await ta.evaluate((el) => el.value.length);
    await page.keyboard.type('!');
    await page.waitForTimeout(80);
    const caret = await ta.evaluate((el) => ({
      top: el.scrollTop, max: el.scrollHeight - el.clientHeight, len: el.value.length,
    }));
    await check(`${label_}: the keystroke actually landed`, () =>
      assert.equal(caret.len, lengthBefore + 1, 'nothing was typed, so the caret check proves nothing'));
    await check(`${label_}: typing at the end scrolls the caret back into view`, () =>
      assert.ok(caret.top > caret.max - 40, `scrollTop ${caret.top} of ${caret.max}`));

    // ---- iOS chaining: the page behind must not move ----
    // Both directions, each with somewhere for the page to go if the scroll
    // chains: at the draft's end push further down, at its top push further up.
    const chainRun = async (atEnd) => {
      const start = await page.evaluate((end) => {
        const el = document.querySelector('.ov-live textarea');
        const pg = document.getElementById('page');
        el.scrollTop = end ? el.scrollHeight : 0;
        return { page: pg.scrollTop, room: end ? pg.scrollHeight - pg.clientHeight - pg.scrollTop : pg.scrollTop };
      }, atEnd);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, atEnd ? 300 : -300);
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => document.getElementById('page').scrollTop);
      return { ...start, after };
    };
    const down = await chainRun(true);
    const up = await chainRun(false);
    const chain = {
      down, up,
      contain: await ta.evaluate((el) => getComputedStyle(el).overscrollBehaviorY),
      before: down.page, after: down.after,
    };
    // Without room to move, "it did not move" proves nothing.
    await check(`${label_}: the page has room to be dragged in both directions`, () => {
      assert.ok(down.room > 40, `only ${down.room}px of downward range`);
      assert.ok(up.room > 40, `only ${up.room}px of upward range`);
    });
    await check(`${label_}: scrolling past the draft's end does not drag the page`, () => {
      assert.equal(chain.down.after, chain.down.page,
        `page moved ${chain.down.page} -> ${chain.down.after} with ${chain.down.room}px of room`);
    });
    await check(`${label_}: and scrolling above its top does not either`, () => {
      assert.equal(chain.up.after, chain.up.page,
        `page moved ${chain.up.page} -> ${chain.up.after} with ${chain.up.room}px of room`);
    });

    await page.locator('.ov-live').screenshot({ path: `/tmp/composer-${label}-${variant.name}.png` });
    await check(`${label_}: no page errors`, () => assert.deepEqual(errors, [], errors[0]));
    await page.close();
   }
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\ncomposer-scroll: ok');
process.exit(failed ? 1 : 0);
