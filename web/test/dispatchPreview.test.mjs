// Opening a dispatched session's preview must never move the message history.
//
// The operator, on am-dev-2: "if the preview doesnt fit under the icon it moves
// up the whole message history … i dont want the history to move ever for
// this." It did: the card was absolutely positioned INSIDE the conversation
// scroller, so near the bottom it extended past the end, grew scrollHeight, and
// the reader's follow-to-bottom scrolled to the new end. The card is now an
// overlay on document.body, placed against the icon's viewport rect.
//
// What is measured is the requirement itself: the scroller's scrollTop and
// scrollHeight before and after opening a preview — for an icon near the bottom
// of the viewport (the reported case, which must flip ABOVE), near the top
// (stays below), and with a tap on a phone. They must be identical, and the
// card must be inside the viewport.
//
// The real TerminalPane in reader mode, with a synthetic trace and dispatch API.
// Never starts an agent, never opens a real socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { buildFixture, mountReader, tmp } from './helpers/dispatchReader.mjs';

const bundle = await buildFixture();

const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

try {
  for (const [label, width, height, touch] of [['desktop', 1100, 800, false], ['phone', 390, 844, true]]) {
    console.log(`\n### ${label} ${width}x${height}`);
    const { context, p, errors } = await mountReader(browser, { width, height, touch });

    const geometry = () => p.evaluate(() => {
      const el = document.querySelector('.cxv-body');
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    });
    const card = () => p.evaluate(() => {
      const el = document.querySelector('.dx-pop, .dx-sheet');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cls: el.className,
        inScroller: !!el.closest('.cxv-body'), vw: innerWidth, vh: innerHeight };
    });
    const iconBox = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const open = async (loc) => {
      if (touch) await loc.tap(); else await loc.hover();
      await p.waitForSelector('.dx-pop:not([style*="hidden"]), .dx-sheet', { timeout: 5_000 });
      await p.waitForTimeout(500);   // let any follow-to-bottom or layout settle
    };
    const closeIt = async () => {
      if (touch) { const b = await p.locator('.cxv-body').boundingBox(); await p.touchscreen.tap(b.x + b.width / 2, b.y + 6); }
      else {
        // the card's button must be reachable: moving onto it keeps it open
        const pop = await p.locator('.dx-pop').boundingBox();
        await p.mouse.move(pop.x + pop.width - 30, pop.y + pop.height - 15, { steps: 6 });
        await p.waitForTimeout(500);
        const still = await p.locator('.dx-pop').count();
        check('moving onto the card keeps it open, so its Open session button can be reached', () => assert.equal(still, 1));
        await p.mouse.move(2, 2, { steps: 4 });
      }
      await p.waitForFunction(() => !document.querySelector('.dx-pop, .dx-sheet'), null, { timeout: 5_000 });
    };

    // 1. the reported case: the last turn's icon, near the bottom of the viewport
    {
      const icon = p.locator('.dx-icon').last();
      const box = await iconBox(icon);
      const before = await geometry();
      await open(icon);
      const after = await geometry();
      const c = await card();
      check('near the bottom: scrollTop and scrollHeight are identical after opening', () => assert.deepEqual(after, before));
      check('the card is not inside the conversation scroller', () => assert.equal(c.inScroller, false));
      check('and it is entirely on screen', () => {
        assert.ok(c.top >= 0 && c.bottom <= c.vh + 0.5 && c.left >= 0 && c.right <= c.vw + 0.5, JSON.stringify(c));
      });
      if (!touch) check('it opened ABOVE the icon, since it does not fit below', () => {
        assert.match(c.cls, /\babove\b/);
        assert.ok(c.bottom <= box.top, `card bottom ${c.bottom} vs icon top ${box.top}`);
      });
      await closeIt();
      const closed = await geometry();
      check('and closing it moves nothing either', () => assert.deepEqual(closed, before));
    }

    // 2. an icon near the top of the viewport
    {
      await p.evaluate(() => {
        const body = document.querySelector('.cxv-body');
        const icons = [...document.querySelectorAll('.dx-icon')];
        const target = icons[Math.max(0, icons.length - 6)];
        body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 40;
      });
      await p.waitForTimeout(600);
      const icon = p.locator('.dx-icon').nth(await p.locator('.dx-icon').count() - 6);
      const box = await iconBox(icon);
      const before = await geometry();
      await open(icon);
      const after = await geometry();
      const c = await card();
      check('near the top: scrollTop and scrollHeight are identical after opening', () => assert.deepEqual(after, before));
      if (!touch) check('it opened BELOW the icon, where there is room', () => {
        assert.match(c.cls, /\bbelow\b/);
        assert.ok(c.top >= box.bottom, `card top ${c.top} vs icon bottom ${box.bottom}`);
      });
      check('on screen', () => assert.ok(c.top >= 0 && c.bottom <= c.vh + 0.5 && c.left >= 0 && c.right <= c.vw + 0.5, JSON.stringify(c)));
      if (!touch) {
        // History can scroll while a card is open (live turns, the keyboard):
        // it follows its icon, and closes once the icon has left the reader.
        // Opened from the keyboard with the mouse parked outside, so no other
        // icon scrolls under the pointer and opens its own preview; scrolled
        // with real keys, because the reader re-pins programmatic scrollTop.
        await p.mouse.move(2, 2, { steps: 4 });
        await p.waitForFunction(() => !document.querySelector('.dx-pop'), null, { timeout: 5_000 });
        await p.keyboard.press('Shift');
        await icon.evaluate((e) => e.focus({ preventScroll: true }));
        await p.waitForSelector('.dx-pop:not([style*="hidden"])', { timeout: 5_000 });
        await p.waitForTimeout(300);
        const c1 = await card();
        const b1 = await iconBox(icon);
        await p.keyboard.press('ArrowUp');
        await p.waitForTimeout(400);
        const moved = await card();
        const b2 = await iconBox(icon);
        check('scrolled while open: the card follows its icon', () => {
          assert.ok(moved, 'card closed');
          assert.ok(b2.top !== b1.top, 'the history did not scroll — the check proves nothing');
          // still against its icon, on whichever side now has the room
          const below = Math.abs(moved.top - (b2.bottom + 6)) < 1;
          const above = Math.abs(moved.bottom - (b2.top - 6)) < 1;
          assert.ok(below || above, `card ${moved.top}–${moved.bottom}, icon ${b2.top}–${b2.bottom}`);
        });
        for (let i = 0; i < 3; i++) await p.keyboard.press('PageUp');
        await p.waitForTimeout(500);
        const gone = await card();
        check('and closes once the icon has scrolled out of the reader', () => assert.equal(gone, null));
        await p.mouse.move(2, 2);
      } else await closeIt();
    }

    check('no page errors', () => assert.deepEqual(errors, [], errors.slice(0, 2).join(' | ')));
    await context.close();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\ndispatch-preview: opening a preview never moves the history');
process.exit(failed ? 1 : 0);
