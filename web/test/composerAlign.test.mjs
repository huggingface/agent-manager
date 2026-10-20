// The composer's controls sit on the FIRST line of the draft, and the offset
// that puts them there is measured from that line's height: `--ov-first-line`.
//
// The bug this pins is not the alignment, it is the *drift*. The line's height
// is the textarea's line-height times the textarea's font size — and that font
// size is pinned in three different places (the card's 13px, the reader's `1em`
// so it follows zoom, and 16px on a touch phone because iOS zooms the page on
// any smaller field). Add a fourth pin without a matching `--ov-first-line` and
// nothing breaks loudly: the controls simply sit a couple of pixels off the
// line, at one breakpoint, which is exactly what happened on the phone while
// this was being written.
//
// So: every size the input is pinned to must have a first-line height declared
// for it. No runner, no DOM — this reads the two stylesheets. Run with:
//   node test/composerAlign.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '../src', f), 'utf8');
const css = `${read('styles.css')}\n${read('conversation.css')}`;

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// Every rule that pins the composer textarea's size, and what it pins it to.
const pinned = new Set();
for (const [, selector, body] of css.matchAll(/([^{}]*textarea[^{}]*)\{([^}]*)\}/g)) {
  if (!/ov-live|cxv-live/.test(selector)) continue;
  const size = body.match(/font-size:\s*([^;]+);/);
  if (size) pinned.add(size[1].trim());
}
// …and every first-line height declared, reduced to the size it is built from.
const declared = new Set();
for (const [, value] of css.matchAll(/--ov-first-line:\s*calc\(([^;]+)\);/g)) {
  const px = value.match(/1\.45\s*\*\s*([\d.]+px)/);
  declared.add(px ? px[1] : (/1\.45em/.test(value) ? '1em' : value.trim()));
}

console.log('the first line is measured wherever the input is sized');
check(`something pins the input's size (found: ${[...pinned].join(', ') || 'nothing'})`,
  () => assert.ok(pinned.size >= 2));
check(`and each of those sizes has a first-line height (found: ${[...declared].join(', ') || 'nothing'})`,
  () => assert.deepEqual([...pinned].sort(), [...declared].sort()));

console.log('\nand every control is offset from that one number');
for (const [what, selector] of [
  ['the ❯', /\.ov-live \.ov-p \{[^}]*\}/],
  ['the send key', /\.ov-live \.ov-send \{[^}]*\}/],
  ['the paperclip', /\.ov-composer \.image-pick \{[^}]*\}/],
]) {
  check(`${what} centres on the first line`, () => {
    const rule = css.match(selector);
    assert.ok(rule, `no rule matched ${selector}`);
    assert.match(rule[0], /margin-top:\s*calc\(\(var\(--ov-first-line/);
  });
}
check('and the row is top-aligned, or there is no first line to sit on',
  () => assert.match(css, /\.ov-live \{[^}]*align-items:\s*flex-start/));
check('…including the strip the paperclip lives in',
  () => assert.match(css, /\.ov-composer \{[^}]*align-items:\s*start/));

console.log('\nand the reply row is told which column it is in');
// The composer is a two-column grid whose first column is the paperclip — and
// only the Overview card still draws one. Auto-placed, the reader's reply row
// dropped into that `auto` track and sized to its own content: a 210px line in
// an 872px composer, send key 650px from the right edge. So the row names its
// column, and this fails if that rule is dropped or stops reaching the end.
check('the reply row takes the last column, whatever is (not) in the first', () => {
  const rule = css.match(/\.ov-composer\s*>\s*\.ov-live \{[^}]*\}/);
  assert.ok(rule, 'no `.ov-composer > .ov-live` rule at all');
  assert.match(rule[0], /grid-column:\s*\d+\s*\/\s*-1/);
});
check('and the two-column template is still there for the card that needs it', () => {
  // Anchored: `.ovw-win .ov-composer { flex: none }` contains this selector as
  // a substring and would match first.
  const rule = css.match(/^\.ov-composer \{[^}]*\}/m);
  assert.ok(rule, 'no top-level `.ov-composer` rule');
  assert.match(rule[0], /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/);
});

console.log('\nand the reader wins on specificity, not on import order');
check('the reader restates it as .ov-composer.cxv-composer (0,2,0)', () => {
  assert.match(css, /\.ov-composer\.cxv-composer \{[^}]*--ov-first-line/);
  // Both classes are on the same element, so a bare .cxv-composer here would
  // tie with styles.css's .ov-composer and be decided by main.tsx's import
  // order — swap those two lines and the reader silently takes the card's
  // hardcoded 13px line and mis-centres at every zoom but 100%.
  assert.doesNotMatch(css, /(^|[\s,>])\.cxv-composer \{[^}]*--ov-first-line/m);
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
