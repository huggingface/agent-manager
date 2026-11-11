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

// Which surfaces have opted in. #92 shipped the frame to the sidebar, both pane
// headers and the mock, and deliberately left Overview on the old standalone
// mark; the operator has since asked for Overview too, so all three of its
// state slots — card, tile and the group's peek strip — are frames now.
//
// What that settled is about IDENTITY slots: wherever a session is named, its
// state is drawn as a frame around its logo, never as a mark beside the name.
// The state-classed `.status` mark is not dead — it is the app's spinner and
// still-path vocabulary — and the remote pane's running line renders it, which
// is not an identity slot but a line of the conversation saying what the agent
// is doing. That one renderer is pinned below so the exemption stays a single
// known place rather than a hole.
//
// This one reads source rather than rendering, because Overview needs the whole
// API surface to mount. It is written to survive reformatting: it counts and
// looks for absence, never for an attribute order or a whole JSX line.
const overview = fs.readFileSync(path.join(HERE, '../src/components/Overview.tsx'), 'utf8');
const frames = (overview.match(/<StateLogo\b/g) || []).length;
assert.ok(frames >= 3, `Overview should draw a frame in all three slots, found ${frames}`);
assert.ok(/frameOnly/.test(overview), 'the group strip has no icon to frame, so it needs the frame-only form');
const STATE_MARK = /className=\{?[`"']status [^`"']*\$\{/g;
for (const file of ['components/Overview.tsx', 'components/Sidebar.tsx', 'components/TerminalPane.tsx',
  'components/Locked.tsx']) {
  const text = fs.readFileSync(path.join(HERE, '../src', file), 'utf8');
  assert.doesNotMatch(text, STATE_MARK, `${file} still renders a state-classed .status mark`);
}
// The one exemption, kept honest: exactly one mark, and it is the running line's
// — not a state slipped in beside the pane's name, which is what the frame is
// for. If a second one appears here, this fails and someone has to justify it.
{
  const remote = fs.readFileSync(path.join(HERE, '../src/components/RemotePane.tsx'), 'utf8');
  const marks = remote.match(STATE_MARK) || [];
  assert.equal(marks.length, 1, `RemotePane draws ${marks.length} state-classed marks, expected exactly the running line's`);
  assert.match(remote, /cx-running[^]{0,200}className=\{`status \$\{state\}`\}/,
    'the mark is not inside the running line');
  assert.match(remote, /<StateLogo\b/, 'the pane header still needs its identity frame');
}

console.log('state-logo: real tiles keep logos, 12px legend frames are border-only, and every state slot is a frame');
