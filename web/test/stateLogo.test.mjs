// Component behaviour for the icon-frame status. CSS differences are measured
// in stateLogo.render.test.mjs; this suite pins the rendered structure and
// geometry without depending on JSX attribute order or stylesheet source text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Children } from 'react';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'state-logo.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/StateLogo.tsx')],
  outfile: out, format: 'esm', bundle: true, jsx: 'automatic', logLevel: 'error',
  external: ['react', 'react/jsx-runtime'],
});
const { default: StateLogo } = await import(pathToFileURL(out).href);

const STATES = ['working', 'waiting', 'idle', 'stopped'];
const rendered = Object.fromEntries(STATES.map((state) => [state, StateLogo({
  cli: 'codex', state, size: 12, tint: '#5eb6a6', title: state,
})]));

for (const state of STATES) {
  const frame = rendered[state];
  assert.equal(frame.props.className, `state-logo ${state}`);
  assert.deepEqual(frame.props.style, { width: 18, height: 18 });
  assert.equal(frame.props.title, state);

  const [logo, svg] = Children.toArray(frame.props.children);
  assert.equal(logo.props.cli, 'codex');
  assert.equal(logo.props.size, 12);
  assert.equal(logo.props.tint, '#5eb6a6');
  assert.equal(svg.props.viewBox, '0 0 18 18');
  assert.equal(svg.props['aria-hidden'], 'true');

  const rects = Children.toArray(svg.props.children);
  assert.equal(rects.length, state === 'working' ? 2 : 1);
  for (const rect of rects) {
    assert.equal(rect.props.x, '0.5');
    assert.equal(rect.props.y, '0.5');
    assert.equal(rect.props.width, 17);
    assert.equal(rect.props.height, 17);
    assert.equal(rect.props.rx, 4);
    assert.equal(rect.props.pathLength, '96');
  }
  assert.equal(rects.at(-1).props.className,
    state === 'working' ? 'state-logo-run' : 'state-logo-static');
}

// The legend uses the same SVG renderer at a true 12px outer size, but carries
// no fake CLI identity. Regular rows above still prove the default keeps Logo.
for (const state of STATES) {
  const frame = StateLogo({ frameOnly: true, state, size: 12 });
  assert.deepEqual(frame.props.style, { width: 12, height: 12 });
  const children = Children.toArray(frame.props.children);
  assert.equal(children.length, 1, `${state} legend frame contains no Logo`);
  const [svg] = children;
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props.viewBox, '0 0 12 12');
  for (const rect of Children.toArray(svg.props.children)) {
    assert.equal(rect.props.width, 11);
    assert.equal(rect.props.height, 11);
  }
}

const workingRects = Children.toArray(
  Children.toArray(rendered.working.props.children)[1].props.children,
);
assert.equal(workingRects[0].props.className, 'state-logo-track');

// The same component scales to the 22px pane-header tile. Inspecting the Logo
// child as rendered proves both layers agree on the shared 3px padding rather
// than pinning the helper's source spelling.
const header = StateLogo({ cli: 'codex', state: 'idle', size: 16, tint: '#5eb6a6' });
assert.deepEqual(header.props.style, { width: 22, height: 22 });
const [headerLogo, headerSvg] = Children.toArray(header.props.children);
const paintedLogo = headerLogo.type(headerLogo.props);
assert.equal(paintedLogo.props.style.width, 16);
assert.equal(paintedLogo.props.style.height, 16);
assert.equal(paintedLogo.props.style.padding, 3);
assert.equal(headerSvg.props.viewBox, '0 0 22 22');

console.log('state-logo: real tiles keep logos and 12px legend frames contain only the shared border');
