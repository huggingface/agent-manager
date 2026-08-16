// What the state marks actually PAINT, in a browser.
//
// The source lint next door cannot answer this. Both of the bugs this test
// exists for were invisible to it and to reading the CSS:
//
//   · `.status.stopped::before` drew its outline with a border on a
//     `content-box` pseudo-element, so the border was laid OUTSIDE `height:
//     100%`. The source said 100% like the other three; Chromium painted
//     8 x 18.8px against their 8 x 16.8, and flex-shrank the width to boot.
//   · an unconditional `.status::before` painted `currentColor` over the
//     inline provider and CLI colours that UsagePanel and SettingsView put on
//     a bare `.status`, which have no state class at all.
//
// Needs Chromium; run with:  node test/statusMark.render.test.mjs
// (not in `npm test`, which stays browser-free — see package.json's test:render)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = ['styles.css', 'conversation.css']
  .map((f) => fs.readFileSync(path.join(HERE, '../src', f), 'utf8')).join('\n');

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
// The markup the app renders: four state marks, and the two bare dots that
// carry a colour of their own (UsagePanel.tsx, SettingsView.tsx).
await page.setContent(`<style>${css}</style>
  <div class="row" style="font-size:16px">
    <span class="status working" id="working"></span>
    <span class="status waiting" id="waiting"></span>
    <span class="status idle" id="idle"></span>
    <span class="status stopped" id="stopped"></span>
    <span class="status" id="provider" style="background: rgb(214, 69, 69)"></span>
    <span class="status" id="ready" style="background: rgb(46, 158, 91)"></span>
  </div>`);
await page.waitForTimeout(150);

const marks = await page.evaluate((ids) => {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    const b = getComputedStyle(el, '::before');
    const border = parseFloat(b.borderTopWidth) || 0;
    const w = parseFloat(b.width) || 0;
    const h = parseFloat(b.height) || 0;
    out[id] = {
      // what lands on screen, border included whichever box model is in play
      painted: b.content === 'none' ? null
        : (b.boxSizing === 'border-box' ? [w, h] : [w + 2 * border, h + 2 * border]),
      content: b.content,
      elementBackground: getComputedStyle(el).backgroundColor,
      cell: (() => { const r = el.getBoundingClientRect(); return [r.width, r.height]; })(),
    };
  }
  return out;
}, ['working', 'waiting', 'idle', 'stopped', 'provider', 'ready']);
await browser.close();

const round = (xs) => xs.map((n) => Math.round(n * 100) / 100);
const STATES = ['working', 'waiting', 'idle', 'stopped'];

console.log('every state paints the same cell');
const ref = round(marks.waiting.painted);
for (const s of STATES) {
  check(`${s} paints ${ref.join(' x ')}`, () => {
    assert.deepEqual(round(marks[s].painted), ref);
  });
}
check('and the cells themselves agree', () => {
  for (const s of STATES) assert.deepEqual(round(marks[s].cell), round(marks.waiting.cell));
});

console.log('\nworking is the only one drawing a glyph');
check('working renders a braille frame', () => {
  assert.match(marks.working.content, /[⠋⠙⠹⠸⠼⠴⠦⠧]/);
});
check('the other three render an empty box', () => {
  for (const s of ['waiting', 'idle', 'stopped']) assert.equal(marks[s].content, '""');
});

console.log('\nand a bare .status keeps the colour its caller gave it');
for (const [id, colour] of [['provider', 'rgb(214, 69, 69)'], ['ready', 'rgb(46, 158, 91)']]) {
  check(`${id} still shows ${colour}`, () => {
    assert.equal(marks[id].elementBackground, colour);
    assert.equal(marks[id].content, 'none', 'something is painted over it');
  });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
