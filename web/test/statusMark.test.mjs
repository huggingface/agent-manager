// The state mark has ONE footprint, declared once.
//
// A working agent shows the braille spinner; every other state is that same
// cell as a rectangle. The two only read as the same mark while they are the
// same size, and the way that quietly breaks is a second rule elsewhere giving
// `.status` its own width/height for one surface — which is exactly what
// `.row .status { width: 6px; height: 6px }` used to do for the sidebar.
//
// So this is a lint on the stylesheet, not a rendering test: it pins that the
// box is declared in one place. What it LOOKS like was checked with playwright
// against a live app (see the PR), which this cannot do.
//
// Run with:  node test/statusMark.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, '../src/styles.css'), 'utf8');

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// Every rule whose selector targets .status, with its body.
const rules = [...css.matchAll(/([^{}]*\.status[^{}]*)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim().split('\n').pop().trim(), body }));

console.log('the state mark is declared once');

check('the .status rule declares the box', () => {
  const base = rules.find((r) => r.selector === '.status');
  assert.ok(base, 'no bare `.status` rule found');
  assert.match(base.body, /--st-w:/, 'the width variable is not declared there');
  assert.match(base.body, /--st-h:/, 'the height variable is not declared there');
  assert.match(base.body, /width:\s*var\(--st-w\)/, 'width does not come from the variable');
  assert.match(base.body, /height:\s*var\(--st-h\)/, 'height does not come from the variable');
});

check('no other rule gives .status its own width or height', () => {
  const offenders = rules
    .filter((r) => r.selector !== '.status')
    .filter((r) => /(^|;|\s)(width|height)\s*:/.test(r.body))
    // ::before is the mark inside the box: it fills it (100%) or is the glyph
    // (auto). Neither is a second opinion about how big the box is.
    .filter((r) => !/::before/.test(r.selector))
    .map((r) => r.selector);
  assert.deepEqual(offenders, [], `these restate the box: ${offenders.join(', ')}`);
});

check('the mark inside the box only ever fills it or is the glyph', () => {
  for (const r of rules.filter((x) => /::before/.test(x.selector))) {
    const sizes = [...r.body.matchAll(/(?:^|;|\s)(?:width|height)\s*:\s*([^;]+)/g)].map((m) => m[1].trim());
    for (const v of sizes) {
      assert.ok(['100%', 'auto'].includes(v), `${r.selector} sizes the mark to ${v}`);
    }
  }
});

check('working is the spinner the rest of the app already runs', () => {
  const w = rules.find((r) => r.selector === '.status.working::before');
  assert.ok(w, 'no `.status.working::before` rule');
  assert.match(w.body, /animation:\s*ov-spin/, 'working does not use the ov-spin animation');
  assert.ok(/content:\s*'⠋'/.test(w.body), 'working does not render the braille frame');
});

check('the states that are not working carry no animation', () => {
  for (const state of ['waiting', 'idle', 'stopped']) {
    const own = rules.filter((r) => r.selector.includes(`.status.${state}`));
    for (const r of own) assert.doesNotMatch(r.body, /animation:/, `.status.${state} animates`);
  }
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
