// A capped preview must scroll, and the history must still scroll around it.
//
// am-test: serial — real wheel and touch gestures; with the CPU saturated by a
// parallel run, a slow touch drag on the sheet chained into the history.
//
// The operator, on am-dev-2 at 9f2c92a: "the scrolling seems to be blocked when
// the preview widget doesnt have enough space". In a short reader pane the card
// was capped, drew a scrollbar, and would not scroll — every scroll it got
// re-placed it, and placing lifted the cap to measure, which clamped its own
// scrollTop back to 0. It was also sized against the window rather than the
// pane, so it hung over the composer. On touch, the sheet's backdrop caught
// every gesture, so the history could not be dragged while it was up.
//
// Measured with REAL input only — CDP wheel and touch, never a dispatched
// WheelEvent (which scrolls nothing in Chromium) and never scrollTop from
// script (which scrolls boxes a person cannot):
//  - mouse, short pane: opening moves nothing; the card stays inside the
//    history; the wheel over the card scrolls the card and, at its end, not the
//    history; the wheel over the icon scrolls the history, the card following;
//  - touch, phone in landscape: opening moves nothing; a drag on the sheet
//    scrolls the sheet and not the history; a drag on the history scrolls it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { buildFixture, mountReader, tmp } from './helpers/dispatchReader.mjs';

await buildFixture();
const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const history = (p) => p.evaluate(() => {
  const el = document.querySelector('.cxv-body');
  const r = el.getBoundingClientRect();
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, top: r.top, bottom: r.bottom };
});
const cardOf = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, cls: el.className };
}, sel);

