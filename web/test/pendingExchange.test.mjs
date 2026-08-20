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
// band inside it, the same shape ExchangeView gives a real turn. The rest of the
// file pins the other two things about an exchange that are order, not style:
// where the answer sits among the steps, and that the turn column does not step
// sideways when the count gains a digit. Same style as
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
// Markdown is stubbed, not rendered: sanitising wants a DOM, and what these
// checks are about is which order the blocks come out in, not what marked does
// with a paragraph. Everything else is the real component.
const stubMarkdown = {
  name: 'stub-markdown',
  setup(b) {
    b.onResolve({ filter: /lib\/markdown$/ }, () => ({ path: 'markdown-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const renderMarkdown = (md) => `<p>${md}</p>`;', loader: 'js',
    }));
  },
};
await build({
  entryPoints: [path.join(HERE, '../src/components/conversation/Exchange.tsx')],
  outfile: out, format: 'esm', bundle: true, jsx: 'automatic', logLevel: 'error',
  external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [stubMarkdown],
});
const { PendingExchange, ExchangeView } = await import(pathToFileURL(out).href);
const attachmentsOut = path.join(outDir, 'attachments.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/attachments.ts')],
  outfile: attachmentsOut, format: 'esm', bundle: true, logLevel: 'error',
});
const { buildPendingPrompt } = await import(pathToFileURL(attachmentsOut).href);
const { formatAttachmentDelivery } = await import(
  pathToFileURL(path.join(HERE, '../../server/src/attachments.js')).href);
// stepSummary decides whether a turn has a left half at all, so the two live in
// the same check: no summary → the facts ride the working line.
const exOut = path.join(outDir, 'exchanges-meta.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/conversation/exchanges.ts')],
  outfile: exOut, format: 'esm', bundle: false, logLevel: 'error',
});
const { stepSummary, stepsOf: stepsOfEx } = await import(pathToFileURL(exOut).href);
const stepSummaryOf = (x) => stepSummary(x, stepsOfEx(x.steps));

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

console.log('\nand an attached prompt is complete on its first paint');
const screenshot = { kind: 'image', path: '/state/attachments/reader/Screenshot 1.png' };
const pendingPrompt = buildPendingPrompt('codex', 'compare this with the mock', [screenshot]);
const attachedHtml = render(PendingExchange, { text: pendingPrompt.displayText });
check('the optimistic exchange includes the Attached files line immediately', () => {
  assert.match(attachedHtml, /compare this with the mock/);
  assert.match(attachedHtml, /Attached files:/);
  assert.match(attachedHtml, /Screenshot 1\.png/);
});
check('transcript catch-up still matches the operator text, not CLI path syntax',
  () => assert.equal(pendingPrompt.text, 'compare this with the mock'));
check('an attachment-only image uses the same screenshot fallback as the server',
  () => assert.match(buildPendingPrompt('claude', '', [screenshot]).displayText,
    /^Please inspect the attached screenshot\.\n\nAttached files:/));
check('Gemini gets its actual @ path form rather than an invented Attached files label', () => {
  const gemini = buildPendingPrompt('gemini', 'inspect it', [screenshot]).displayText;
  assert.match(gemini, /\n\n@"\/state\/attachments\/reader\/Screenshot 1\.png"$/);
  assert.doesNotMatch(gemini, /Attached files:/);
});
check('the optimistic formatter stays identical to the server delivery contract', () => {
  const file = { kind: 'file', path: '/state/attachments/reader/notes from review.md' };
  for (const cli of ['claude', 'codex', 'gemini', 'hermes']) {
    for (const [text, attachments] of [['look here', [screenshot, file]], ['', [screenshot]], ['', [file]]]) {
      assert.equal(
        buildPendingPrompt(cli, text, attachments).displayText,
        formatAttachmentDelivery(cli, text, attachments),
        `${cli}: ${text || '(attachment only)'}`,
      );
    }
  }
});
check('both optimistic send surfaces render the complete display text', () => {
  const reader = fs.readFileSync(path.join(HERE, '../src/components/conversation/ConversationView.tsx'), 'utf8');
  const overview = fs.readFileSync(path.join(HERE, '../src/components/Overview.tsx'), 'utf8');
  assert.match(reader, /buildPendingPrompt\(session\.cli, text, uploaded\)/);
  assert.match(reader, /<PendingExchange text=\{sent\.displayText\}/);
  assert.match(overview, /buildPendingPrompt\(s\.cli, text, uploaded\)/);
  assert.match(overview, /<PendingExchange text=\{sent\.displayText\}/);
});

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

