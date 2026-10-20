// What the normalizer does with Claude Code's pasted-text wrapper.
//
// Claude Code wraps pasted input as `<pasted_content id="…">…</pasted_content
// id="…">`. Unlike `<system-reminder>` and friends this is the OPERATOR'S OWN
// TEXT, so it has to be unwrapped and shown, never filtered out.
//
// Two things went wrong while it was left in, and they surface in different
// places, which is why this covers the digest as well as the transcript:
//
//   - the digest drops anything starting with `<` as harness noise, so a pasted
//     prompt never became the session's last prompt and the Overview card
//     showed the prompt BEFORE it;
//   - the reader rendered the wrapper, and because the closing tag carries an
//     `id` attribute — not valid HTML — markdown printed it literally.
//
// The reader-side duplicate this also caused is covered end to end in
// web/test/queuedPrompt.test.mjs, which needs a browser. This half does not.
//
// Run with:  node test/pasted-prompt.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTraceByPath, __parseClaudeForTest as parseClaude } from '../src/traces.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasted-prompt-'));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const TYPED = 'why does this show up twice?';
// The attachment list matters: it is a markdown block, and the closing tag
// landing after one is what made the renderer print the tag instead of eating it.
const SENT = `${TYPED}\n\nAttached files:\n- "/data/state/attachments/x/att_1.png"`;
const pasted = (t, id = 'df85') => `<pasted_content id="${id}">\n${t}\n</pasted_content id="${id}">`;
const now = () => new Date().toISOString();
const write = (name, records) => {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
};
const user = (text) => ({ type: 'user', sessionId: 's', timestamp: now(),
  message: { role: 'user', content: [{ type: 'text', text }] } });
