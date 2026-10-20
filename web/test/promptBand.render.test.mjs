// What the prompt band actually does once its text is markdown, in a browser.
//
// The band is delicate in three ways that source lint cannot see, and all three
// are the reason this file exists rather than a fourth set of CSS assertions:
//
//   1. its left edge. `.cx-prompt` carries `margin-left: -1.23em` against `.cx`'s
//      matching padding (#77), and a block element inside it — a <p>, a <ul>, a
//      <pre> — is exactly the kind of thing that undoes that pairing. The text
//      of a rendered prompt has to start on the same pixel as the text of a raw
//      one, and on the same pixel as the answer below it.
//   2. its height. The band is a tinted strip read as rhythm; a paragraph's
//      default margins would have added a fraction of a line to every turn in
//      the reader. A one-line prompt must occupy exactly what it occupied as
//      plain text — including when it carries the `queued` pill.
//   3. what a prompt with a code fence or a long list does to a band designed
//      for one line of text: it must not widen the column or scroll it sideways.
//
// Real components, real marked, real DOMPurify: the bundle is built for the
// browser and rendered inside the page, so what is measured is the markup the
// app ships and not a hand-written approximation of it.
//
// am-test: manual — needs Chromium; run with `npm run test:render`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const css = ['styles.css', 'conversation.css']
  .map((f) => fs.readFileSync(path.join(WEB, 'src', f), 'utf8')).join('\n');