console.log('\nand an answer that was not last renders where it was said');
// The agent answered and then kept working: `answerAt` puts the reply between
// the work it followed and the work it promised, instead of under both.
const midTurn = {
  key: 'x2', at: 2, startTs: 1_700_000_000_000, endTs: 1_700_000_090_000, tokens: 0, toolCalls: 2,
  prompt: { role: 'user', ts: 1_700_000_000_000, blocks: [{ type: 'text', text: 'fix the nightly job' }] },
  steps: [
    { role: 'assistant', ts: 1_700_000_010_000, blocks: [{ type: 'tool_use', name: 'Bash', text: '{"command":"explain analyze"}' }] },
    { role: 'assistant', ts: 1_700_000_050_000, blocks: [{ type: 'tool_use', name: 'Edit', text: '{"file_path":"014.sql"}' }] },
  ],
  answer: [{ role: 'assistant', ts: 1_700_000_030_000, kind: 'final', blocks: [{ type: 'text', text: 'Found it — adding the index now.' }] }],
  answerAt: 1,
};
const mid = render(ExchangeView, { x: midTurn, n: 2, total: 2, open: true });
check('the work it followed is above the answer',
  () => assert.ok(mid.indexOf('explain analyze') < mid.indexOf('Found it'), 'Bash should precede the answer'));
check('the work it promised is below the answer',
  () => assert.ok(mid.indexOf('Found it') < mid.indexOf('014.sql'), 'the Edit should follow the answer'));
check('so the steps render as two runs, not one',
  () => assert.equal((mid.match(/class="cx-steps"/g) || []).length, 2));
// answerAt can be 0 — the agent answered before it did anything — and 0 is the
// value a falsy guard drops. With `!at` in place of `at == null` every other
// check here still passes and this one does not, which is the point of it.
check('an answer given BEFORE the work renders above all of it', () => {
  const first = render(ExchangeView, {
    x: { ...midTurn, answerAt: 0, answer: [{ role: 'assistant', ts: 1_700_000_005_000, kind: 'final', blocks: [{ type: 'text', text: 'I will add one now.' }] }] },
    n: 2, total: 2, open: true,
  });
  assert.ok(first.indexOf('I will add one now') < first.indexOf('explain analyze'),
    'the answer should precede the first tool row');
  assert.ok(first.indexOf('explain analyze') < first.indexOf('014.sql'),
    'and the work should stay in its own order below it');
  assert.equal((first.match(/class="cx-steps"/g) || []).length, 1,
    'nothing above the answer, so one run of steps below it');
});

check('an answer that IS last still renders one run of steps', () => {
  const plain = render(ExchangeView, { x: { ...midTurn, answerAt: undefined, answer: midTurn.answer }, n: 2, total: 2, open: true });
  assert.equal((plain.match(/class="cx-steps"/g) || []).length, 1);
});

console.log('\nand the turn column holds still as the count gains a digit');
const turnCell = (n, total) => {
  const html = render(ExchangeView, { x: { ...midTurn, answerAt: undefined }, n, total });
  return (html.match(/class="cx-n">([^<]*)</) || [])[1];
};
check('a single digit is padded to the width of the total', () => {
  const nine = turnCell(9, 10);
  assert.ok(nine.includes('\u2007'), `expected a figure space in ${JSON.stringify(nine)}`);
  assert.equal(nine.replace(/\u2007/g, '').trim(), 'turn 9/10');
});
check('and the padded cell is exactly as wide as the widest one', () => {
  assert.equal(turnCell(9, 10).length, turnCell(10, 10).length);
});
check('a session that never reaches ten pads nothing',
  () => assert.equal(turnCell(3, 9), 'turn 3/9'));

