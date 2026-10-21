// Codex "code mode" in the reader: the server unpacks each `exec` script into
// the tool calls it made, and the steps must then read like the classic format
// (`exec_command`, `view_image ×2`, `apply_patch`), never as raw JavaScript.
// The turns come from the server's own parser over its fixture, so the two
// sides are checked together. Run with:  node test/codexCodeMode.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.XDG_DATA_HOME = path.join(TMP, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

// Inside node_modules, not TMP: react stays external, so the output has to sit
// somewhere that can resolve it.
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const bundle = async (entry, name) => {
  const out = path.join(outDir, `codemode-${name}`);
  await build({ entryPoints: [path.join(HERE, entry)], outfile: out, format: 'esm', bundle: true, logLevel: 'error',
    jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
  return import(pathToFileURL(out).href);
};
const { splitExchanges, stepsOf, stepText, argSummary } = await bundle('../src/components/conversation/exchanges.ts', 'exchanges.mjs');
const { default: ToolCall } = await bundle('../src/components/conversation/ToolCall.tsx', 'toolcall.mjs');
const { readTraceByPath } = await import(pathToFileURL(path.join(HERE, '../../server/src/traces.js')).href);

const page = await readTraceByPath(path.join(HERE, '../../server/test/fixtures/codex-code-mode.jsonl'));
const [x] = splitExchanges(page.turns);
const steps = stepsOf(x.steps);
const tools = steps.filter((s) => s.kind === 'tools');

assert.deepEqual(steps.filter((s) => s.kind !== 'note').map((s) => (s.kind === 'tools' ? `${s.name}×${s.count}` : s.kind)), [
  'exec_command×1', 'view_image×1', 'image', 'view_image×1', 'image', 'exec_command×1', 'write_stdin×1', 'apply_patch×1', 'script×1',
], 'one step per tool as in the classic format, each image after the call that viewed it');
assert.equal(tools[0].details[0], 'rg --files looks/frames', 'an exec_command reads as its command');
assert.deepEqual([tools[1].details, tools[2].details], [['…/ref/sheet-primeintellect.png'], ['…/ref/sheet-thom_wolf.png']]);
assert.equal(tools[5].details[0], 'Added …/edit/astra-feedback-v2.md (+3 -0)', 'a patch reads as the file it touched');
assert.equal(tools[6].details[0], 'Ran a script', 'an unparsable snippet is a script, not a line of code');
assert.ok(tools.every((s) => !s.pending), 'every unpacked call has its result');
assert.ok(tools.every((s) => !s.details.some((d) => /tools\.|await /.test(d))), 'no raw JavaScript in a label');

// A classic apply_patch carries the same text, so it reads the same way.
assert.equal(argSummary('*** Begin Patch\n*** Update File: /w/a.txt\n@@\n-a\n+b\n*** End Patch'), 'Edited /w/a.txt (+1 -1)');

// Image data is not searchable text.
assert.ok(steps.every((s) => !stepText(s).includes('base64')), 'no base64 in search text');

// Expanded, an exec_command shows its command, and the script shows its code.
const cmdHtml = renderToStaticMarkup(createElement(ToolCall, { name: 'exec_command', text: tools[0].blocks[0].text }));
assert.match(cmdHtml, /class="cs-pre ct-cmd">rg --files looks\/frames</);
const scriptHtml = renderToStaticMarkup(createElement(ToolCall, { name: 'script', text: tools[6].blocks[0].text }));
assert.match(scriptHtml, /Ran a script/);
assert.match(scriptHtml, /<pre class="cs-pre">const xs=\[3,1,2\]\.sort\(\);\ntext\(xs\.join\(&quot;,&quot;\)\);\n<\/pre>/);

fs.rmSync(TMP, { recursive: true, force: true });
console.log('codexCodeMode: ok');
