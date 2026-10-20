// A prompt typed while the agent is mid-turn.
//
// Claude Code does not write it as a `user` message. It writes
//   {"type":"queue-operation","operation":"enqueue","content":"<the prompt>"}
// and then either `dequeue` (the prompt arrives as an ordinary user message
// afterwards) or `remove` (it never does). Before this, `queue-operation`
// appeared nowhere in the repo, so every mid-turn prompt was invisible in the
// reader — permanently, not late. Two of the operator's own prompts were lost
// that way, which is the regression nobody would notice coming back.
//
// Run with:  node test/queued-prompts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTraceByPath } from '../src/traces.js';

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-queued-'));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const textOf = (m) => norm((m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '));

let clock = Date.UTC(2026, 7, 20, 8, 0, 0);
const at = () => new Date((clock += 5000)).toISOString();
const user = (text) => ({ type: 'user', timestamp: at(), cwd: '/w', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (text) => ({ type: 'assistant', timestamp: at(), cwd: '/w', message: { id: `m${clock}`, role: 'assistant', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text }] } });
const tool = (name) => ({ type: 'assistant', timestamp: at(), cwd: '/w', message: { id: `t${clock}`, role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: `u${clock}`, name, input: { file_path: '/w/x.js' } }] } });
const queue = (operation, content) => ({ type: 'queue-operation', operation, sessionId: 's', timestamp: at(), ...(content === undefined ? {} : { content }) });

const write = (name, records) => {
  const f = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(f, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return f;
};
const read = async (f) => {
  const page = await readTraceByPath(f, { limit: 500 });
  return (page.turns || []);
};

// ---- the operator's case: queued, then removed, and never written as a message
{
  const f = write('removed', [
    user('start the nightly job'),
    tool('Bash'),
    queue('enqueue', 'ok, now API feedback. the user should be excluded by default'),
    queue('remove', 'ok, now API feedback. the user should be excluded by default'),
    assistant('Done — the job is running.'),
  ]);
  const turns = await read(f);
  const prompts = turns.filter((m) => m.role === 'user' && textOf(m));
  check('a queued prompt that was removed is shown', () => {
    assert.equal(prompts.length, 2, `expected the real prompt and the queued one, got ${prompts.map(textOf)}`);
    assert.match(textOf(prompts[1]), /^ok, now API feedback/);
  });
  check('…and it says it was queued', () => assert.equal(prompts[1].queued, true));
  check('…while an ordinary prompt does not', () => assert.equal(prompts[0].queued, undefined));
  check('…and it keeps the time it was typed', () => assert.ok(prompts[1].ts > prompts[0].ts));
}

// ---- the common case: queued, dequeued, and the real message arrives
{
  const f = write('dequeued', [
    user('start the nightly job'),
    tool('Bash'),
    queue('enqueue', 'and check the watcher after'),
    queue('dequeue'),
    user('and check the watcher after'),
    assistant('Both done.'),
  ]);
  const prompts = (await read(f)).filter((m) => m.role === 'user' && textOf(m));
  check('a dequeued prompt is shown once, by its real message', () => {
    assert.equal(prompts.length, 2, `expected no duplicate, got ${prompts.map(textOf)}`);
    assert.equal(textOf(prompts[1]), 'and check the watcher after');
    assert.equal(prompts[1].queued, undefined, 'the real message should be the copy that survives');
  });
}

// ---- two queued at once, one taken and one removed: order and pairing hold
{
  const f = write('both-paths', [
    user('first'),
    tool('Read'),
    queue('enqueue', 'second, queued and taken'),
    queue('enqueue', 'third, queued and removed'),
    queue('dequeue'),
    user('second, queued and taken'),
    queue('remove', 'third, queued and removed'),
    assistant('all three answered'),
  ]);
  const prompts = (await read(f)).filter((m) => m.role === 'user' && textOf(m));
  check('the taken one comes from its message, the removed one from the queue', () => {
    assert.deepEqual(prompts.map(textOf), ['first', 'third, queued and removed', 'second, queued and taken']);
    assert.deepEqual(prompts.map((m) => !!m.queued), [false, true, false]);
  });
}

// ---- the same words queued twice: FIFO, not "drop them all"
{
  const f = write('twice', [
    user('go'),
    queue('enqueue', 'same words'),
    queue('enqueue', 'same words'),
    queue('dequeue'),
    user('same words'),
    queue('remove', 'same words'),
    assistant('ok'),
  ]);
  const prompts = (await read(f)).filter((m) => m.role === 'user' && textOf(m));
  check('one copy survives per prompt, not none and not four', () => {
    assert.equal(prompts.filter((m) => textOf(m) === 'same words').length, 2);
    assert.equal(prompts.filter((m) => m.queued).length, 1);
  });
}

// ---- harness noise must not become a prompt
{
  const f = write('noise', [
    user('go'),
    queue('enqueue', '<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
    queue('remove', '<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
    queue('enqueue', '[Request interrupted by user]'),
    queue('remove', '[Request interrupted by user]'),
    assistant('ok'),
  ]);
  const prompts = (await read(f)).filter((m) => m.role === 'user' && textOf(m));
  check('an enqueued task-notification is not shown as something the operator typed', () => {
    assert.equal(prompts.length, 1, `only the real prompt should be a prompt, got ${prompts.map((m) => textOf(m).slice(0, 24))}`);
    assert.equal(textOf(prompts[0]), 'go');
  });
}

// ---- still in the queue when the window ends: the message is coming, so wait
{
  const f = write('pending', [
    user('go'),
    tool('Bash'),
    queue('enqueue', 'typed while it works, not taken yet'),
  ]);
  const prompts = (await read(f)).filter((m) => m.role === 'user' && textOf(m));
  check('a prompt still in the queue is left to its message rather than shown twice', () => {
    assert.equal(prompts.length, 1);
    assert.equal(textOf(prompts[0]), 'go');
  });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
