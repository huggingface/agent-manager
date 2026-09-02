// Where the remote pane says its state, and where a message's receipt sits.
//
// Two operator decisions are encoded in this layout, and both are the kind that
// a later edit undoes without anything looking broken:
//
//   The state is said ONCE, between the log and the line you type on. It used
//   to lead the bottom context row; leaving a copy there would put the same
//   word twice, forty pixels apart, reading as two opinions about one
//   connection. The header still carries the state, but as a StateLogo — the
//   CLI tile every pane and the sidebar draw — not as a second word.
//
//   The receipt belongs to its message, underneath it. It used to trail the
//   last word, which lands somewhere different in every message and strands
//   itself under a wrapped one.
//
// And one contract: the mark is the shared `.status` element, so `working` runs
// the same `ov-spin` the reader and the cards run. A pane that grew its own
// spinner would be a second thing that also means busy — the failure the state
// vocabulary in styles.css exists to prevent.
//
// Geometry — that the two receipts are the same height so a landing receipt
// cannot move a bottom-pinned log, and that the mark follows the pane's zoom —
// is measured in a browser by remotePaneState.render.test.mjs. This file is the
// part that can be read from source, and it runs everywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '../src', f), 'utf8');
const tsx = read('components/RemotePane.tsx');
const css = read('styles.css');

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const rule = (selector) => {
  const m = css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'm'));
  assert.ok(m, `no rule for ${selector}`);
  return m[0];
};

console.log('the state sits between the log and the composer');
const iLog = tsx.indexOf('className="rp-body"');
const iRow = tsx.indexOf('className="rp-staterow"');
const iComposer = tsx.indexOf('className="rp-composer"');
check('all three parts are there', () => {
  assert.ok(iLog > 0 && iRow > 0 && iComposer > 0, `log ${iLog}, row ${iRow}, composer ${iComposer}`);
});
check('and the state row is written between them', () => {
  assert.ok(iLog < iRow && iRow < iComposer);
});
check('the row carries the state word', () => {
  const row = tsx.slice(iRow, iComposer);
  assert.match(row, /className=\{`rp-state \$\{state\}`\}>\{stateLabel\}/);
});

console.log('\nand it is said once');
check('the bottom context row no longer says the state', () => {
  const bottom = tsx.slice(tsx.indexOf('className="rp-status"'));
  assert.doesNotMatch(bottom, /rp-state|stateLabel/);
});
check('the header keeps the state on the CLI tile, not in a second word', () => {
  const header = tsx.slice(tsx.indexOf('className="ph-left"'), iLog);
  assert.match(header, /<StateLogo\s+cli="remote"\s+state=\{state\}/);
});

console.log('\nthe mark is the shared one');
// The braille vocabulary is its own class, not `.status.working`: bare
// `.status` dots carry inline provider colours (UsagePanel, SettingsView) and
// stateLogo.test.mjs holds every pane to drawing *identity* state on a
// StateLogo frame instead. This row is the other kind of indicator.
check('the row uses the `state-mark` vocabulary', () => {
  const row = tsx.slice(iRow, iComposer);
  assert.match(row, /className=\{`state-mark \$\{state\}`\}/);
});
check('the pane does not draw a spinner of its own', () => {
  // No braille glyph and no keyframes anywhere in the pane's own rules: the
  // animation is declared once, beside the contract it is measured from.
  const own = css.slice(css.indexOf('.rp-user {'), css.indexOf('.rp-pop-prompt'));
  assert.doesNotMatch(own, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|@keyframes/);
  assert.doesNotMatch(tsx, /⠋|@keyframes/);
});
check('the row sizes the mark relative to the pane, so zoom carries it', () => {
  // The contract's own --mark-size is absolute, measured against the font's
  // braille ink, and declared exactly once (statusMark.test.mjs holds it to
  // that). This pane zooms, so the row sizes the mark as a ratio of its own
  // font size rather than redeclaring the contract's number.
  const m = rule('.rp-staterow .state-mark').match(/font-size:\s*([^;]+);/);
  assert.ok(m, '.rp-staterow does not size the mark');
  assert.match(m[1].trim(), /em$/, `font-size: ${m[1].trim()} would not follow the zoom`);
  assert.doesNotMatch(rule('.rp-staterow'), /--mark-/);
});

console.log('\nthe receipt belongs to its message');
check('it is written inside the message body, after the text', () => {
  const block = tsx.slice(tsx.indexOf('className="rp-user"'), tsx.indexOf('className="rp-agent"'));
  const iBody = block.indexOf('className="rp-user-body"');
  const iText = block.indexOf('className="rp-user-text"');
  const iReceipt = block.indexOf('className="rp-receipt');
  assert.ok(iBody > 0 && iBody < iText && iText < iReceipt, `body ${iBody}, text ${iText}, receipt ${iReceipt}`);
});
check('the body is a column, so the receipt lands under the text', () => {
  const r = rule('.rp-user-body');
  assert.match(r, /flex-direction:\s*column/);
});
check('both states are the same element, so nothing else can differ', () => {
  const block = tsx.slice(tsx.indexOf('className="rp-user"'), tsx.indexOf('className="rp-agent"'));
  assert.match(block, /className="rp-receipt ack"/);
  assert.match(block, /className="rp-receipt pending"/);
});
check('and neither variant resizes itself', () => {
  // One height for both, or a receipt landing shifts every line below it.
  for (const v of ['.rp-receipt.ack', '.rp-receipt.pending']) {
    assert.doesNotMatch(rule(v), /font-size|line-height|height|padding|margin/, `${v} changes its own box`);
  }
  assert.match(rule('.rp-receipt'), /line-height/);
  assert.match(rule('.rp-receipt'), /height:/);
});
check('and it still claims only what a poll returned', () => {
  // The wording is the whole guarantee: `deliveredThrough` is the highest seq a
  // poll actually handed over. Nothing here knows whether the agent read it.
  assert.match(tsx, /highest seq a poll actually returned/);
  assert.match(tsx, /m\.seq <= \(info\?\.deliveredThrough \?\? 0\)/);
});

console.log('\nno dead rules left behind');
for (const gone of ['.rp-ack', '.rp-pending']) {
  check(`${gone} is gone from the stylesheet`, () => {
    assert.doesNotMatch(css, new RegExp(`\\${gone}\\b`));
    assert.doesNotMatch(tsx, new RegExp(`\\${gone.slice(1)}"`));
  });
}

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
