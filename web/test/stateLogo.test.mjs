// The selected status study option makes the CLI tile itself the state mark:
// working = a seamless four-cell loop, idle = accent frame, stopped = a very
// quiet grey frame. This pins both the drawing contract and the three places
// that opted into it; Overview deliberately keeps its existing marks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const css = read('styles.css');

const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'state-logo.mjs');
await build({
  entryPoints: [path.join(SRC, 'components/StateLogo.tsx')],
  outfile: out, format: 'esm', bundle: true, jsx: 'automatic', logLevel: 'error',
  external: ['react', 'react/jsx-runtime'],
});
const { default: StateLogo } = await import(pathToFileURL(out).href);

const render = (state, size = 12) => renderToStaticMarkup(createElement(StateLogo, {
  cli: 'codex', state, size, tint: '#5eb6a6', title: state,
}));
const working = render('working');
const idle = render('idle');
const stopped = render('stopped');

// Logo's 12px glyph + 3px shared tile padding = the production 18px sidebar
// frame. The stroke is centred at .5 and reaches exactly 0..18 on every edge.
assert.match(working, /^<span class="state-logo working" style="width:18px;height:18px"/);
assert.match(working, /viewBox="0 0 18 18"/);
assert.equal((working.match(/<rect/g) || []).length, 2, 'working needs a track and moving dashes');
assert.match(working, /class="state-logo-track" x="0.5" y="0.5" width="17" height="17" rx="4" pathLength="96"/);
assert.match(working, /class="state-logo-run" x="0.5" y="0.5" width="17" height="17" rx="4" pathLength="96"/);
for (const [state, markup] of [['idle', idle], ['stopped', stopped]]) {
  assert.equal((markup.match(/<rect/g) || []).length, 1, `${state} must be static`);
  assert.match(markup, /class="state-logo-static"/);
  assert.doesNotMatch(markup, /state-logo-(track|run)/);
}

assert.match(css, /\.state-logo-run\s*\{[^}]*stroke-dasharray:\s*20 4;[^}]*animation:\s*state-logo-trace 0\.92s linear infinite;/s);
assert.match(css, /@keyframes state-logo-trace\s*\{\s*to\s*\{\s*stroke-dashoffset:\s*-24;/s);
assert.match(css, /\.state-logo-frame rect\s*\{[^}]*stroke-width:\s*1;[^}]*vector-effect:\s*non-scaling-stroke;/s);
assert.match(css, /\.state-logo\.waiting, \.state-logo\.idle\s*\{\s*color:\s*var\(--accent\);/s);
assert.match(css, /\.state-logo\.stopped\s*\{\s*color:\s*color-mix\(in srgb, var\(--muted\) 50%, transparent\);/s);

// The frame and the tile consume one geometry function. A later logo padding
// adjustment therefore cannot leave the state border behind.
const logo = read('components/Logo.tsx');
const stateLogo = read('components/StateLogo.tsx');
assert.match(logo, /export const logoTilePadding/);
assert.match(logo, /padding:\s*logoTilePadding\(size, tint\)/);
assert.match(stateLogo, /logoTilePadding\(size, tint\)/);
assert.match(stateLogo, /logoTileRadius\(size\)/);

const sidebar = read('components/Sidebar.tsx');
const terminal = read('components/TerminalPane.tsx');
const remote = read('components/RemotePane.tsx');
const locked = read('components/Locked.tsx');
const overview = read('components/Overview.tsx');

assert.match(sidebar, /<StateLogo[\s\S]*?cli=\{s\.cli\}[\s\S]*?state=\{s\.state\}[\s\S]*?size=\{12\}/);
assert.match(terminal, /<StateLogo[\s\S]*?cli=\{session\.cli\}[\s\S]*?state=\{session\.state\}[\s\S]*?size=\{16\}/);
assert.match(remote, /<StateLogo cli="remote" state=\{state\} size=\{16\}/);
assert.match(locked, /<StateLogo cli=\{s\.cli\} state=\{s\.state\} size=\{12\}/);
assert.doesNotMatch(terminal, /className=\{`status \$\{session\.state\}`\}/);
assert.doesNotMatch(remote, /className=\{`status \$\{state\}`\}/);
assert.doesNotMatch(sidebar, /status ov-spacer/);
assert.doesNotMatch(locked, /status ov-spacer/);

// Three legend examples, matching the selected working / idle / off study.
for (const state of ['working', 'idle', 'stopped']) {
  assert.match(sidebar, new RegExp(`<StateLogo cli="shell" state="${state}" size=\\{12\\}`));
  assert.match(locked, new RegExp(`<StateLogo cli="shell" state="${state}" size=\\{12\\}`));
}

// This PR is intentionally scoped: Overview's denser cards keep their current
// standalone state treatment.
assert.match(overview, /className=\{`status \$\{s\.state\}`\}/);

console.log('state-logo: geometry, states, and target surfaces agree');
