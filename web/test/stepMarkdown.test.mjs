// Intermediate messages render as markdown — and a truncated one cannot take the
// panel down with it.
//
// Only the ANSWER used to be rendered (`highlightHtml(renderMarkdown(answer))`),
// so an agent's mid-turn message — which is written with headings, lists, code
// spans and links like everything else it writes — was shown as raw syntax. The
// prose kinds (`note`, `think`, `compact`) now take the same path.
//
// Two things are worth pinning rather than eyeballing:
//   1. these messages carry a `more` tail, so `full` can end mid-fence or
//      mid-table, and a renderer that emits an unclosed <pre> would swallow
//      everything after it in the panel;
//   2. the rendered prose must sit in the step's BODY, not in its head row —
//      that row is a <button>, and links inside a button are neither valid nor
//      clickable.
// Run with:  node test/stepMarkdown.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { marked } from 'marked';

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const balanced = (html, tag) =>
  (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length === (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;

console.log('a message cut mid-markdown still closes its blocks');
for (const [what, md] of [
  ['a fence cut open', 'The plan:\n\n```js\nconst rows = await db.all("SELECT 1")\nconst next = rows.map('],
  ['a table cut mid-row', '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |'],
  ['a list cut mid-item', '- read the generator\n- merge by `name`\n- cap the candid'],
  ['a heading cut mid-word', '## Pla'],
]) {
  check(`${what} → balanced pre/code/table`, () => {
    const html = marked.parse(md, { async: false });
    for (const tag of ['pre', 'code', 'table', 'ul', 'ol']) {
      assert.ok(balanced(html, tag), `${tag} left open by: ${what}`);
    }
  });
}
check('an unterminated code span stays literal rather than eating the rest', () => {
  const html = marked.parse('I will edit `server/src/runner and then stop', { async: false });
  assert.ok(!html.includes('<code>'), `expected no code element, got ${html}`);
});

// ---- which kinds are prose, and which must stay literal. This is the scope
// decision itself, as a pure function — the browser is where the rendered output
// and the search highlight over it are checked, because `highlightHtml` walks
// text nodes with DOMParser and node has no DOM.
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const exOut = path.join(outDir, 'exchanges-md.mjs');
await build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/conversation/exchanges.ts')],
  outfile: exOut, format: 'esm', bundle: false, logLevel: 'error',
});
const { proseOf, stepsOf, oneLine } = await import(pathToFileURL(exOut).href);

console.log('\nand nothing is inserted at the top of a rendered message');
// Reported from dev: "it seems to add an empty line at the beginning when
// expanded". Three candidates were plausible and only one was true — the blank
// line was the head ROW, which had handed its text to the body and still took a
// line (fixed in CSS below). These pin the two candidates that were NOT the
// cause, because a future renderer swap could make either one real:
for (const [what, md] of [
  ['a message that starts with a blank line', '\n\nAnswer to your question: **yes**.\n\nMore.'],
  ['one that starts with blank lines and spaces', '   \n\n  Answer with an indent.'],
  ['one that starts straight in', 'Answer to your question: **yes**.'],
]) {
  check(`${what} → no empty node at the top`, () => {
    const html = marked.parse(md, { async: false });
    assert.doesNotMatch(html, /^<p>\s*<\/p>/, `leading empty paragraph: ${html.slice(0, 60)}`);
    assert.match(html.trim(), /^<(p|h[1-6]|ul|ol|pre|blockquote|table)[ >]/, `starts with something odd: ${html.slice(0, 60)}`);
  });
}
check('and the collapsed preview trims it too, so the two agree', () => {
  assert.equal(oneLine('\n\n  Answer to your question: yes.', 90), 'Answer to your question: yes.');
});

console.log('\nand an open note does not spend a line on an empty head row');
// The actual cause: a note has no label, so once its text moved to the body the
// head row held nothing but a triangle — and still took a line. Open, the step is
// two columns, so the triangle sits beside the first line instead of above it.
{
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/conversation.css'), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(sel);
    return i < 0 ? null : css.slice(i, css.indexOf('}', i) + 1);
  };
  check('.cs.note.open lays out in two columns', () => {
    const r = rule('.cs.note.open {');
    assert.ok(r, 'no .cs.note.open rule');
    assert.match(r, /display:\s*grid/);
    assert.match(r, /grid-template-columns:\s*auto/);
  });
  check('…with the emptied detail slot taken out of the flow', () => {
    assert.match(rule('.cs.note.open > .cs-head .cs-detail {') || '', /display:\s*none/);
  });
  check('…and no top padding left above the first block', () => {
    assert.match(rule('.cs.note.open > .cs-body {') || '', /padding:\s*0/);
  });
  check('a labelled prose step keeps the stacked layout — its row is not empty', () => {
    assert.equal(rule('.cs.think.open {'), null, 'think should not have gained the grid');
  });
}

console.log('\nand only the agent\u2019s own prose goes through the renderer');
const proseKinds = [
  ['note', { kind: 'note', text: '## Plan\n\n- read `runner.js`' }, true],
  ['think', { kind: 'think', text: 'weighing **poll** against `fs.watch`' }, true],
  ['compact', { kind: 'compact', text: 'Context compacted. **Kept**: the plan.' }, true],
  ['tools', { kind: 'tools', name: 'Read', count: 1, details: ['runner.js'], failed: false, blocks: [] }, false],
  ['shell', { kind: 'shell', command: 'ls -la', out: 'total 4  -rw-r--r--' }, false],
  ['image', { kind: 'image', src: 'data:image/png;base64,AA' }, false],
];
for (const [kind, step, isProse] of proseKinds) {
  check(`${kind.padEnd(7)} ${isProse ? 'renders' : 'stays literal'}`,
    () => assert.equal(proseOf(step) !== '', isProse));
}
check('a tool result is not prose either — two spaces there mean two spaces', () => {
  const [step] = stepsOf([{ role: 'assistant', ts: 1, blocks: [
    { type: 'tool_use', name: 'Bash', text: '{"command":"ls"}' },
    { type: 'tool_result', text: 'a.md   b.md', failed: false },
  ] }]);
  assert.equal(proseOf(step), '', 'a tools step carries no prose');
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