try {
  // ---- mouse, in a short pane: the reported case ----
  {
    console.log('\n### mouse, reader pane 300px tall');
    const { context, p, errors } = await mountReader(browser, { width: 1100, height: 800, paneHeight: 300 });
    const box = await p.locator('.cxv-body').boundingBox();
    const icons = p.locator('.dx-icon');
    const icon = icons.nth((await icons.count()) - 3);
    // bring the icon near the top of the history with the wheel
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) {
      const r = await icon.boundingBox();
      const d = r.y - (box.y + 20);
      if (Math.abs(d) < 15) break;
      await p.mouse.wheel(0, Math.max(-200, Math.min(200, d)));
      await p.waitForTimeout(120);
    }
    await p.waitForTimeout(800);   // let the wheel gesture end before the next one

    const before = await history(p);
    await icon.hover();
    await p.waitForSelector('.dx-pop:not([style*="hidden"])');
    await p.waitForTimeout(400);
    const opened = await history(p);
    const c = await cardOf(p, '.dx-pop');
    check('opening moves nothing (scrollTop, scrollHeight)', () =>
      assert.deepEqual([opened.scrollTop, opened.scrollHeight], [before.scrollTop, before.scrollHeight]));
    check('the card is capped, and stays inside the history — not over the composer', () => {
      assert.match(c.cls, /\bcapped\b/);
      assert.ok(c.scrollHeight > c.clientHeight, 'nothing to scroll: the case is not reproduced');
      assert.ok(c.top >= opened.top - 0.5 && c.bottom <= opened.bottom + 0.5, `card ${c.top}–${c.bottom} vs history ${opened.top}–${opened.bottom}`);
    });

    // the wheel over the card scrolls the card
    const cb = await p.locator('.dx-pop').boundingBox();
    await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 5 });
    await p.waitForTimeout(800);
    await p.mouse.wheel(0, 80);
    await p.waitForTimeout(500);
    const scrolled = await cardOf(p, '.dx-pop');
    const h1 = await history(p);
    check('the wheel over a capped card scrolls the card', () => assert.ok(scrolled && scrolled.scrollTop > 0, `card scrollTop ${scrolled?.scrollTop}`));
    check('and not the history behind it', () => assert.equal(h1.scrollTop, opened.scrollTop));
    // to its end, and past: contained
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 200); await p.waitForTimeout(80); }
    await p.waitForTimeout(500);
    const end = await cardOf(p, '.dx-pop');
    const h2 = await history(p);
    check('scrolled to its end, the card does not hand the scroll on to the history', () => {
      assert.ok(Math.abs(end.scrollTop + end.clientHeight - end.scrollHeight) < 2, 'card not at its end');
      assert.equal(h2.scrollTop, opened.scrollTop);
    });

    // the wheel over the icon scrolls the history; the card follows its icon
    const ib = await icon.boundingBox();
    await p.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 5 });
    await p.waitForTimeout(800);
    await p.mouse.wheel(0, -60);
    await p.waitForTimeout(500);
    const h3 = await history(p);
    const follow = await cardOf(p, '.dx-pop');
    check('with the card open, the history still scrolls under a real wheel', () => assert.ok(h3.scrollTop < h2.scrollTop - 10, `${h2.scrollTop} -> ${h3.scrollTop}`));
    check('and the card is still there, next to its icon', () => assert.ok(follow, 'card closed'));

    check('no page errors', () => assert.deepEqual(errors, [], errors.slice(0, 2).join(' | ')));
    await context.close();
  }

  // ---- touch, a phone in landscape: the sheet has to scroll ----
  {
    console.log('\n### touch, phone landscape 844x390');
    const { context, p, errors } = await mountReader(browser, { width: 844, height: 390, touch: true });
    const cdp = await context.newCDPSession(p);
    const drag = async (x, y, dy) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / 10 }] });
        await p.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await p.waitForTimeout(600);
    };
    const box = await p.locator('.cxv-body').boundingBox();
    // an icon in the upper part of the history, above where the sheet will be
    const icons = p.locator('.dx-icon');
    const icon = icons.nth((await icons.count()) - 1);
    for (let i = 0; i < 12; i++) {
      const r = await icon.boundingBox();
      if (r && r.y > box.y + 10 && r.y < box.y + 60) break;
      await drag(box.x + box.width / 2, box.y + box.height / 2, Math.max(-150, Math.min(150, (box.y + 30) - (r ? r.y : box.y))));
    }
    const before = await history(p);
    await icon.tap();
    await p.waitForSelector('.dx-sheet');
    await p.waitForTimeout(400);
    const opened = await history(p);
    const sheet = await cardOf(p, '.dx-sheet');
    check('opening moves nothing (scrollTop, scrollHeight)', () =>
      assert.deepEqual([opened.scrollTop, opened.scrollHeight], [before.scrollTop, before.scrollHeight]));
    check('the sheet has more than it can show — the case is reproduced', () => assert.ok(sheet.scrollHeight > sheet.clientHeight + 20));

    const sb = await p.locator('.dx-sheet').boundingBox();
    await drag(sb.x + sb.width / 2, sb.y + sb.height - 30, -120);
    const sheet2 = await cardOf(p, '.dx-sheet');
    const h1 = await history(p);
    check('a drag on the sheet scrolls the sheet', () => assert.ok(sheet2 && sheet2.scrollTop > 0, `sheet scrollTop ${sheet2?.scrollTop}`));
    check('and not the history behind it', () => assert.equal(h1.scrollTop, opened.scrollTop));

    // a drag on the history, above the sheet: the history scrolls
    const sb2 = await p.locator('.dx-sheet').boundingBox();
    check('part of the history stays in view above the sheet', () => assert.ok(sb2.y - box.y > 40, `${sb2.y - box.y}px of history left`));
    await drag(box.x + box.width / 2, box.y + 8, Math.min(60, sb2.y - box.y - 16));
    const h2 = await history(p);
    check('a drag on the history scrolls it while the sheet was open', () => assert.ok(Math.abs(h2.scrollTop - h1.scrollTop) > 10, `${h1.scrollTop} -> ${h2.scrollTop}`));
    const gone = await p.locator('.dx-sheet').count();
    check('the sheet closed on the touch outside it', () => assert.equal(gone, 0));

    check('no page errors', () => assert.deepEqual(errors, [], errors.slice(0, 2).join(' | ')));
    await context.close();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\ndispatch-preview-scroll: a capped preview scrolls, and the history still scrolls around it');
process.exit(failed ? 1 : 0);
