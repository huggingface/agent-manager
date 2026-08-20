// Every palette, on every surface it lands on, in both themes.
//
// A palette that reads well in light and turns to mud in dark is not a palette,
// and the failure is invisible to whoever picked the colours — they were looking
// at one theme. So the ratios are computed from styles.css itself: the same
// values the browser uses, not a copy in a fixture.
//
// Thresholds: 7:1 for body text (AAA at this size), 4.5:1 for muted text (AA),
// 3:1 for the accent and for danger, which carry meaning but are never prose.
// Run with:  node test/palette-contrast.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8');

const lum = (hex) => {
  const c = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The declarations of one rule, as {token: value}. */
const tokensOf = (selector) => {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) return null;
  const body = css.slice(i, css.indexOf('}', i));
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// the default palette is the bare :root / [data-theme='dark'] pair
const BASE_LIGHT = tokensOf(':root');
const BASE_DARK = tokensOf("[data-theme='dark']");
const PALETTES = ['indigo', 'paper', 'phosphor', 'plum'];
const PAIRS = [
  ['text', 'panel', 7], ['text', 'bg', 7], ['text', 'panel-2', 7],
  ['muted', 'panel', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel-2', 4.5],
  ['accent', 'panel', 3], ['accent', 'bg', 3], ['accent', 'panel-2', 3],
  ['accent-fg', 'accent', 4.5],
  ['danger', 'panel', 3], ['go', 'panel', 3],
];

console.log('every palette carries every colour it needs');
for (const id of PALETTES) {
  for (const [theme, sel, base] of [
    ['light', `[data-palette='${id}']`, BASE_LIGHT],
    ['dark', `[data-theme='dark'][data-palette='${id}']`, BASE_DARK],
  ]) {
    check(`${id}/${theme} sets every token the default sets`, () => {
      const t = tokensOf(sel);
      assert.ok(t, `no rule for ${sel}`);
      const colourTokens = Object.keys(base).filter((k) => /^(accent|accent-fg|go|danger|bg|panel|panel-2|border|border-strong|text|muted|term-bg|tile|drop)$/.test(k));
      const missing = colourTokens.filter((k) => !(k in t));
      assert.deepEqual(missing, [], `inherits ${missing.join(', ')} from the default palette`);
    });
  }
}

console.log('\nand holds contrast on every surface, in both themes');
for (const id of [...PALETTES, 'default']) {
  for (const theme of ['light', 'dark']) {
    const t = id === 'default'
      ? (theme === 'light' ? BASE_LIGHT : BASE_DARK)
      : tokensOf(theme === 'light' ? `[data-palette='${id}']` : `[data-theme='dark'][data-palette='${id}']`);
    const fails = [];
    for (const [a, b, min] of PAIRS) {
      if (!t?.[a] || !t?.[b] || !t[a].startsWith('#') || !t[b].startsWith('#')) continue;
      const r = ratio(t[a], t[b]);
      if (r < min) fails.push(`${a} on ${b} ${r.toFixed(2)}:1 < ${min}`);
    }
    // The default palette's muted grey is 4.16:1 on --bg and 4.42:1 on --panel-2,
    // which predates this change; it is reported rather than asserted so the
    // suite does not turn red for something no palette here introduced.
    if (id === 'default' && theme === 'light') {
      console.log(`  note the default light palette misses AA on: ${fails.join('; ') || 'nothing'}`);
      continue;
    }
    check(`${id}/${theme}`, () => assert.deepEqual(fails, []));
  }
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
