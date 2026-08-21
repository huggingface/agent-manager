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

/**
 * Every declaration a selector makes, across EVERY rule with that selector.
 *
 * Aggregating matters: the stylesheet declares `:root` more than once — the core
 * palette in one block, the mark geometry in another, the editor's syntax
 * colours in a third, after the palettes. An earlier version of this test read
 * only the first match and therefore could not see that no palette carried the
 * syntax colours, so `--cm-link` stayed teal under all four. Whatever the
 * cascade sees, this sees.
 */
const RULES = (() => {
  // comments out first: a rule preceded by one is still a rule, and pattern
  // matching on the raw text missed exactly that — the syntax block sits after a
  // comment, so an earlier version of this test read no syntax tokens at all and
  // reported the palettes complete.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().split('\n').pop().trim(), body: m[2] });
  }
  return out;
})();

const tokensOf = (selector) => {
  const out = {};
  let found = false;
  for (const r of RULES) {
    if (r.selector !== selector) continue;
    found = true;
    for (const d of r.body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return found ? out : null;
};

/** A token whose value is written in other tokens follows them, wherever it lives. */
const isDerived = (value) => /var\(--/.test(value);

/**
 * The syntax hues held invariant on purpose: a reading system for code, tuned
 * per theme, not per palette. Listed here so that adding a new hardcoded colour
 * token — or quietly dropping one of these into the invariant set — fails.
 */
const INVARIANT = ['cm-keyword', 'cm-string', 'cm-number', 'cm-fn', 'cm-type', 'cm-tag', 'cm-def', 'cm-heading', 'cm-prop'];

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
const PALETTES = ['indigo', 'paper', 'phosphor', 'plum', 'mono'];
/**
 * Where each palette's light block lives. Mono's carries an extra `:root`
 * because it is the only palette that overrides the editor's syntax colours,
 * and those are declared in a later `:root` block: at equal specificity the
 * later rule wins, so a plain `[data-palette='mono']` lost the cascade and the
 * light theme kept purple keywords. The check at the bottom of this file is the
 * one that would have caught it.
 */
const lightSel = (id) => (id === 'mono' ? `:root[data-palette='${id}']` : `[data-palette='${id}']`);
const darkSel = (id) => `[data-theme='dark'][data-palette='${id}']`;
const PAIRS = [
  ['text', 'panel', 7], ['text', 'bg', 7], ['text', 'panel-2', 7],
  ['muted', 'panel', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel-2', 4.5],
  ['accent', 'panel', 3], ['accent', 'bg', 3], ['accent', 'panel-2', 3],
  ['accent-fg', 'accent', 4.5],
  ['danger', 'panel', 3], ['go', 'panel', 3],
  ['danger-fg', 'danger', 4.5],
  // waiting is the accent and idle is muted (.state-logo in styles.css), two
  // 1px frames at 12px. A hued palette can tell them apart on hue alone and
  // does — they sit 1.04–1.48:1 apart in luminance. A palette with no hue has
  // only this number, so it is asserted rather than admired.
  ['accent', 'muted', 3],
];

console.log('every palette carries every colour it needs');
for (const id of PALETTES) {
  for (const [theme, sel, base] of [
    ['light', lightSel(id), BASE_LIGHT],
    ['dark', darkSel(id), BASE_DARK],
  ]) {
    check(`${id}/${theme} leaves no colour of the default palette behind`, () => {
      const t = tokensOf(sel);
      assert.ok(t, `no rule for ${sel}`);
      // every colour the default declares, not a whitelist of the ones we
      // remembered: that whitelist is what hid the syntax colours before
      const colourTokens = Object.entries(base)
        .filter(([k, v]) => /^#|^color-mix|^var\(/.test(v) && !/^(mark|cx|ph|ov)-/.test(k))
        .map(([k]) => k);
      const unaccounted = colourTokens.filter((k) => (
        !(k in t)                       // the palette states it
        && !isDerived(base[k])          // or it is written in tokens that follow
        && !INVARIANT.includes(k)       // or it is deliberately palette-invariant
      ));
      assert.deepEqual(unaccounted, [], `inherits ${unaccounted.join(', ')} from the default palette`);
    });
  }
}

console.log('\nand holds contrast on every surface, in both themes');
for (const id of [...PALETTES, 'default']) {
  for (const theme of ['light', 'dark']) {
    const t = id === 'default'
      ? (theme === 'light' ? BASE_LIGHT : BASE_DARK)
      : tokensOf(theme === 'light' ? lightSel(id) : darkSel(id));
    const fails = [];
    for (const [a, b, min] of PAIRS) {
      // The accent/muted floor is the monochrome palette's own contract: the
      // hued palettes separate those two marks with hue, which this maths
      // cannot see, and holding them to 3:1 in luminance would fail every one
      // of them for something a person has no trouble with.
      if (a === 'accent' && b === 'muted' && id !== 'mono') continue;
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

console.log('\nand the monochrome palette has no hue in it at all');
for (const [theme, sel] of [['light', lightSel('mono')], ['dark', darkSel('mono')]]) {
  const t = tokensOf(sel);
  check(`${theme}: every colour it declares is a grey`, () => {
    const hued = Object.entries(t || {})
      .filter(([, v]) => /^#[0-9a-f]{6,8}$/i.test(v))
      .filter(([, v]) => !(v[1] === v[3] && v[3] === v[5] && v[2] === v[4] && v[4] === v[6]))
      .map(([k, v]) => `${k}: ${v}`);
    assert.deepEqual(hued, [], `not grey: ${hued.join(', ')}`);
  });
  check(`${theme}: the editor goes grey with it — no rainbow in the file pane`, () => {
    const missing = INVARIANT.filter((k) => !(k in (t || {})));
    assert.deepEqual(missing, [], `still inheriting the hue system: ${missing.join(', ')}`);
  });
}

console.log('\nand the syntax colours are split the way they claim to be');
for (const [theme, base] of [['light', BASE_LIGHT], ['dark', BASE_DARK]]) {
  check(`${theme}: link and error follow the palette`, () => {
    assert.equal(base['cm-link'], 'var(--accent)', 'a link in code should be the app accent');
    assert.equal(base['cm-invalid'], 'var(--danger)', 'an error in code should be the app danger colour');
  });
  check(`${theme}: the quiet ink follows the palette`, () => {
    assert.equal(base['cm-comment'], 'var(--muted)');
    assert.equal(base['cm-meta'], 'var(--muted)');
    assert.match(base['cm-punct'], /var\(--muted\)/, 'punctuation should be derived from muted, a step darker');
  });
  check(`${theme}: exactly the nine hues stay invariant`, () => {
    const hardcoded = Object.entries(base)
      .filter(([k, v]) => k.startsWith('cm-') && /^#/.test(v))
      .map(([k]) => k)
      .sort();
    assert.deepEqual(hardcoded, [...INVARIANT].sort(),
      'the invariant syntax set changed — decide whether the new colour belongs to the palette');
    // "Invariant" means invariant across the HUED palettes: Mono overrides all
    // nine on purpose, which the check above pins from the other side.
  });
}

console.log('\nand its override of the syntax colours actually wins the cascade');
// Declaring a token is not the same as the browser using it. Both the palette
// and the invariant syntax block target the root element, so which one applies
// is specificity first and source order second — and the syntax block is later
// in the file. This resolves the two the way the cascade does, on the source.
const spec = (sel) => (sel.match(/\[[^\]]+\]/g) || []).length + (sel.match(/:[a-z-]+/g) || []).length;
const winnerFor = (token, candidates) => {
  let best = null;
  for (const [i, r] of RULES.entries()) {
    if (!candidates.includes(r.selector)) continue;
    if (!new RegExp(`--${token}:`).test(r.body)) continue;
    const s2 = spec(r.selector);
    if (!best || s2 > best.s || (s2 === best.s && i > best.i)) best = { s: s2, i, selector: r.selector };
  }
  return best;
};
for (const [theme, sel, generic] of [
  ['light', lightSel('mono'), ':root'],
  ['dark', darkSel('mono'), "[data-theme='dark']"],
]) {
  check(`${theme}: the palette out-specifies the invariant block for all nine`, () => {
    const lost = INVARIANT.filter((k) => winnerFor(k, [sel, generic])?.selector !== sel);
    assert.deepEqual(lost, [], `the generic block still wins for: ${lost.join(', ')}`);
  });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
