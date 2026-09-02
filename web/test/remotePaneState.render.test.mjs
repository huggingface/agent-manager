// The remote pane's state row and its receipts, measured in a browser.
//
// Two claims here cannot be checked by reading CSS, and both are the ones that
// would break quietly:
//
//  1. NO JUMP. `pending` becomes `delivered` while you watch, in a log that is
//     pinned to the bottom. If the two receipts are not exactly the same height
//     the whole log shifts by the difference the moment an agent collects a
//     message. Measured, not reasoned about.
//  2. ZOOM. The braille contract declares --mark-size in absolute pixels
//     (12.5px, measured against Geist Mono's braille ink). This pane zooms, so
//     the row restates it as a ratio; if that override is ever dropped the mark
//     stays 12.5px while every other glyph around it grows, which reads as a
//     rendering bug rather than a missing line of CSS.
//
// Plus the alignment the placement exists for: a receipt under a twelve-line
// message still starts on the message's own left edge.
//
// am-test: manual — needs Chromium; run with `npm run test:render`.
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
// setContent cannot serve /fonts; put an identical face after the sheet so this
// measures the bundled font rather than whatever mono the runner happens to
// have. Same device as statusMark.render.test.mjs.
const embeddedFont = `@font-face {
  font-family: 'Geist Mono Test'; font-style: normal; font-weight: 100 900;
  src: url(data:font/woff2;base64,${geistMono}) format('woff2');
}
:root { --font-mono: 'Geist Mono Test'; }`;
// The spinner is deliberately left running: `working` claiming ov-spin is one of
// the things this suite checks, and steps(1) means whichever frame is showing is
// a braille glyph from the contract either way.

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// The markup RemotePane renders, with the receipt as the component writes it.
const receipt = (kind) => kind === 'ack'
  ? '<span class="rp-receipt ack"><svg viewBox="0 0 16 16"></svg> delivered</span>'
  : '<span class="rp-receipt pending">pending</span>';
const message = (id, kind, text) => `<div class="rp-user" id="${id}">
  <span class="rp-caret">❯</span>
  <div class="rp-user-body">
    <span class="rp-user-text" id="${id}-text">${text}</span>
    ${receipt(kind)}
  </div>
</div>`;

const LONG = 'when you are back: pull the new cuts and re-render scene 4 at 60fps, '
  + 'then tell me the render time and whether the audio drifted on the long take';

const pane = (fontSize, width) => `<div class="slot" style="width:${width}px">
  <div class="rp-body" style="font-size:${fontSize}px">
    ${message('short-pending', 'pending', 'ping')}
    ${message('short-ack', 'ack', 'ping')}
    ${message('long-pending', 'pending', LONG)}
    ${message('long-ack', 'ack', LONG)}
  </div>
  <div class="rp-staterow" id="row-working" style="font-size:${fontSize}px">
    <span class="state-mark working" id="mark-working"></span><span class="rp-state working">working</span>
  </div>
  <div class="rp-staterow" id="row-waiting" style="font-size:${fontSize}px">
    <span class="state-mark waiting" id="mark-waiting"></span><span class="rp-state waiting">listening</span>
  </div>
  <div class="rp-staterow" id="row-stopped" style="font-size:${fontSize}px">
    <span class="state-mark stopped" id="mark-stopped"></span><span class="rp-state stopped">not connected</span>
  </div>
  <div class="rp-composer" style="font-size:${fontSize}px"><span class="rp-caret">❯</span></div>
</div>`;

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();

const measure = async (fontSize, width) => {
  await page.setContent(`<style>${css}\n${embeddedFont}</style>${pane(fontSize, width)}`);
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const mark = (id) => {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      return {
        fontSize: parseFloat(cs.fontSize),
        content: before.content,
        animation: before.animationName,
        borderWidth: parseFloat(before.borderTopWidth) || 0,
        ...box(id),
      };
    };
    const receiptOf = (id) => {
      const r = document.querySelector(`#${id} .rp-receipt`).getBoundingClientRect();
      return { x: r.x, y: r.y, h: r.height };
    };
    return {
      blocks: Object.fromEntries(['short-pending', 'short-ack', 'long-pending', 'long-ack']
        .map((id) => [id, box(id)])),
      texts: Object.fromEntries(['short-pending', 'short-ack', 'long-pending', 'long-ack']
        .map((id) => [id, box(`${id}-text`)])),
      receipts: Object.fromEntries(['short-pending', 'short-ack', 'long-pending', 'long-ack']
        .map((id) => [id, receiptOf(id)])),
      marks: { working: mark('mark-working'), waiting: mark('mark-waiting'), stopped: mark('mark-stopped') },
      rows: { working: box('row-working'), waiting: box('row-waiting'), stopped: box('row-stopped') },
      composer: document.querySelector('.rp-composer').getBoundingClientRect().y,
      logBottom: document.querySelector('.rp-body').getBoundingClientRect().bottom,
      // The text is a flex item, so it is blockified and reports one rect
      // however many lines it has. A range over its contents reports the real
      // line boxes.
      textLines: (() => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById('long-pending-text'));
        return r.getClientRects().length;
      })(),
    };
  });
};

