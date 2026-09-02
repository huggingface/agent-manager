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
check('there is more than one spinner renderer to keep in step', () => {
  assert.ok(spinners.length >= 3, `found ${spinners.length}`);
});
check('none of them restates a width', () => {
  const offenders = spinners
    .filter((r) => /(?:^|;|\s)width\s*:/.test(r.body))
    .filter((r) => !/width\s*:\s*var\(--mark-w\)/.test(r.body))
    .map((r) => r.selector);
  assert.deepEqual(offenders, [], `these size the spinner themselves: ${offenders.join(', ')}`);
});
check('every spinner consumes the shared type, weight and cell contract', () => {
  for (const spinner of spinners) {
    if (spinner.selector === '.state-mark.working::before') {
      assert.match(spinner.body, /content:\s*'⠋'/, 'working lost the shared braille family');
      assert.match(spinner.body, /translateY\(var\(--mark-optical-y\)\)/, 'working lost the optical correction');
      continue; // its parent owns the contract; the mark fills it below
    }
    assert.match(spinner.body, /font-family\s*:\s*var\(--font-mono\)/, `${spinner.selector} inherits its font family`);
    assert.match(spinner.body, /font-size\s*:\s*var\(--mark-size\)/, `${spinner.selector} has its own type size`);
    assert.match(spinner.body, /font-weight\s*:\s*var\(--mark-weight\)/, `${spinner.selector} inherits its weight`);
    assert.match(spinner.body, /line-height\s*:\s*1/, `${spinner.selector} inherits its line height`);
    assert.match(spinner.body, /width\s*:\s*var\(--mark-w\)/, `${spinner.selector} has its own width`);
    assert.match(spinner.body, /height\s*:\s*var\(--mark-h\)/, `${spinner.selector} has its own height`);
    assert.match(spinner.body, /translateY\(var\(--mark-optical-y\)\)/, `${spinner.selector} lost the optical correction`);
  }
});

console.log('\nand so does every state that stands in for it');

const STATES = ['working', 'waiting', 'idle', 'stopped'];
const stateRules = rules.filter((r) => STATES.some((s) => r.selector.includes(`.state-mark.${s}`)));
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
  const working = rules.find((r) => r.selector === '.state-mark.working::before' && /width\s*:\s*100%/.test(r.body));
  assert.ok(working, 'working does not fill the shared cell');
  assert.match(working.body, /height\s*:\s*100%/);
});
check('every non-working state uses one measured hollow rectangle', () => {
  const statics = rules.filter((r) => ['waiting', 'idle', 'stopped'].every((s) => r.selector.includes(`.state-mark.${s}::before`)));
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
check('no non-working state overrides that rectangle with its own shape', () => {
  const offenders = rules.filter((r) => /\.state-mark\.(waiting|idle|stopped)::before/.test(r.selector))
    .filter((r) => !['waiting', 'idle', 'stopped'].every((s) => r.selector.includes(`.state-mark.${s}::before`)));
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
    for (const r of rules.filter((x) => x.selector.includes(`.state-mark.${state}`))) {
      assert.doesNotMatch(r.body, /animation:/, `.state-mark.${state} animates`);
    }
  }
});
check('working runs the same animation the rest of the app runs', () => {
  const w = rules.find((r) => r.selector === '.state-mark.working::before' && /animation:/.test(r.body));
  assert.ok(w, 'no `.state-mark.working::before` rule');
  assert.match(w.body, /animation:\s*ov-spin/, 'working does not use ov-spin');
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