console.log('\nand the meta row lines up in the two states that have no work');
// Both reported from dev. A turn with nothing yet — no steps, no duration, no
// tokens — used to render an empty meta row above the working line, which read
// as the widget sitting "weirdly low"; and a finished turn with no tool calls
// used to indent its summary into the gutter where the expand triangle would be,
// for a triangle that cannot exist in that state.
const emptyTurn = {
  key: 'x9', at: 9, startTs: 1_700_000_000_000, endTs: 1_700_000_000_000, tokens: 0, toolCalls: 0,
  prompt: { role: 'user', ts: 1_700_000_000_000, blocks: [{ type: 'text', text: 'now look at the packer' }] },
  steps: [], answer: [],
};
const quietTurn = {
  ...emptyTurn, key: 'x8', at: 8, endTs: 1_700_000_013_000, tokens: 188,
  prompt: { role: 'user', ts: 1_700_000_000_000, blocks: [{ type: 'text', text: "that's nice" }] },
  answer: [{ role: 'assistant', ts: 1_700_000_013_000, kind: 'final', blocks: [{ type: 'text', text: 'Quiet turn, then.' }] }],
};
check('a turn with nothing yet has no summary to show', () => {
  assert.equal(stepSummaryOf(emptyTurn), '', 'an empty turn should summarise to nothing');
});
check('so while it works, the facts ride the working line and there is no empty row', () => {
  const html = render(ExchangeView, { x: emptyTurn, n: 9, total: 9, running: true });
  assert.ok(!html.includes('class="cx-meta'), 'no meta row should be rendered');
  const run = html.slice(html.indexOf('cx-running'));
  assert.match(run, /class="cx-n"/, 'the turn number should be on the working line');
  assert.match(run, /class="cx-time"/, 'and the clock with it');
});
check('the working line is still the last thing in the turn', () => {
  const html = render(ExchangeView, { x: emptyTurn, n: 9, total: 9, running: true });
  assert.ok(html.lastIndexOf('cx-running') > html.lastIndexOf('cx-prompt'));
});
check('once there is a summary the facts are back on the meta row', () => {
  const html = render(ExchangeView, { x: { ...emptyTurn, endTs: emptyTurn.startTs + 31_000, tokens: 4300 }, n: 9, total: 9, running: true });
  const meta = html.slice(html.indexOf('cx-meta'), html.indexOf('cx-running'));
  assert.match(meta, /class="cx-n"/, 'the facts belong to the meta row as soon as it exists');
  const run = html.slice(html.indexOf('cx-running'));
  assert.ok(!run.includes('class="cx-n"'), 'and not on the working line as well');
});
check('a finished turn with no tool calls says so with a flat fold', () => {
  const html = render(ExchangeView, { x: quietTurn, n: 8, total: 9 });
  assert.match(html, /class="cx-fold flat"/, 'no steps means nothing to unfold');
  assert.match(html, /13s/);
});

