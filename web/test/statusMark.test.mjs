// One geometry contract for the working animation and everything that stands
// in for it.
//
// A working agent shows the braille spinner; every other state shows the hollow
// rectangle traced by those dots. They only read as one system while the
// rectangle is derived from the glyph's real ink instead of from a visually
// similar box someone guessed by eye.
//
// So this lints the contract, not the numbers: type, cell, measured ink box and
// derived stroke are declared once, and every spinner/static renderer reads them.
// One value may be re-chosen and only one — the type anchor, and only between
// the fixed chrome size and the surface's own size, for a mark that lives inside
// something the operator zooms. See .rp-mark in styles.css.
// What the marks actually PAINT is a separate question this cannot answer. That
// is statusMark.render.test.mjs.
//
// Run with:  node test/statusMark.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '../src', f), 'utf8');
const styles = read('styles.css');
const conversation = read('conversation.css');
const css = `${styles}\n${conversation}`;

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const rulesOf = (text) => [...text.matchAll(/([^{}]*)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim().split('\n').pop().trim(), body }))
  .filter((r) => r.selector && !r.selector.startsWith('@'));
const rules = rulesOf(css);
const LENGTH = /(?:^|[\s:])-?\d*\.?\d+(?:px|em|rem|%)/;

console.log('the cell is declared once');

check('the type, cell and measured path values are declared exactly once each', () => {
  for (const name of [
    '--mark-size', '--mark-w', '--mark-h',
    '--mark-weight', '--mark-optical-y',
    '--mark-ink-x', '--mark-ink-y', '--mark-ink-w', '--mark-ink-h', '--mark-stroke',
  ]) {
    const declarations = [...css.matchAll(new RegExp(`${name}\\s*:`, 'g'))].length;
    assert.equal(declarations, 1, `${name} is declared ${declarations} times`);
  }
});

check('they are declared with the animation, not with one of its consumers', () => {
  const decl = rules.find((r) => /--mark-w\s*:/.test(r.body));
  assert.equal(decl.selector, ':root', `declared on \`${decl.selector}\``);
  // ov-spin's keyframes and the :root declaration should be neighbours, so the
  // next person to touch the animation sees the box it promises.
  const gap = Math.abs(styles.indexOf('--mark-w') - styles.indexOf('@keyframes ov-spin'));
  assert.ok(gap < 800, `the declaration is ${gap} chars from @keyframes ov-spin`);
});

console.log('\nevery renderer of the spinner reads it');

const spinners = rules.filter((r) => /animation:\s*ov-spin/.test(r.body));
// A spinner gets its box one of two legitimate ways: it takes the cell from
// --mark-w/--mark-h, or it fills a parent that already did (100%). What it must
// never do is name a length of its own — that is how a renderer drifts.
const FILLS_PARENT = /width\s*:\s*100%/;
// A mark's declarations are spread over several rules — `.status.working::before`
// is two of them, and its cell is declared on a four-state list — so read the
// cascade the way the browser does: everything targeting one element, merged.
const declaredOn = (selector) => rules
  .filter((r) => r.selector.split(',').some((sel) => sel.trim() === selector))
  .map((r) => r.body).join(';');
// Whichever element actually owns the cell: the pseudo-element itself, or — when
// it fills 100% of its parent — the parent it fills.
const cellOwnerOf = (spinner) => {
  const own = declaredOn(spinner.selector);
  if (!FILLS_PARENT.test(own)) return { selector: spinner.selector, body: own };
  const parent = spinner.selector.replace(/::before\b/g, '').trim();
  return { selector: parent, body: declaredOn(parent) };
};