const asst = (text, id) => ({ type: 'assistant', sessionId: 's', timestamp: now(),
  message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const attachment = (prompt, sourceUuid) => ({ type: 'attachment', sessionId: 's', timestamp: now(),
  attachment: { type: 'queued_command', prompt, humanTurn: true,
    ...(sourceUuid ? { source_uuid: sourceUuid } : {}) } });
const queue = (operation, content, reason) => ({ type: 'queue-operation', operation,
  sessionId: 's', timestamp: now(), ...(content ? { content } : {}),
  ...(reason ? { reason, deliveryId: '18445368-4b59', commandUuid: 'a26f88b4' } : {}) });

const textOf = (turns) => turns.flatMap((t) => (t.blocks || [])
  .filter((b) => b.type === 'text').map((b) => b.text))
  .concat(turns.map((t) => t.event?.text || '')).join('\n');

console.log('\n# the transcript');
for (const [name, records] of [
  // Both `remove` shapes are in one real transcript: newer CLIs carry
  // `reason: "absorbed_mid_turn"`, older ones carry no reason at all.
  ['absorbed mid-turn', [user('first'), asst('working', 'm1'),
    queue('enqueue', pasted(SENT)), queue('remove', pasted(SENT), 'absorbed_mid_turn')]],
  ['removed with no reason', [user('first'), asst('working', 'm1'),
    queue('enqueue', pasted(SENT)), queue('remove', pasted(SENT))]],
  ['dequeued, delivered as a user message', [user('first'), asst('working', 'm1'),
    queue('enqueue', pasted(SENT)), queue('dequeue'), user(pasted(SENT))]],
]) {
  for (const reader of [true, false]) {
    const { turns } = await readTraceByPath(write(`${name}-${reader}`, records), { reader, limit: 200 });
    const text = textOf(turns);
    check(`${name}${reader ? '' : ' (trace pane)'}: the wrapper is gone`, () => {
      assert.ok(!text.includes('pasted_content'), 'the wrapper survived into the transcript');
    });
    check(`${name}${reader ? '' : ' (trace pane)'}: the operator's text is kept`, () => {
      assert.ok(text.includes(TYPED), 'the prompt itself was dropped');
      assert.ok(text.includes('att_1.png'), 'the attachment list was dropped');
    });
  }
}

console.log('\n# what the reader is told about a removal');
{
  // `reader` is derived from the WINDOW's version, not from an opts flag: the
  // calls above exercise the older path. In the reader's own mode a queue
  // record arrives as an event, and the reason has to come with it — the reader
  // cannot otherwise tell a prompt that was delivered into the running turn
  // from one the queue dropped undelivered.
  const file = write('absorbed-event', [user('first'), asst('working', 'm1'),
    queue('enqueue', 'a mid-turn message'),
    queue('remove', 'a mid-turn message', 'absorbed_mid_turn')]);
  const { turns } = await readTraceByPath(file, { window: { version: 2, at: 'tail', bytes: 8 * 1024 * 1024 } });
  const events = turns.filter((t) => t.event?.type === 'queue');
  check('the reader gets the queue records as events', () => {
    assert.deepEqual(events.map((e) => e.event.operation), ['enqueue', 'remove']);
  });
  check('and the removal says why it was removed', () => {
    assert.equal(events[1].event.reason, 'absorbed_mid_turn');
  });
  check('and which queue entry it took', () => {
    assert.equal(events[1].event.commandUuid, 'a26f88b4', 'the only identity in the lifecycle is dropped');
  });
}
{
  // The delivery record is the prompt's last chance: a window can begin after
  // both the enqueue and the removal and still contain it.
  const file = write('delivery-event', [user('first'), asst('working', 'm1'),
    attachment('a mid-turn message', 'cmd-7')]);
  const { turns } = await readTraceByPath(file, { window: { version: 2, at: 'tail', bytes: 8 * 1024 * 1024 } });
  const events = turns.filter((t) => t.event?.type === 'queue');
  check('a queued_command attachment reaches the reader', () => {
    assert.deepEqual(events.map((e) => e.event.operation), ['delivered']);
    assert.equal(events[0].event.text, 'a mid-turn message');
    assert.equal(events[0].event.commandUuid, 'cmd-7');
  });
  const anon = write('delivery-anon', [user('first'), asst('working', 'm1'),
    attachment('a mid-turn message', null)]);
  const anonTurns = (await readTraceByPath(anon, { window: { version: 2, at: 'tail', bytes: 8 * 1024 * 1024 } })).turns;
  check('one that names no queue entry is left alone', () => {
    // Without an id there is no way to tell it from the removal of the same
    // text, and showing both is the duplicate this area keeps producing.
    assert.equal(anonTurns.filter((t) => t.event?.type === 'queue').length, 0);
  });
  const plain = write('plain-event', [user('first'), asst('working', 'm1'),
    queue('enqueue', 'another'), queue('remove', 'another')]);
  const plainTurns = (await readTraceByPath(plain, { window: { version: 2, at: 'tail', bytes: 8 * 1024 * 1024 } })).turns;
  check('an ordinary removal carries no reason to misread', () => {
    assert.equal(plainTurns.filter((x) => x.event?.type === 'queue')[1].event.reason, undefined);
  });
}

console.log('\n# a prompt that only talks about the wrapper');
// Matched by backreference on the id, so an unpaired mention is not a wrapper.
const MENTIONS = 'the closing </pasted_content id="df85"> tag is what leaks — see traces.js';
{
  const { turns } = await readTraceByPath(write('mentions', [user(MENTIONS), asst('right', 'm1')]), { reader: true, limit: 200 });
  check('is left exactly as written', () => {
    assert.ok(textOf(turns).includes(MENTIONS), 'a prompt about the tag was mangled');
  });
}

console.log('\n# a paste whose BODY opens with a harness envelope');
// Someone asking about `<system-reminder>` pastes one. The wrapper is proof the
// harness is quoting the operator rather than talking to itself, so the
// envelope test has to run on the RAW record: unwrapping first turned these
// into harness noise, which demotes a plain record to a `system` turn and drops
// a queued one outright -- a lost operator prompt.
for (const envelope of ['<system-reminder>', '<task-notification>', '<environment_context>']) {
  const BODY = `${envelope}\nwhat does this mean when I see it?\n`;
  for (const [name, records] of [
    ['plain', [user(pasted(BODY)), asst('it is the harness', 'm1')]],
    ['queued', [user('first'), asst('working', 'm1'),
      queue('enqueue', pasted(BODY)), queue('remove', pasted(BODY), 'absorbed_mid_turn')]],
  ]) {
    const { turns } = await readTraceByPath(write(`env-${envelope.length}-${name}`, records), { reader: true, limit: 200 });
    const mine = turns.filter((t) => t.role === 'user' || t.event?.type === 'queue');
    check(`${envelope} pasted (${name}): survives as the operator's own`, () => {
      assert.ok(textOf(mine).includes('what does this mean when I see it?'),
        'the pasted envelope was treated as harness noise and lost');
    });
    check(`${envelope} pasted (${name}): is not demoted to a system turn`, () => {
      assert.ok(!turns.some((t) => t.role === 'system' && (t.blocks || [])
        .some((b) => b.type === 'text' && b.text.includes('what does this mean'))),
        'the operator\'s paste was rendered as harness output');
    });
  }
}

// The envelope itself, unwrapped, is still harness noise and must stay out.
{
  const { turns } = await readTraceByPath(write('bare-envelope', [
    user('first'), asst('working', 'm1'),
    queue('enqueue', '<task-notification>\n<task-id>abc</task-id>\n'),
    queue('remove', '<task-notification>\n<task-id>abc</task-id>\n', 'absorbed_mid_turn'),
  ]), { reader: true, limit: 200 });
  check('a bare harness envelope is still filtered', () => {
    assert.ok(!textOf(turns).includes('task-id'), 'harness noise reached the reader as a prompt');
  });
}

console.log('\n# the digest behind the Overview card');
{
  const txt = [user('an ordinary prompt'), asst('ok', 'm1'), user(pasted(SENT))]
    .map((r) => JSON.stringify(r)).join('\n');
  const { digest } = parseClaude(txt);
  const last = digest.lastPromptText || digest.lastPrompt || '';
  check('a pasted prompt becomes the last prompt', () => {
    assert.ok(last.includes(TYPED), `the card still shows ${JSON.stringify(String(last).slice(0, 40))}`);
  });
  check('and carries no wrapper', () => {
    assert.ok(!String(last).includes('pasted_content'), 'the wrapper reached the Overview card');
  });
}

{
  // Same trap as the transcript: the card's noise filter must not eat a paste
  // whose body happens to open with an envelope.
  const BODY = '<system-reminder>\nwhat does this mean when I see it?\n';
  const txt = [user('an ordinary prompt'), asst('ok', 'm1'), user(pasted(BODY))]
    .map((r) => JSON.stringify(r)).join('\n');
  const { digest } = parseClaude(txt);
  const last = String(digest.lastPromptText || digest.lastPrompt || '');
  check('a pasted envelope still becomes the last prompt', () => {
    assert.ok(last.includes('what does this mean when I see it?'),
      `the card shows ${JSON.stringify(last.slice(0, 40))}`);
  });
  const bare = parseClaude([user('an ordinary prompt'), asst('ok', 'm1'),
    user('<task-notification>\n<task-id>abc</task-id>\n')].map((r) => JSON.stringify(r)).join('\n'));
  check('a bare envelope still does not', () => {
    assert.equal(String(bare.digest.lastPromptText || '').includes('task-id'), false);
  });
}

fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`\npasted-prompt: ${failed} failed`); process.exit(1); }
console.log('\npasted-prompt: the operator\'s pasted text is unwrapped, kept, and shown once');
