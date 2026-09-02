// The remote pane's state line and its message receipts, in a browser.
//
// Two things here cannot be checked by reading the source:
//
//   1. The receipt sits at the foot of the message it belongs to, and `pending`
//      and the tick occupy exactly the same height. That equality is the whole
//      reason a log pinned to the newest message does not jump when a receipt
//      lands mid-read — the two states are different kinds of thing (small
//      italic text, and a glyph box) and only a layout engine can say whether
//      they came out the same size.
//   2. The state mark scales with the pane's zoom. The pane threads one font
//      size through log, state line and composer; the shared mark contract is
//      em-based apart from one absolute anchor (--mark-size), so the state line
//      redefines that anchor in em. If someone later gives it a px value the
//      mark silently stops following the zoom control, and nothing else breaks.
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
const embeddedFont = `@font-face {
  font-family: 'Geist Mono Test'; font-style: normal; font-weight: 100 900;
  src: url(data:font/woff2;base64,${geistMono}) format('woff2');
}
:root { --font-mono: 'Geist Mono Test'; }
.status.working::before, .rp-mark.working::before, .cx-running::before { animation: none !important; }`;

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// The markup RemotePane renders, at two zoom levels. `pending` and `ack` carry
// the same message text so any height difference is the receipt's alone.
const pane = (fontSize, id) => `
  <div class="slot" id="${id}" style="width:420px">
    <div class="rp-body" style="font-size:${fontSize}">
      <div class="rp-user" id="${id}-pending">
        <span class="rp-caret">❯</span>
        <div class="rp-user-body">
          <span class="rp-user-text">rerun the failing suite and paste the first error you see</span>
          <span class="rp-receipt"><span class="rp-pending">pending</span></span>
        </div>
      </div>
      <div class="rp-user" id="${id}-ack">
        <span class="rp-caret">❯</span>
        <div class="rp-user-body">
          <span class="rp-user-text">rerun the failing suite and paste the first error you see</span>
          <span class="rp-receipt"><svg class="rp-ack" viewBox="0 0 16 16"><path d="M2 9l3.5 3.5"/></svg></span>
        </div>
      </div>
      <div class="rp-agent" id="${id}-agent"><p>on it</p></div>
    </div>
    <div class="rp-state-line" style="font-size:${fontSize}">
      <span class="rp-mark working" id="${id}-mark"></span>
      <span class="rp-state working" id="${id}-word">working</span>
    </div>
    <div class="rp-composer" style="font-size:${fontSize}"><span class="rp-caret">❯</span></div>
  </div>`;

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
await page.setContent(`<style>${css}\n${embeddedFont}</style>
  ${pane('13px', 'z100')}
  ${pane('26px', 'z200')}
  <div class="cx-running mono" id="trace" style="font-size:13px">working</div>`);
await page.waitForTimeout(120);

const m = await page.evaluate(() => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    const b = e.getBoundingClientRect();
    return { w: b.width, h: b.height, left: b.left, top: b.top, bottom: b.bottom };
  };
  const before = (sel, prop) => getComputedStyle(document.querySelector(sel), '::before').getPropertyValue(prop);
  // The rendered text's own box, not its container's — the container is a flex
  // column as wide as the block, so its edges say nothing about the glyphs.
  const textBox = (sel) => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(sel));
    return r.getBoundingClientRect();
  };
  const textLeft = (sel) => textBox(sel).left;
  return {
    pend100: box('#z100-pending'), ack100: box('#z100-ack'),
    pend200: box('#z200-pending'), ack200: box('#z200-ack'),
    receipt100: box('#z100-pending .rp-receipt'),
    msgText100: textLeft('#z100-pending .rp-user-text'),
    msgTextBottom100: textBox('#z100-pending .rp-user-text').bottom,
    receiptText100: textLeft('#z100-pending .rp-pending'),
    mark100: box('#z100-mark'), mark200: box('#z200-mark'),
    markContent: before('#z100-mark', 'content'),
    traceContent: before('#trace', 'content'),
    word100: box('#z100-word'),
    line100: box('#z100 .rp-state-line'),
    body100: box('#z100 .rp-body'),
    composer100: box('#z100 .rp-composer'),
    lineBg: getComputedStyle(document.querySelector('#z100 .rp-state-line')).backgroundColor,
    bodyBg: getComputedStyle(document.querySelector('#z100 .rp-body')).backgroundColor,
    lineBorderTop: getComputedStyle(document.querySelector('#z100 .rp-state-line')).borderTopWidth,
  };
});

console.log('\na receipt does not change the height of the message it is on');
check('pending and acknowledged are the same height at 100%', () => {
  assert.equal(Math.round(m.pend100.h), Math.round(m.ack100.h));
});
check('…and at 200% zoom, where a fixed-px receipt would drift', () => {
  assert.equal(Math.round(m.pend200.h), Math.round(m.ack200.h));
});
check('the block really did grow with the zoom (so the check above is not vacuous)', () => {
  assert.ok(m.pend200.h > m.pend100.h * 1.5, `${m.pend100.h} → ${m.pend200.h}`);
});

console.log('\nthe receipt is under the message, on its text column');
check('it starts below the last line of the message, not beside it', () => {
  assert.ok(m.receipt100.top >= m.msgTextBottom100 - 0.5,
    `receipt top ${m.receipt100.top.toFixed(1)} vs message text bottom ${m.msgTextBottom100.toFixed(1)}`);
});
check('and starts on the message text column, not the caret gutter', () => {
  assert.ok(Math.abs(m.receiptText100 - m.msgText100) < 1.5,
    `receipt at ${m.receiptText100}, text at ${m.msgText100}`);
});

console.log('\nthe state mark is the trace reader\'s braille, and it scales with the pane');
check('the mark draws the same braille glyph the trace widget draws', () => {
  assert.equal(m.markContent, m.traceContent);
  assert.equal(m.markContent.replace(/"/g, ''), '⠋');
});
check('the mark doubles when the pane font doubles', () => {
  const ratio = m.mark200.w / m.mark100.w;
  assert.ok(Math.abs(ratio - 2) < 0.06, `width ratio ${ratio.toFixed(3)} (${m.mark100.w} → ${m.mark200.w})`);
});

console.log('\nthe line reads as the last line of the log, not as another bar');
check('it sits between the log and the composer', () => {
  assert.ok(m.line100.top >= m.body100.bottom - 1, `line ${m.line100.top} vs log bottom ${m.body100.bottom}`);
  assert.ok(m.line100.bottom <= m.composer100.top + 1, `line ${m.line100.bottom} vs composer ${m.composer100.top}`);
});
check('on the log\'s own background, with no rule above it', () => {
  assert.equal(m.lineBg, m.bodyBg);
  assert.equal(m.lineBorderTop, '0px');
});

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
