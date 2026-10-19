// Which part of a TUI's screen is the input line (#167 follow-up).
//
// The guard refused the operator's messages to a working Claude Code session.
// Three separate reasons, all of them here as grids:
//
//   - Claude Code's idle composer is `❯` followed by U+00A0, not a space.
//     `trim()` drops an NBSP, so a refusal reported the text as just "❯", and a
//     baseline photographed with one kind of space never matched the other.
//   - The composer was located by the cursor's row. While the agent works the
//     cursor is wherever the redraw left it, and every submitted prompt is
//     echoed into the transcript as its own `❯ <text>` line — so the guard read
//     the operator's previous message, already delivered and answered, as
//     unsent input. It is located by the rules around the box now; nothing
//     above the top rule is input.
//   - Focus and mouse reports are not typing. They are not terminal replies
//     either, so opening a pane or clicking in it started the guard with
//     nothing typed.
//
// The grids below keep the shape of the real screen: the idle one is the
// manager pane's own composer, read off the live grid while this was written.
//
// Run with:  node test/input-line-composer.test.mjs
import assert from 'node:assert/strict';
import { composerShape, composerBody, sameComposer, isTypedInput } from '../src/runner.js';

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const RULE = '─'.repeat(70);
const grid = (rows, cursorRow, cursorCol) => ({
  cursorRow, cursorCol, isAltScreen: false,
  visibleLines: rows.map((text, row) => ({ row, text })),
});

// ── Claude Code, idle. `❯` + U+00A0, exactly as the live pane reports it.
const idle = grid([
  '│ a previous answer                      │',
  '',
  '✻ Brewed for 59s · done 9:12 AM',
  '',
  RULE,
  '❯ ',
  RULE,
  '  Opus 5.5 · 5h 10% · wk 24%',
], 5, 2);

// ── Working: a spinner, the echo of the prompt just sent sitting in the
//    transcript, and an empty composer. The cursor is NOT in the box.
const busy = grid([
  '❯ still an issue, let me paste the error',
  '',
  '✻ Thinking… (12s · ↓ 1.2k tokens)',
  '',
  RULE,
  '❯ ',
  RULE,
  '  Opus 5.5 · 5h 10% · wk 24%',
], 2, 33);

// ── The same, with the echo wrapped across rows and cropped by the box.
const wrapped = grid([
  '❯ still an issue, let me past',
  '  e the error from the deploy log and see wh',
  '  at it says about the bucket mount',
  '',
  '✻ Thinking… (31s)',
  RULE,
  '❯ ',
  RULE,
], 1, 44);

// ── Genuinely half-typed: the cursor IS in the box, after real text.
const halfTyped = grid([
  '❯ still an issue, let me paste the error',
  '',
  '✻ Thinking… (12s)',
  RULE,
  '❯ let me paste the err',
  RULE,
], 4, 22);

// ── Codex: a composer with no box around it.
const codexIdle = grid(['  working…', '', '› '], 2, 2);
const codexTyped = grid(['  working…', '', '› half a thought'], 2, 16);

console.log('\n# Claude Code');
check('an idle composer reads as empty, NBSP and all', () => {
  const shape = composerShape(idle);
  assert.equal(shape.located, true, 'the box was not found');
  assert.equal(shape.cursorInside, true, 'the cursor was not placed in the box');
  assert.equal(composerBody(shape), '', `reads as ${JSON.stringify(composerBody(shape))}`);
});
check('…and never reports the bare prompt character', () => {
  assert.notEqual(composerBody(composerShape(idle)), '❯');
});
check('a working session with an empty composer is empty', () => {
  const shape = composerShape(busy);
  assert.equal(shape.located, true);
  assert.equal(composerBody(shape), '', `read the transcript as input: ${JSON.stringify(composerBody(shape))}`);
});
check('the prompt echoed into the transcript is not input', () => {
  assert.ok(!composerShape(busy).text.includes('still an issue'),
    'the operator\'s delivered message was read off the transcript');
});
check('a wrapped, cropped echo is not input either', () => {
  const shape = composerShape(wrapped);
  assert.equal(composerBody(shape), '');
  assert.ok(!shape.text.includes('let me past'), 'the cropped echo was read as unsent text');
});
check('a half-typed composer still blocks', () => {
  const shape = composerShape(halfTyped);
  assert.equal(shape.cursorInside, true);
  assert.equal(composerBody(shape), 'let me paste the err');
});

console.log('\n# Codex, which draws no box');
check('an empty composer matches its own picture', () => {
  assert.equal(sameComposer(composerShape(codexIdle), composerShape(codexIdle)), true);
});
check('and a typed one does not', () => {
  assert.equal(sameComposer(composerShape(codexIdle), composerShape(codexTyped)), false);
});

console.log('\n# whitespace');
// Not a reproduction: JS `\s` already matches NBSP, so this holds today for
// free. It is here so a future change to how the line is normalised cannot
// quietly make two spellings of the same empty composer look different.
check('an NBSP prompt and a plain-space one are the same line', () => {
  const nbsp = composerShape(grid([RULE, '❯ ', RULE], 1, 2));
  const plain = composerShape(grid([RULE, '❯ ', RULE], 1, 2));
  assert.equal(sameComposer(nbsp, plain), true, 'an NBSP made the baseline unmatchable');
});

console.log('\n# what counts as typing');
// Focus and mouse reports reach the PTY through the same frame as keystrokes.
for (const [name, seq, typing] of [
  ['focus in', '\x1b[I', false],
  ['focus out', '\x1b[O', false],
  ['an SGR mouse press', '\x1b[<0;10;5M', false],
  ['an SGR mouse release', '\x1b[<0;10;5m', false],
  ['a legacy mouse report', '\x1b[M !!', false],
  ['an arrow key', '\x1b[A', true],
  ['a character', 'x', true],
]) {
  check(`${name} ${typing ? 'is' : 'is not'} typing`, () => {
    assert.equal(isTypedInput(seq), typing);
  });
}

if (failed) { console.log(`\ninput-line-composer: ${failed} failed`); process.exit(1); }
console.log('\ninput-line-composer: the composer is the box, not the cursor\'s row');
