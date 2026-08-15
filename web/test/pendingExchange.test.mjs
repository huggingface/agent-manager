// The prompt you just sent, before the transcript catches up — and the one
// thing about it that can silently break.
//
// `.cx-prompt` carries `margin-left: -1.23em`, which exists ONLY to cancel the
// matching `padding-left` on the `.cx` section around it. Written as a loose
// band with no section, that negative margin has nothing to cancel and the
// newest prompt in a conversation hangs a gutter's width left of every prompt
// above it — 16px at the base size, its ❯ half off the pane on a phone. That
// was live in both the reader and the Overview card, and nothing failed.
//
// So this pins the nesting, not the pixels: the echo is a `.cx` section with the
// band inside it, the same shape ExchangeView gives a real turn. Same style as
// exchanges.test.mjs — esbuild is already here for vite, so the component is
// transpiled and rendered with react-dom/server. Run with:
//   node test/pendingExchange.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Inside node_modules, not os.tmpdir(): react stays external to the bundle, so
// the output has to sit somewhere that can resolve it.
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'exchange.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/conversation/Exchange.tsx')],
  outfile: out, format: 'esm', bundle: true, jsx: 'automatic', logLevel: 'error',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { PendingExchange, ExchangeView } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const html = render(PendingExchange, { text: 'what changed in the deploy config?' });

console.log('the echo is an exchange, not a loose band');
check('it is wrapped in a .cx section — the padding that cancels the band’s margin',
  () => assert.match(html, /^<section class="cx">/));
check('the prompt band is INSIDE that section, never a sibling of it',
  () => assert.match(html, /^<section class="cx">\s*<div class="cx-prompt">/));
check('…and the section closes after it, so nothing escapes the wrapper',
  () => assert.match(html, /<\/section>$/));
check('the prompt text is the prompt you sent',
  () => assert.match(html, />what changed in the deploy config\?</));
check('a working line rides inside the same section',
  () => assert.match(html, /<div class="cx-running mono">working<\/div>\s*<\/section>/));

console.log('\nand it has the shape of the turn it becomes a second later');
// A real turn at the same moment the echo represents: asked, not yet answered.
// (No answer also keeps renderMarkdown out of it — DOMPurify needs a DOM, and
// this test is about the wrapper, not about markdown.)
const turn = {
  key: 'x1', at: 1, startTs: 1_700_000_000_000, endTs: 1_700_000_030_000, tokens: 0, toolCalls: 0,
  prompt: { role: 'user', ts: 1_700_000_000_000, blocks: [{ type: 'text', text: 'what changed in the deploy config?' }] },
  steps: [], answer: [],
};
const real = render(ExchangeView, { x: turn, n: 1, total: 1 });
check('a real turn opens with the same wrapper',
  () => assert.match(real, /^<section class="cx">/));
check('with its prompt band in the same place',
  () => assert.match(real, /^<section class="cx">\s*<div class="cx-prompt">/));
check('so the echo and the turn share one left edge',
  () => assert.equal(html.slice(0, html.indexOf('cx-prompt')), real.slice(0, real.indexOf('cx-prompt'))));

console.log('\nand the CSS pair the nesting exists for is still a pair');
const css = fs.readFileSync(path.join(HERE, '../src/conversation.css'), 'utf8');
check('.cx pays out the gutter in em', () => assert.match(css, /\.cx\s*\{[^}]*padding:[^;]*1\.23em/));
check('.cx-prompt takes it back, by the same amount',
  () => assert.match(css, /\.cx-prompt\s*\{[^}]*margin-left:\s*-1\.23em/));
check('and no px restatement of that gutter has crept back in',
  () => assert.doesNotMatch(css, /\.cxv-body\s*>\s*\.cxv-col\s*>\s*\.cx\s*\{[^}]*padding-left/));

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
