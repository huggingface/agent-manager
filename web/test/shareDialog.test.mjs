// The share dialog's wording. A gated share is not a private repo: its name,
// card and file list are public. The dialog must not call it "Private", must say
// what is public, and must show a failed rollback as the emergency it is.
//   node --test test/shareDialog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/components/ShareDialog.tsx', import.meta.url), 'utf8');

test('the gated mode is "Approved people only", not "Private"', () => {
  assert.match(src, />\s*Approved people only\s*</);
  assert.doesNotMatch(src, />\s*Private\s*</);
});

test('the dialog says the listing is public and what in it is public', () => {
  assert.match(src, /listed publicly on the Hub, but only people you approve can read the trace/);
  assert.match(src, /repo name, card title and file list are public/);
});

test('a share that could not be rolled back is shown with its URL, not as a generic error', () => {
  assert.match(src, /e\.code === 'share-exposed'/);
  assert.match(src, /This trace may be public/);
  assert.match(src, /check it now/);
});

test('a gated share is refused on secrets too — no "share it privately instead" advice', () => {
  assert.doesNotMatch(src, /Share it with named people instead/);
});