const outDir = path.join(WEB, 'node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const bundle = path.join(outDir, 'prompt-band.js');
await build({
  stdin: {
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import ExchangeView, { PendingExchange } from './src/components/conversation/Exchange';
      window.__pending = (text) => renderToStaticMarkup(createElement(PendingExchange, { text }));
      window.__turn = (props) => renderToStaticMarkup(createElement(ExchangeView, props));
    `,
    resolveDir: WEB, loader: 'tsx', sourcefile: 'prompt-band-entry.tsx',
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
});

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
// The reader's own frame: the band is full-bleed inside .cxv-col, so measuring it
// anywhere else would measure a different rule.
await page.setContent(`<style>${css}
  .cxv-body { width: 640px; height: 860px; }
  .cx-running::before { animation: none !important; }</style>
  <div class="cxv-body"><div class="cxv-col" id="col"></div></div>`);
await page.addScriptTag({ path: bundle });

const ONE = 'restart the nightly job';
// The band as it rendered before this change: raw text, pre-wrap, no inner block.
const raw = (text) => `<section class="cx"><div class="cx-prompt" style="white-space:pre-wrap">${text}</div></section>`;
const turnOf = (text, extra = {}) => ({
  x: {
    key: 'x1', at: 1, startTs: 1_700_000_000_000, endTs: 1_700_000_030_000, tokens: 0, toolCalls: 0,
    prompt: { role: 'user', ts: 1_700_000_000_000, blocks: [{ type: 'text', text }], ...(extra.prompt || {}) },
    steps: [], answer: extra.answer ?? [],
  },
  n: 1, total: 1, ...(extra.props || {}),
});

/** Put markup in the column and hand back what a browser makes of it. */
const measure = (html, fn) => page.evaluate(({ html, body }) => {
  const col = document.getElementById('col');
  col.innerHTML = html;
  // The first character's own rect, not the block's: a block's left edge is its
  // border box, and the whole question here is where the TEXT starts.
  const firstCharLeft = (el) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      if (!node.data.trim()) continue;
      const r = document.createRange();
      const i = node.data.length - node.data.trimStart().length;
      r.setStart(node, i); r.setEnd(node, i + 1);
      const rect = r.getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    }
    return null;
  };
  // eslint-disable-next-line no-new-func
  return new Function('col', 'firstCharLeft', body)(col, firstCharLeft);
}, { html, body: `return (${fn.toString()})(col, firstCharLeft);` });

const geom = (html) => measure(html, (col, firstCharLeft) => {
  const band = col.querySelector('.cx-prompt');
  const b = band.getBoundingClientRect();
  const t = firstCharLeft(band);
  return {
    height: b.height, bandLeft: b.left, bandRight: b.right,
    textLeft: t.left, textTop: t.top,
    colScroll: col.scrollWidth, colClient: col.clientWidth,
    html: band.outerHTML,
  };
});

console.log('a rendered prompt starts on the same pixel as a raw one');
const rawOne = await geom(raw(ONE));
const mdOne = await geom(await page.evaluate((t) => window.__pending(t), ONE));
check(`the text's left edge is unchanged (${rawOne.textLeft} → ${mdOne.textLeft})`,
  () => assert.equal(mdOne.textLeft, rawOne.textLeft));
check(`the band's own left edge is unchanged (${rawOne.bandLeft})`,
  () => assert.equal(mdOne.bandLeft, rawOne.bandLeft));
check(`and it is still full-bleed to the right (${rawOne.bandRight})`,
  () => assert.equal(mdOne.bandRight, rawOne.bandRight));
check(`a one-line prompt is exactly as tall as it was (${rawOne.height}px)`,
  () => assert.equal(mdOne.height, rawOne.height));
check('the paragraph is really there — the height is not an unrendered string',
  () => assert.match(mdOne.html, /<div class="markdown cx-pmd"><p>restart the nightly job<\/p>\s*<\/div>/));
// The band is full-bleed: it reaches into the column's gutter on both sides by
// design, so the column ALWAYS reports a wider scroll width than client width —
// 626 against 612 here. That is the number a wide prompt must not move.
check(`the column's own overflow is the band's bleed and nothing else (${rawOne.colScroll} of ${rawOne.colClient})`,
  () => assert.equal(mdOne.colScroll, rawOne.colScroll));

console.log('\nand its words line up with the answer under it');
const withAnswer = await measure(
  await page.evaluate((t) => window.__turn(t), turnOf(ONE, {
    answer: [{ role: 'assistant', ts: 1_700_000_020_000, kind: 'final', blocks: [{ type: 'text', text: 'Restarted it.' }] }],
  })),
  (col, firstCharLeft) => ({
    prompt: firstCharLeft(col.querySelector('.cx-prompt')).left,
    answer: firstCharLeft(col.querySelector('.cx-answer')).left,
  }));
check(`prompt and answer share one text column (${withAnswer.prompt})`,
  () => assert.equal(withAnswer.prompt, withAnswer.answer));

console.log('\nand the newlines someone typed are still where they typed them');
const THREE = 'three things:\nthe reader\nthe card\nthe echo';
const rawThree = await geom(raw(THREE));
const mdThree = await geom(await page.evaluate((t) => window.__pending(t), THREE));
check(`four typed lines stay four lines (${rawThree.height}px)`,
  () => assert.equal(mdThree.height, rawThree.height));
check('as <br>, because a person’s newline is not a soft wrap',
  () => assert.equal((mdThree.html.match(/<br>/g) || []).length, 3));

console.log('\nand the queue pill still trails the last line');
const queued = await measure(
  await page.evaluate((t) => window.__turn(t), turnOf(ONE, { prompt: { queued: true } })),
  (col, firstCharLeft) => {
    const band = col.querySelector('.cx-prompt');
    const pill = col.querySelector('.cx-queued').getBoundingClientRect();
    const text = firstCharLeft(band);
    return { height: band.getBoundingClientRect().height, pillTop: pill.top, pillLeft: pill.left, textTop: text.top, textRight: text.right };
  });
check(`a queued one-liner is no taller than any other (${mdOne.height}px)`,
  () => assert.equal(queued.height, mdOne.height));
check('the pill sits on that line, not under it',
  () => assert.ok(Math.abs(queued.pillTop - queued.textTop) < 6,
    `pill top ${queued.pillTop} vs text top ${queued.textTop}`));
check('and to the right of the words, where it always was',
  () => assert.ok(queued.pillLeft > queued.textRight, `${queued.pillLeft} should be right of ${queued.textRight}`));

console.log('\nand a prompt that is not one line of text stays inside the band');
// One line far wider than any pane: the point of the fence check is what a band
// does with content it cannot fit, so the content has to be unfittable.
const FENCE = 'this keeps failing:\n\n```\nnpm run build --workspace web\nError: EACCES: permission denied, mkdir \'/usr/local/lib/node_modules/.vite-temp/agent-manager/web/dist/assets/index-8f2c1a44.js\' — retried three times with the same result\n```\n\nwhat do you make of it?';
const fence = await measure(await page.evaluate((t) => window.__pending(t), FENCE), (col) => {
  const band = col.querySelector('.cx-prompt');
  const pre = col.querySelector('.cx-prompt pre');
  const cs = getComputedStyle(band);
  return {
    inside: pre.getBoundingClientRect().right <= band.getBoundingClientRect().right - parseFloat(cs.paddingRight) + 0.5,
    preScrolls: pre.scrollWidth > pre.clientWidth,
    // Line boxes, counted: `line-height: normal` computes to a keyword, so
    // dividing the height by it gives NaN.
    preLines: (() => { const r = document.createRange(); r.selectNodeContents(pre); return r.getClientRects().length; })(),
    colScroll: col.scrollWidth,
    tag: pre.firstElementChild?.tagName,
  };
});
check('the fence is a <pre><code> block, rendered rather than shown as backticks',
  () => assert.equal(fence.tag, 'CODE'));
check('it stops at the band’s padding rather than bleeding past it',
  () => assert.ok(fence.inside, 'the fence overflows the band'));
// The band held raw text until now, so a pasted error was fully on screen. A
// fence that scrolled instead would hide the end of it behind a horizontal drag
// — on a phone, inside a slab a third of the screen wide. It wraps instead.
check(`a line too long for the pane wraps rather than hiding (${fence.preLines} lines)`,
  () => assert.ok(!fence.preScrolls && fence.preLines >= 3,
    `scrolls=${fence.preScrolls}, lines=${fence.preLines}`));
check('and never scrolls the reader column sideways',
  () => assert.equal(fence.colScroll, rawOne.colScroll));

const LIST = 'please do all of these:\n\n- restart the nightly job\n- then check the trace for the EACCES line\n- and tell me whether the deploy config changed\n\nin that order.';
const list = await measure(await page.evaluate((t) => window.__pending(t), LIST), (col, firstCharLeft) => {
  const band = col.querySelector('.cx-prompt');
  const items = [...col.querySelectorAll('.cx-prompt li')];
  return {
    count: items.length,
    intro: firstCharLeft(band).left,
    item: firstCharLeft(items[0]).left,
    colScroll: col.scrollWidth,
  };
});
check('a list is a list', () => assert.equal(list.count, 3));
check(`its items are indented from the prompt's own column (${list.intro} → ${list.item})`,
  () => assert.ok(list.item > list.intro && list.item - list.intro < 40,
    `items at ${list.item} against text at ${list.intro}`));
check('and it does not scroll the column either',
  () => assert.equal(list.colScroll, rawOne.colScroll));

console.log('\nand a search term still lands in it');
const hit = await measure(
  await page.evaluate((t) => window.__turn(t), turnOf('restart the **nightly** job', { props: { q: 'nightly' } })),
  (col) => {
    const marks = [...col.querySelectorAll('.cx-prompt mark.cx-hit')];
    return {
      marks: marks.map((m) => m.textContent),
      insideStrong: marks.every((m) => !!m.closest('strong')),
      html: col.querySelector('.cx-pmd').innerHTML,
    };
  });
check('the term is marked inside the rendered prompt',
  () => assert.deepEqual(hit.marks, ['nightly']));
check('…through the markdown, not over it — the emphasis survives the highlight',
  () => assert.ok(hit.insideStrong, hit.html));
check('and the syntax itself is gone from the band',
  () => assert.doesNotMatch(hit.html, /\*\*/));

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