const wide = await measure(13, 620);
const narrow = await measure(13, 260);
const zoomed = await measure(26, 620);

console.log('a receipt landing cannot move the log');
for (const [what, m] of [['at 620px', wide], ['at 260px', narrow], ['at 200% zoom', zoomed]]) {
  check(`${what}: a one-word message is the same height pending or delivered`, () => {
    assert.equal(m.blocks['short-pending'].h, m.blocks['short-ack'].h);
  });
  check(`${what}: a wrapped message is the same height pending or delivered`, () => {
    assert.equal(m.blocks['long-pending'].h, m.blocks['long-ack'].h);
  });
  check(`${what}: the receipt line itself is one height`, () => {
    assert.equal(m.receipts['long-pending'].h, m.receipts['long-ack'].h);
  });
}

console.log('\nthe receipt belongs to the message, on its left edge');
check('the long message really does wrap at 260px', () => {
  assert.ok(narrow.textLines >= 3, `wrapped to ${narrow.textLines} line(s)`);
});
for (const [what, m] of [['at 620px', wide], ['at 260px', narrow]]) {
  for (const id of ['long-pending', 'long-ack']) {
    check(`${what}: ${id} starts on the text's left edge`, () => {
      assert.ok(Math.abs(m.receipts[id].x - m.texts[id].x) < 1,
        `receipt x ${m.receipts[id].x} vs text x ${m.texts[id].x}`);
    });
    check(`${what}: ${id} sits below the last line of the text`, () => {
      assert.ok(m.receipts[id].y >= m.texts[id].y + m.texts[id].h - 1,
        `receipt y ${m.receipts[id].y} vs text bottom ${m.texts[id].y + m.texts[id].h}`);
    });
  }
}

console.log('\nthe state row is between the log and the composer');
for (const state of ['working', 'waiting', 'stopped']) {
  check(`the ${state} row is below the log and above the composer`, () => {
    assert.ok(wide.rows[state].y >= wide.logBottom - 1, 'row is above the log');
    assert.ok(wide.rows[state].y < wide.composer, 'row is below the composer');
  });
}

console.log('\nthe mark is the shared one, and it zooms with the pane');
check('working runs ov-spin on a braille glyph from the contract', () => {
  assert.equal(wide.marks.working.animation, 'ov-spin');
  assert.match(wide.marks.working.content, /[⠋⠙⠹⠸⠼⠴⠦⠧]/);
});
for (const state of ['waiting', 'stopped']) {
  check(`${state} draws the completed path, not a glyph`, () => {
    assert.equal(wide.marks[state].animation, 'none');
    assert.equal(wide.marks[state].content, '""');
    assert.ok(wide.marks[state].borderWidth >= 1, `stroke ${wide.marks[state].borderWidth}px`);
  });
}
for (const state of ['working', 'waiting', 'stopped']) {
  check(`${state}'s mark doubles when the pane doubles`, () => {
    const ratio = zoomed.marks[state].fontSize / wide.marks[state].fontSize;
    assert.ok(Math.abs(ratio - 2) < 0.05, `13px -> ${wide.marks[state].fontSize}px, 26px -> ${zoomed.marks[state].fontSize}px`);
  });
  check(`${state}'s mark is not pinned to the contract's absolute 12.5px`, () => {
    assert.notEqual(zoomed.marks[state].fontSize, 12.5);
  });
}
check('the mark is sized off the row, not off the root', () => {
  // 0.96em of 13px: close to the 12.5px the contract measures, on purpose.
  assert.ok(Math.abs(wide.marks.working.fontSize - 12.48) < 0.2, `${wide.marks.working.fontSize}px`);
});

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
