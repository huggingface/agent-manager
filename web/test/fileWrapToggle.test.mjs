// The wrap control is a toggle, not another fact in the file metadata strip.
// Its visual selected state and its accessible pressed state must always tell
// the same story. CodeMirror wrapping is covered elsewhere; this test pins the
// small piece that is easy to regress while restyling the control.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'file-wrap-toggle.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/FileWrapToggle.tsx')],
  outfile: out, format: 'esm', bundle: true, jsx: 'automatic', logLevel: 'error',
  external: ['react', 'react/jsx-runtime'],
});
const { default: FileWrapToggle } = await import(pathToFileURL(out).href);

const render = (wrap) => renderToStaticMarkup(createElement(FileWrapToggle, {
  wrap, onChange: () => {},
}));
const off = render(false);
const on = render(true);

assert.match(off, /^<span class="seg file-wrap-toggle mono">/);
assert.match(off, /<button[^>]*class=""[^>]*aria-pressed="false"/);
assert.doesNotMatch(off, /class="on"/);
assert.match(on, /<button[^>]*class="on"[^>]*aria-pressed="true"/);

let next = null;
const offElement = FileWrapToggle({ wrap: false, onChange: (value) => { next = value; } });
offElement.props.children.props.onClick();
assert.equal(next, true);
const onElement = FileWrapToggle({ wrap: true, onChange: (value) => { next = value; } });
onElement.props.children.props.onClick();
assert.equal(next, false);

console.log('file-wrap-toggle: accessible, visual, and next states agree');
