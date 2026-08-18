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
const { proseOf, stepsOf } = await import(pathToFileURL(exOut).href);

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