console.log('\nand nothing reserves the gutter for a control that cannot exist');
{
  const css = fs.readFileSync(path.join(HERE, '../src/conversation.css'), 'utf8');
  const rule = (sel) => { const i = css.indexOf(sel); return i < 0 ? null : css.slice(i, css.indexOf('}', i) + 1); };
  check('a flat fold has no left padding at all', () => {
    const r = rule('.cx-fold.flat {');
    assert.ok(r, 'no .cx-fold.flat rule');
    assert.doesNotMatch(r, /padding-left/, `a flat summary must start on the text column: ${r}`);
  });
  check('and an expandable one hangs its triangle by exactly the mark cell', () => {
    assert.match(rule('.cx-fold {') || '', /margin-left:\s*calc\(-1 \* var\(--cx-mark\)\)/);
    assert.match(rule('.cx-meta {') || '', /--cx-mark:/);
  });
  check('the facts on the working line are pushed right, like on the meta row', () => {
    // the DOM assertions above pass whether or not this exists; without it the
    // row renders "workingturn 3/301:02 PM", which only a screenshot shows
    assert.match(rule('.cx-meta .spacer, .cx-running .spacer {') || '', /flex:\s*1/);
    assert.match(rule('.cx-running .cx-model, .cx-running .cx-n, .cx-running .cx-time {') || '', /margin-left/);
  });
  check('the working line hangs its spinner the same way', () => {
    assert.match(rule('.cx-running {') || '', /margin-left:\s*calc\(-1 \* var\(--mark-w\)\)/);
  });
}

console.log('\nand the end of the conversation is spaced like the conversation');
// Reported from prod: "an additional newline at the end of the reader view".
// It was not a margin and not an empty node — the last block already carries
// `margin-bottom: 0` and the tail held no elements at all. It was `.cxv-body`'s
// own bottom padding, 30px, chosen when the reader's bottom edge was the pane's
// rather than a composer's border. These pin the three parts of the answer.
{
  const conv = fs.readFileSync(path.join(HERE, '../src/conversation.css'), 'utf8');
  const shared = fs.readFileSync(path.join(HERE, '../src/styles.css'), 'utf8');
  const rule = (css, sel) => { const i = css.indexOf(sel); return i < 0 ? null : css.slice(i, css.indexOf('}', i) + 1); };
  check('the scroller pays its tail from a variable, not a number in the shorthand', () => {
    const r = rule(conv, '.cxv-body {');
    assert.ok(r, 'no .cxv-body rule');
    assert.match(r, /--cx-tail:\s*12px/);
    assert.match(r, /padding:\s*4px var\(--cx-gutter\) var\(--cx-tail\)/);
  });
  check('and that tail IS the paragraph rhythm, not a number that happens to be near it', () => {
    const tail = (rule(conv, '.cxv-body {').match(/--cx-tail:\s*(\d+)px/) || [])[1];
    const para = (rule(shared, '.markdown p {').match(/margin:\s*0 0 (\d+)px/) || [])[1];
    assert.equal(tail, para, `tail ${tail}px vs paragraph spacing ${para}px — they must agree`);
  });
  check('the phone rule narrows the gutter and restates nothing else', () => {
    const i = conv.indexOf('@media (max-width: 720px)');
    const block = conv.slice(i, conv.indexOf('\n}', i));
    const bodyRule = rule(block, '.cxv-body {');
    assert.ok(bodyRule, 'the phone block should still set the gutter');
    assert.match(bodyRule, /--cx-gutter:\s*8px/);
    assert.doesNotMatch(bodyRule, /padding/, `a second padding here is how the phone drifts: ${bodyRule}`);
  });
  check('and the last rendered block still adds no margin of its own', () => {
    assert.match(rule(conv, '.cx-md > :last-child {') || '', /margin-bottom:\s*0/);
  });
}

console.log('\nand the CSS pair the nesting exists for is still a pair');
const css = fs.readFileSync(path.join(HERE, '../src/conversation.css'), 'utf8');
check('.cx pays out the gutter in em', () => assert.match(css, /\.cx\s*\{[^}]*padding:[^;]*1\.23em/));
check('.cx-prompt takes it back, by the same amount',
  () => assert.match(css, /\.cx-prompt\s*\{[^}]*margin-left:\s*-1\.23em/));
check('and no px restatement of that gutter has crept back in',
  () => assert.doesNotMatch(css, /\.cxv-body\s*>\s*\.cxv-col\s*>\s*\.cx\s*\{[^}]*padding-left/));

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
