// The remote pane's running line and its message receipts, in a browser.
//
// The running line is not a lookalike of the reader's — it is the reader's, the
// same `.cx-running` class rendered inside the remote log, so there is one
// spinner in the app rather than two that drift apart. What this pins is that
// the two really do come out the same, and that the one declaration the remote
// log neutralises (the reader's pull into its mark gutter) is the only
// difference. A copy would pass a source lint and still look wrong; only a
// layout engine can say the two lines match.
//
// Unlike the reader's, this line is always present: a remote agent always has a
// state worth reading. So it also pins that only `working` moves, and that the
// resting states are the same mark holding still rather than a second design.
//
// It also pins the receipts: `pending` and the tick occupy exactly the same
// height, which is what keeps a bottom-pinned log from jumping when a receipt
// lands mid-read.
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
/* Frozen, not disabled: the animation still reports its name (which is what the
   "only working moves" checks read) but every frame reads as the first one, so
   asserting the glyph is not a race against the clock. */
.status.working::before, .cx-running::before { animation-play-state: paused; }`;

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const message = (receipt) => `
  <div class="rp-user">
    <span class="rp-caret">❯</span>
    <div class="rp-user-body">
      <span class="rp-user-text">rerun the failing suite and paste the first error you see</span>
      <span class="rp-receipt">${receipt}</span>
    </div>
  </div>`;
const TICK = '<svg class="rp-ack" viewBox="0 0 16 16"><path d="M2 9l3.5 3.5"/></svg>';
const PENDING = '<span class="rp-pending">pending</span>';
const run = (state, label) => `<div class="cx-running mono rp-run"><span class="status ${state}"></span>${label}</div>`;

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
// The reader and the remote log, drawing the same line, at the same base size.
await page.setContent(`<style>${css}\n${embeddedFont}</style>
  <div class="cxv" style="--cx-base:13px;width:420px">
    <div class="cx">
      <div class="cx-prompt">rerun the failing suite</div>
      <div class="cx-answer"><div class="markdown cx-md"><p>Running it now.</p></div></div>
      <div class="cx-running mono" id="reader-run">working</div>
    </div>
  </div>
  <div class="rp-body" id="log" style="font-size:13px;width:420px;height:200px">
    ${message(PENDING)}
    <div class="rp-agent" id="last-msg"><p>Running it now.</p></div>
    ${run('working', 'working').replace('<div class=', '<div id="pane-run" class=')}
  </div>
  <div class="rp-body" id="log-listening" style="font-size:13px;width:420px">
    <div class="rp-agent"><p>Done.</p></div>
    ${run('waiting', 'listening').replace('<div class=', '<div id="listening-run" class=')}
  </div>
  <div class="rp-body" id="log-off" style="font-size:13px;width:420px">
    <div class="rp-agent"><p>Done.</p></div>
    ${run('stopped', 'not connected').replace('<div class=', '<div id="off-run" class=')}
  </div>
  <div class="rp-body" id="heights" style="font-size:13px;width:420px">
    ${message(PENDING).replace('class="rp-user"', 'id="h-pending" class="rp-user"')}
    ${message(TICK).replace('class="rp-user"', 'id="h-ack" class="rp-user"')}
  </div>
  <div class="rp-body" id="heights2" style="font-size:26px;width:420px">
    ${message(PENDING).replace('class="rp-user"', 'id="h2-pending" class="rp-user"')}
    ${message(TICK).replace('class="rp-user"', 'id="h2-ack" class="rp-user"')}
  </div>`);
await page.waitForTimeout(150);

const m = await page.evaluate(() => {
  const box = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { w: b.width, h: b.height, top: b.top, left: b.left, bottom: b.bottom }; };
  const read = (id) => {
    const e = document.getElementById(id);
    const cs = getComputedStyle(e);
    const markEl = e.querySelector('.status');
    const bf = markEl ? getComputedStyle(markEl, '::before') : getComputedStyle(e, '::before');
    const markCs = markEl ? getComputedStyle(markEl) : null;
    // The word itself, not the element: the pane's line has the mark span as its
    // first child, so selecting the whole element would start the range at the
    // mark and report 0 where the reader reports the cell's width.
    const textNode = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).pop();
    const r = document.createRange(); r.selectNode(textNode);
    const word = r.getBoundingClientRect();
    return {
      gapAbove: +(e.getBoundingClientRect().top - e.previousElementSibling.getBoundingClientRect().bottom).toFixed(2),
      fontSize: cs.fontSize, color: cs.color, marginLeft: cs.marginLeft,
      borderTopWidth: cs.borderTopWidth, background: cs.backgroundColor,
      spinner: { content: bf.content, width: bf.width, height: bf.height,
        color: markCs ? markCs.color : bf.color, animation: bf.animationName },
      markBox: markEl ? { w: +markEl.getBoundingClientRect().width.toFixed(2) } : null,
      ownBefore: getComputedStyle(e, '::before').content,
      wordOffset: +(word.left - e.getBoundingClientRect().left).toFixed(2),
    };
  };
  const log = document.getElementById('log');
  return {
    reader: read('reader-run'), pane: read('pane-run'),
    lastChildIsRun: log.lastElementChild.id === 'pane-run',
    runInsideLog: log.contains(document.getElementById('pane-run')),
    listening: read('listening-run'), off: read('off-run'),
    pend: box('#h-pending'), ack: box('#h-ack'),
    pend2: box('#h2-pending'), ack2: box('#h2-ack'),
    receiptLeft: box('#h-pending .rp-receipt').left,
    receiptTop: box('#h-pending .rp-receipt').top,
    textLeft: (() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#h-pending .rp-user-text')); return r.getBoundingClientRect().left; })(),
    textBottom: (() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#h-pending .rp-user-text')); return r.getBoundingClientRect().bottom; })(),
  };
});

console.log('\nthe running line is the reader\'s line, in this log');
check('it lives inside the log, as its last child', () => {
  assert.ok(m.runInsideLog, 'the line is not inside the scrollable log');
  assert.ok(m.lastChildIsRun, 'the line is not the last thing in the log');
});
check('nothing divides it from the message above — no rule, no band', () => {
  assert.equal(m.pane.borderTopWidth, '0px');
  assert.equal(m.pane.background, 'rgba(0, 0, 0, 0)');
});
check('it sits exactly as far below its message as the reader\'s does', () => {
  assert.equal(m.pane.gapAbove, m.reader.gapAbove);
});
check('same type size, same colour, same word position as the reader', () => {
  assert.equal(m.pane.fontSize, m.reader.fontSize, 'type size');
  assert.equal(m.pane.color, m.reader.color, 'colour');
  assert.equal(m.pane.wordOffset, m.reader.wordOffset,
    `word offset: reader ${m.reader.wordOffset}, pane ${m.pane.wordOffset}`);
});
check('and while working, literally the reader\'s spinner — glyph, cell, animation', () => {
  assert.equal(m.pane.spinner.content, m.reader.spinner.content);
  assert.equal(m.pane.spinner.width, m.reader.spinner.width);
  assert.equal(m.pane.spinner.height, m.reader.spinner.height);
  assert.equal(m.pane.spinner.color, m.reader.spinner.color);
  assert.equal(m.pane.spinner.animation, m.reader.spinner.animation);
});
check('the only declaration that differs is the reader\'s pull into its gutter', () => {
  assert.notEqual(m.pane.marginLeft, m.reader.marginLeft);
  assert.equal(m.pane.marginLeft, '0px');
  assert.match(m.reader.marginLeft, /^-/);
});
console.log('\nall three states use the line; only working moves');
check('listening and not connected draw in the same place, the same way', () => {
  for (const s of [m.listening, m.off]) {
    assert.equal(s.fontSize, m.pane.fontSize);
    assert.equal(s.wordOffset, m.pane.wordOffset);
    assert.equal(s.color, m.pane.color);
  }
});
check('only working animates — the resting states hold still', () => {
  assert.equal(m.pane.spinner.animation, 'ov-spin');
  assert.equal(m.listening.spinner.animation, 'none');
  assert.equal(m.off.spinner.animation, 'none');
});
check('the resting mark is the traced path, not a frozen braille frame', () => {
  for (const s of [m.listening, m.off]) assert.equal(s.spinner.content, '""');
  assert.equal(m.pane.spinner.content, '"⠋"');
});
check('the mark carries the state: accent while the agent is there, grey once gone', () => {
  assert.equal(m.listening.spinner.color, m.pane.spinner.color);
  assert.notEqual(m.off.spinner.color, m.pane.spinner.color);
});
check('the line does not also draw the reader\'s own spinner behind the mark', () => {
  assert.equal(m.pane.ownBefore, 'none');
});
check('every state occupies the same cell, so the word never shifts', () => {
  assert.equal(m.listening.markBox.w, m.pane.markBox.w);
  assert.equal(m.off.markBox.w, m.pane.markBox.w);
});

console.log('\na receipt does not change the height of the message it is on');
check('pending and acknowledged are the same height', () => {
  assert.equal(Math.round(m.pend.h), Math.round(m.ack.h));
});
check('…and at 200% zoom, where a fixed-px receipt would drift', () => {
  assert.equal(Math.round(m.pend2.h), Math.round(m.ack2.h));
});
check('the block really did grow with the zoom (so the check above is not vacuous)', () => {
  assert.ok(m.pend2.h > m.pend.h * 1.5, `${m.pend.h} → ${m.pend2.h}`);
});
check('the receipt starts below the message text, on its text column', () => {
  assert.ok(m.receiptTop >= m.textBottom - 0.5,
    `receipt top ${m.receiptTop.toFixed(1)} vs message text bottom ${m.textBottom.toFixed(1)}`);
  assert.ok(Math.abs(m.receiptLeft - m.textLeft) < 0.5,
    `receipt at ${m.receiptLeft}, text at ${m.textLeft}`);
});

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
