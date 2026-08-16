// What the state marks actually render, in a browser.
//
// The source lint next door cannot answer this. Both of the bugs this test
// exists for were invisible to it and to reading the CSS:
//
//   · static states used to draw filled/outlined CSS boxes beside a light
//     braille working glyph, despite occupying the same outer cell.
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
      fontFamily: b.fontFamily,
      fontSize: b.fontSize,
      color: b.color,
      background: b.backgroundColor,
      borderStyle: b.borderTopStyle,
      boxShadow: b.boxShadow,
      elementBackground: getComputedStyle(el).backgroundColor,
      cell: (() => { const r = el.getBoundingClientRect(); return [r.width, r.height]; })(),
    };
  }
  return out;
}, ['working', 'waiting', 'idle', 'stopped', 'provider', 'ready']);
await browser.close();

const round = (xs) => xs.map((n) => Math.round(n * 100) / 100);
const STATES = ['working', 'waiting', 'idle', 'stopped'];

console.log('every state occupies the same cell');
const ref = round(marks.waiting.painted);
for (const s of STATES) {
  check(`${s} paints ${ref.join(' x ')}`, () => {
    assert.deepEqual(round(marks[s].painted), ref);
  });
}
check('and the cells themselves agree', () => {
  for (const s of STATES) assert.deepEqual(round(marks[s].cell), round(marks.waiting.cell));
});

console.log('\nevery state is a distinct glyph in the spinner\'s braille cell');
const GLYPHS = { waiting: '⠿', idle: '⠶', stopped: '⠤' };
check('the four glyphs are distinct', () => {
  const animated = new Set(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']);
  assert.equal(new Set(['animated', ...Object.values(GLYPHS)]).size, STATES.length);
  for (const glyph of Object.values(GLYPHS)) assert.ok(!animated.has(glyph));
});
check('working renders one of the animation frames with the shared font and no box', () => {
  assert.match(marks.working.content, /[⠋⠙⠹⠸⠼⠴⠦⠧]/);
  assert.equal(marks.working.fontSize, '12.5px');
  assert.match(marks.working.fontFamily, /Geist Mono/);
  assert.equal(marks.working.background, 'rgba(0, 0, 0, 0)');
  assert.equal(marks.working.borderStyle, 'none');
  assert.equal(marks.working.boxShadow, 'none');
});
for (const [state, glyph] of Object.entries(GLYPHS)) {
  check(`${state} renders ${glyph} with the shared font and no box`, () => {
    assert.equal(marks[state].content, `"${glyph}"`);
    assert.equal(marks[state].fontSize, '12.5px');
    assert.match(marks[state].fontFamily, /Geist Mono/);
    assert.equal(marks[state].background, 'rgba(0, 0, 0, 0)');
    assert.equal(marks[state].borderStyle, 'none');
    assert.equal(marks[state].boxShadow, 'none');
  });
}
check('working and your-turn share the accent treatment', () => {
  assert.equal(marks.working.color, marks.waiting.color);
});
check('idle and stopped share the muted treatment', () => {
  assert.equal(marks.idle.color, marks.stopped.color);
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
