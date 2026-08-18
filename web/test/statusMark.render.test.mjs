// What the state marks actually render, in a browser.
//
// This complements statusMark.test.mjs by proving three things source lint
// cannot: the static rectangle follows Geist Mono's real braille ink, its
// stroke is one braille dot thick, and a state pseudo-element never paints
// over the inline provider/CLI colours carried by bare `.status` dots.
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
const geistMono = fs.readFileSync(path.join(HERE, '../public/fonts/GeistMono.woff2')).toString('base64');
// The source stylesheet points at /fonts, which setContent cannot serve. Put an
// otherwise identical face after it so this test measures the bundled font,
// independent of whichever mono font happens to be installed on the runner.
const embeddedFont = `@font-face {
  font-family: 'Geist Mono Test'; font-style: normal; font-weight: 100 900;
  src: url(data:font/woff2;base64,${geistMono}) format('woff2');
}
:root { --font-mono: 'Geist Mono Test'; }`;

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
await page.setContent(`<style>${css}\n${embeddedFont}</style>
  <div class="row" style="font-size:16px">
    <span class="status working" id="working"></span>
    <span class="status waiting" id="waiting"></span>
    <span class="status idle" id="idle"></span>
    <span class="status stopped" id="stopped"></span>
    <span class="status" id="provider" style="background: rgb(214, 69, 69)"></span>
    <span class="status" id="ready" style="background: rgb(46, 158, 91)"></span>
  </div>`);
await page.evaluate(async () => {
  await document.fonts.load('12.5px "Geist Mono Test"', '⠿⠁');
  await document.fonts.ready;
});
await page.waitForTimeout(150);

const { marks, ink } = await page.evaluate((ids) => {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    const style = getComputedStyle(el);
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
      borderWidth: border,
      borderRadius: b.borderRadius,
      boxShadow: b.boxShadow,
      left: parseFloat(b.left),
      top: parseFloat(b.top),
      position: b.position,
      elementBackground: style.backgroundColor,
      elementOpacity: parseFloat(style.opacity),
      cell: (() => { const r = el.getBoundingClientRect(); return [r.width, r.height]; })(),
    };
  }

  // Raster at 16x and count pixels at alpha >= 16. This is the measurement
  // documented beside the CSS contract, reproduced here by the browser that
  // will render the result. ⠁ isolates one dot; ⠿ gives the six-dot extent.
  const measure = (glyph) => {
    const scale = 16;
    const canvas = document.createElement('canvas');
    canvas.width = 32 * scale; canvas.height = 32 * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.font = '12.5px "Geist Mono Test"';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
    ctx.fillText(glyph, 8, 20);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width; let minY = canvas.height; let maxX = -1; let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] < 16) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return {
      width: (maxX - minX + 1) / scale,
      height: (maxY - minY + 1) / scale,
    };
  };
  return { marks: out, ink: { full: measure('⠿'), dot: measure('⠁') } };
}, ['working', 'waiting', 'idle', 'stopped', 'provider', 'ready']);
await browser.close();

const round = (xs) => xs.map((n) => Math.round(n * 100) / 100);
const close = (actual, expected, tolerance = 0.07) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};
const STATES = ['working', 'waiting', 'idle', 'stopped'];
const STATIC = ['waiting', 'idle', 'stopped'];

console.log('every state occupies the same outer cell');
for (const s of STATES) {
  check(`${s} uses the shared ${round(marks.working.cell).join(' x ')} cell`, () => {
    assert.deepEqual(round(marks[s].cell), round(marks.working.cell));
  });
}

console.log('\nworking is the animated braille mark');
check('it renders one frame with the shared font and no box', () => {
  assert.match(marks.working.content, /[⠋⠙⠹⠸⠼⠴⠦⠧]/);
  assert.equal(marks.working.fontSize, '12.5px');
  assert.match(marks.working.fontFamily, /Geist Mono Test/);
  assert.equal(marks.working.background, 'rgba(0, 0, 0, 0)');
  assert.equal(marks.working.borderStyle, 'none');
  assert.equal(marks.working.boxShadow, 'none');
});

console.log('\nthe static path is measured from Geist Mono, not guessed from the cell');
check('the full six-dot ink is 5.5 x 8.8125px at 12.5px', () => {
  close(ink.full.width, 5.5);
  close(ink.full.height, 8.8125);
});
check('one braille dot is 1.875px in both axes', () => {
  close(ink.dot.width, 1.875);
  close(ink.dot.height, 1.875);
});
for (const state of STATIC) {
  check(`${state} draws the same square, hollow rectangle`, () => {
    assert.equal(marks[state].content, '""');
    assert.equal(marks[state].position, 'absolute');
    assert.equal(marks[state].background, 'rgba(0, 0, 0, 0)');
    assert.equal(marks[state].borderStyle, 'solid');
    assert.equal(marks[state].borderRadius, '0px');
    assert.equal(marks[state].boxShadow, 'none');
  });
  check(`${state} spans the six-dot ink and uses one-dot stroke`, () => {
    close(marks[state].painted[0], ink.full.width);
    close(marks[state].painted[1], ink.full.height);
    // CSS border widths are integer CSS pixels in Chromium. The implementation
    // deliberately rounds the measured 1.875px dot to the nearest value rather
    // than letting Chromium floor a fractional declaration to 1px.
    assert.equal(marks[state].borderWidth, Math.round(ink.dot.width));
  });
  check(`${state} starts at the measured ink offset`, () => {
    close(marks[state].left, 1.8125);
    close(marks[state].top, 1.25);
  });
}
check('all three static rectangles have identical geometry', () => {
  for (const state of STATIC.slice(1)) {
    assert.deepEqual(round(marks[state].painted), round(marks.waiting.painted));
    close(marks[state].borderWidth, marks.waiting.borderWidth, 0.001);
  }
});

console.log('\nstate treatment changes only colour/intensity');
check('working and waiting share the accent', () => {
  assert.equal(marks.working.color, marks.waiting.color);
});
check('idle and stopped share the muted colour', () => {
  assert.equal(marks.idle.color, marks.stopped.color);
});
check('stopped is dimmer than idle', () => {
  assert.equal(marks.idle.elementOpacity, 1);
  assert.equal(marks.stopped.elementOpacity, 0.5);
});

console.log('\na bare .status keeps the colour its caller gave it');
for (const [id, colour] of [['provider', 'rgb(214, 69, 69)'], ['ready', 'rgb(46, 158, 91)']]) {
  check(`${id} still shows ${colour}`, () => {
    assert.equal(marks[id].elementBackground, colour);
    assert.equal(marks[id].content, 'none', 'something is painted over it');
    assert.deepEqual(round(marks[id].cell), [8, 8]);
  });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