check('there is more than one spinner renderer to keep in step', () => {
  assert.ok(spinners.length >= 3, `found ${spinners.length}`);
});
check('none of them names a box size of its own', () => {
  const offenders = spinners
    .map((r) => ({ selector: r.selector, body: declaredOn(r.selector) }))
    .filter((r) => /(?:^|;|\s)width\s*:/.test(r.body))
    .filter((r) => !/width\s*:\s*var\(--mark-w\)/.test(r.body) && !FILLS_PARENT.test(r.body))
    .map((r) => r.selector);
  assert.deepEqual(offenders, [], `these size the spinner themselves: ${offenders.join(', ')}`);
});
check('a spinner that fills its parent gets the box from that parent', () => {
  for (const spinner of spinners.filter((r) => FILLS_PARENT.test(declaredOn(r.selector)))) {
    assert.match(declaredOn(spinner.selector), /height\s*:\s*100%/, `${spinner.selector} fills one axis only`);
    const owner = cellOwnerOf(spinner);
    assert.match(owner.body, /width\s*:\s*var\(--mark-w\)/,
      `nothing sizes ${owner.selector} from the cell, so ${spinner.selector} fills nothing`);
    assert.match(owner.body, /height\s*:\s*var\(--mark-h\)/, `${owner.selector} sizes one axis only`);
  }
});
// The type anchor is the one value a renderer may re-choose, and only between
// two options: the fixed chrome size, or the surface's own size. Every mark in
// the app is constant-size chrome and takes --mark-size; the remote pane's
// state line sits inside a surface the operator zooms 50%-200%, where a
// constant mark would be twice the text at one end and half of it at the other.
// Nothing else may vary — the cell, ink box, stroke and optical correction stay
// the shared em ratios, which is what keeps the still path and the animation
// the same drawing.
const ANCHOR = /font-size\s*:\s*(var\(--mark-size\)|1em|inherit)\s*[;}]/;
check('every spinner consumes the shared type, weight and cell contract', () => {
  for (const spinner of spinners) {
    assert.match(spinner.body, /content:\s*'⠋'/, `${spinner.selector} lost the shared braille family`);
    assert.match(spinner.body, /translateY\(var\(--mark-optical-y\)\)/, `${spinner.selector} lost the optical correction`);
    // The type and cell are asserted on whichever rule owns them, so a mark
    // drawn as cell + filling pseudo-element is held to the same contract as
    // one drawn in a single rule.
    const owner = cellOwnerOf(spinner);
    assert.match(owner.body, ANCHOR, `${owner.selector} invents a type size`);
    assert.match(owner.body, /font-family\s*:\s*var\(--font-mono\)/, `${owner.selector} inherits its font family`);
    assert.match(owner.body, /font-weight\s*:\s*var\(--mark-weight\)/, `${owner.selector} inherits its weight`);
    assert.match(owner.body, /line-height\s*:\s*1/, `${owner.selector} inherits its line height`);
    assert.match(owner.body, /width\s*:\s*var\(--mark-w\)/, `${owner.selector} has its own width`);
    assert.match(owner.body, /height\s*:\s*var\(--mark-h\)/, `${owner.selector} has its own height`);
  }
});
check('a re-anchored mark still takes its cell and ink from the contract', () => {
  const reanchored = rules.filter((r) => /font-size\s*:\s*(1em|inherit)\s*[;}]/.test(r.body)
    && /var\(--mark-/.test(r.body));
  assert.ok(reanchored.length >= 1, 'no renderer re-anchors its type size, so this allowance is dead');
  for (const r of reanchored) {
    const lengths = [...r.body.matchAll(/(?:^|;|\s)(width|height|left|top|border)\s*:\s*([^;]+)/g)]
      .filter(([, , value]) => LENGTH.test(value) && !/var\(--mark-|100%/.test(value))
      .map(([, prop]) => prop);
    assert.deepEqual(lengths, [], `${r.selector} names its own ${lengths.join(', ')}`);
  }
});

console.log('\nand so does every state that stands in for it');

const STATES = ['working', 'waiting', 'idle', 'stopped'];
const stateRules = rules.filter((r) => STATES.some((s) => r.selector.includes(`.status.${s}`)));
check('the four states are sized from the cell', () => {
  const sized = stateRules.filter((r) => /width\s*:\s*var\(--mark-w\)/.test(r.body)
    && /height\s*:\s*var\(--mark-h\)/.test(r.body)
    && /font-size\s*:\s*var\(--mark-size\)/.test(r.body));
  assert.ok(sized.length >= 1, 'no state rule takes its box from --mark-w/--mark-h');
  for (const s of STATES) {
    assert.ok(sized.some((r) => r.selector.includes(`.${s}`)), `${s} is not covered by that rule`);
  }
});
check('the four states own their typography instead of inheriting it', () => {
  const typed = stateRules.filter((r) => !/::before/.test(r.selector)
    && /font-family\s*:\s*var\(--font-mono\)/.test(r.body)
    && /font-size\s*:\s*var\(--mark-size\)/.test(r.body)
    && /font-weight\s*:\s*var\(--mark-weight\)/.test(r.body)
    && /line-height\s*:\s*1/.test(r.body));
  for (const s of STATES) {
    assert.ok(typed.some((r) => r.selector.includes(`.${s}`)), `${s} inherits surrounding typography`);
  }
});
check('no state rule restates a length for its box', () => {
  const offenders = stateRules
    // ::before is the mark INSIDE the cell; that it fills it (100%) is the next
    // check's business, not a second opinion about how big the cell is.
    .filter((r) => !/::before/.test(r.selector))
    .filter((r) => [...r.body.matchAll(/(?:^|;|\s)(width|height)\s*:\s*([^;]+)/g)]
      .some(([, , value]) => LENGTH.test(value) && !/var\(--mark-[wh]\)/.test(value)))
    .map((r) => r.selector);
  assert.deepEqual(offenders, [], `these restate the box: ${offenders.join(', ')}`);
});
check('working fills the shared cell', () => {
  const working = rules.find((r) => r.selector === '.status.working::before' && /width\s*:\s*100%/.test(r.body));
  assert.ok(working, 'working does not fill the shared cell');
  assert.match(working.body, /height\s*:\s*100%/);
});
check('every non-working state uses one measured hollow rectangle', () => {
  const statics = rules.filter((r) => ['waiting', 'idle', 'stopped'].every((s) => r.selector.includes(`.status.${s}::before`)));
  assert.equal(statics.length, 1, `found ${statics.length} shared static path rules`);
  const body = statics[0].body;
  for (const [prop, variable] of [
    ['left', '--mark-ink-x'], ['top', '--mark-ink-y'],
    ['width', '--mark-ink-w'], ['height', '--mark-ink-h'],
  ]) {
    assert.match(body, new RegExp(`${prop}\\s*:\\s*var\\(${variable}\\)`), `${prop} does not read ${variable}`);
  }
  assert.match(body, /content\s*:\s*['"]{2}/, 'the static path is still a glyph');
  assert.match(body, /border\s*:\s*var\(--mark-stroke\)\s+solid\s+currentColor/, 'the path does not use the derived dot stroke');
  assert.match(body, /background\s*:\s*none/, 'the path has a fill');
  assert.match(body, /border-radius\s*:\s*0/, 'the path is rounded');
});
// The check above is about `.status`, which also has a bare colour-dot form to
// override. Any other family that draws the moving path must draw the still one
// too, from the same measured ink — otherwise a second family could re-anchor
// its type size legitimately and then guess its rectangle by eye, and the two
// drawings would stop being one mark.
check('every family that spins also stands still, from the same ink box', () => {
  const familyOf = (selector) => selector.match(/(\.[a-z][a-z0-9-]*)\.working::before/)?.[1];
  const spinning = [...new Set(spinners.map((r) => familyOf(r.selector)).filter(Boolean))];
  assert.ok(spinning.length >= 2, `only ${spinning.length} state-classed spinner family; this allowance is dead`);
  for (const family of spinning) {
    const still = rules.filter((r) => ['waiting', 'idle', 'stopped']
      .every((state) => r.selector.includes(`${family}.${state}::before`)));
    assert.equal(still.length, 1, `${family} has ${still.length} still-path rules, not one shared`);
    const body = still[0].body;
    for (const [prop, variable] of [
      ['left', '--mark-ink-x'], ['top', '--mark-ink-y'],
      ['width', '--mark-ink-w'], ['height', '--mark-ink-h'],
    ]) {
      assert.match(body, new RegExp(`${prop}\\s*:\\s*var\\(${variable}\\)`), `${family} still path: ${prop} does not read ${variable}`);
    }
    assert.match(body, /border\s*:\s*var\(--mark-stroke\)\s+solid\s+currentColor/, `${family} still path does not use the derived dot stroke`);
    assert.match(body, /content\s*:\s*['"]{2}/, `${family} still path is a glyph, not the traced box`);
  }
});

check('no non-working state overrides that rectangle with its own shape', () => {
  const offenders = rules.filter((r) => /\.status\.(waiting|idle|stopped)::before/.test(r.selector))
    .filter((r) => !['waiting', 'idle', 'stopped'].every((s) => r.selector.includes(`.status.${s}::before`)));
  assert.deepEqual(offenders.map((r) => r.selector), []);
});

console.log('\nand the plain colour dot is left alone');

check('bare .status draws nothing of its own', () => {
  const bare = rules.filter((r) => /(^|,\s*)\.status::before\s*$/.test(r.selector));
  assert.deepEqual(bare.map((r) => r.selector), [],
    'a pseudo-element on bare `.status` paints over the inline provider/CLI colours '
    + 'in UsagePanel.tsx and SettingsView.tsx');
});
check('bare .status keeps a box of its own for those callers', () => {
  const base = rules.find((r) => r.selector === '.status');
  assert.ok(base, 'no bare `.status` rule');
  assert.match(base.body, /width:\s*8px/, 'the plain dot lost its size');
});

console.log('\nand only working animates');

check('the states that are not working carry no animation', () => {
  for (const state of ['waiting', 'idle', 'stopped']) {
    for (const r of rules.filter((x) => x.selector.includes(`.status.${state}`))) {
      assert.doesNotMatch(r.body, /animation:/, `.status.${state} animates`);
    }
  }
});
check('working runs the same animation the rest of the app runs', () => {
  const w = rules.find((r) => r.selector === '.status.working::before' && /animation:/.test(r.body));
  assert.ok(w, 'no `.status.working::before` rule');
  assert.match(w.body, /animation:\s*ov-spin/, 'working does not use ov-spin');
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
