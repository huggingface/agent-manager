// What counts as the ANSWER, and what stays in the work.
//
// This is the one piece of judgement in the conversation renderer, and it has
// already been wrong twice: a superseded answer was re-inserted wherever the
// next one arrived (so an intermediate message rendered below the tool calls
// that came after it), and mid-task the last message was promoted to the answer
// slot (so an agent's aside read as its reply, in the wrong place).
//
// No test runner: esbuild is already here for vite, so the module is transpiled
// and imported directly. Run with:  node test/exchanges.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exch-')), 'exchanges.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/conversation/exchanges.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { splitExchanges, stepsOf, stepSummary, fmtTok } = await import(pathToFileURL(out).href);

let ts = 1_700_000_000_000;
const at = () => (ts += 30_000);
const text = (t) => ({ type: 'text', text: t });
const call = (name, arg) => ({ type: 'tool_use', name, text: JSON.stringify(arg) });
const result = (t, failed) => ({ type: 'tool_result', text: t, ...(failed ? { failed: true } : {}) });
const user = (t) => ({ role: 'user', ts: at(), blocks: [text(t)] });
const agent = (blocks, kind) => ({ role: 'assistant', ts: at(), ...(kind ? { kind } : {}), blocks });
// a prompt is one turn; an answer is the RUN of turns said after the last action
const said = (t) => {
  const turns = Array.isArray(t) ? t : [t].filter(Boolean);
  if (!turns.length) return null;
  return turns.map((x) => x.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')).join('\n\n');
};
const kinds = (steps) => steps.map((s) => (s.kind === 'tools' ? `${s.name}×${s.count}` : s.kind));

// ---------------------------------------------------------------- mid-task
// The agent has spoken twice and is still working: neither message is a reply,
// and both keep their place among the tool calls.
{
  const [x] = splitExchanges([
    user('why is the scan slow?'),
    agent([text('Let me look at what runs on an interval.'), call('Grep', { pattern: 'setInterval' }), result('runner.js:184')]),
    agent([text('There it is — a sync stat sweep.'), call('Read', { file_path: 'runner.js' }), result('statSync(f)')]),
    agent([call('Edit', { file_path: 'runner.js' }), result('Applied 1 edit')]),
  ]);
  assert.deepEqual(x.answer, [], 'work in flight is not an answer');
  assert.deepEqual(kinds(stepsOf(x.steps)),
    ['note', 'Grep×1', 'note', 'Read×1', 'Edit×1'],
    'messages stay above the calls they introduced');
  assert.equal(x.toolCalls, 3);
}

// ---------------------------------------------------------------- finished
// The last turn ended on words: that is the reply, and it leaves the work.
{
  const [x] = splitExchanges([
    user('why is the scan slow?'),
    agent([text('Looking.'), call('Read', { file_path: 'runner.js' }), result('…')]),
    agent([text('Found it: the tick stats synchronously.')]),
  ]);
  assert.equal(said(x.answer), 'Found it: the tick stats synchronously.');
  assert.deepEqual(kinds(stepsOf(x.steps)), ['note', 'Read×1'], 'the answer is not also a step');
}

// A turn that says something and then calls a tool has not answered yet.
{
  const [x] = splitExchanges([
    user('go'),
    agent([text('One more check.'), call('Bash', { command: 'npm test' }), result('ok')]),
  ]);
  assert.deepEqual(x.answer, [], 'ending on a tool call is not ending on words');
}

// ------------------------------------------------------- a superseded final
// Two finals (a resumed task): the later one answers, the earlier one stays
// where it happened rather than being appended after the work that followed it.
{
  const [x] = splitExchanges([
    user('ship it'),
    agent([text('Pushed.')], 'final'),
    agent([call('Bash', { command: 'gh pr create' }), result('#37')]),
    agent([text('PR is up: #37.')], 'final'),
  ]);
  assert.equal(said(x.answer), 'PR is up: #37.');
  assert.deepEqual(kinds(stepsOf(x.steps)), ['note', 'Bash×1'], 'the earlier final keeps its position');
}

// ------------------------------------------------- a throwaway after the answer
// Seen live: the harness marks the last assistant text of a request `final`,
// and that was "No response requested." — written in reply to a notification,
// with the real answer in the turn above. Taking only the last `final` buried
// the answer in the work and showed the boilerplate as the reply.
{
  const [x] = splitExchanges([
    user('any news on hugging face?'),
    agent([text("I'll search the web for this."), call('WebSearch', { query: 'hugging face' }), result('…')]),
    agent([text("Here's the latest on the incident: …")]),
    agent([text('No response requested.')], 'final'),
  ]);
  assert.equal(said(x.answer),
    "Here's the latest on the incident: …\n\nNo response requested.",
    'everything said after the last action is the answer');
  assert.deepEqual(kinds(stepsOf(x.steps)), ['note', 'WebSearch×1'], 'and none of it is left in the work');
}

// --------------------------------------------------------------- splitting
// One exchange per operator prompt; harness-authored "user" lines are not
// prompts, and neither is an interrupt marker.
{
  const xs = splitExchanges([
    user('first'),
    agent([text('a')], 'final'),
    { role: 'user', ts: at(), blocks: [text('<system-reminder>budget</system-reminder>')] },
    { role: 'user', ts: at(), blocks: [text('[Request interrupted by user]')] },
    user('second'),
    agent([text('b')], 'final'),
  ]);
  assert.equal(xs.length, 2, 'two prompts, two turns');
  assert.deepEqual(xs.map((x) => said(x.prompt)), ['first', 'second']);
  assert.equal(xs[0].steps.length, 2, 'the harness lines belong to the first turn, as work');
}

// Turns before any prompt (a tail that starts mid-conversation) still render.
{
  const xs = splitExchanges([agent([text('…continuing')], 'final')]);
  assert.equal(xs.length, 1);
  assert.equal(xs[0].prompt, null);
  assert.equal(said(xs[0].answer), '…continuing');
}

// ------------------------------------------------------------- step lines
// Consecutive calls to the SAME tool collapse; a different tool breaks the run,
// and a failed result marks the group.
{
  const [x] = splitExchanges([
    user('read them'),
    agent([call('Read', { file_path: '/a/b/one.ts' }), result('…'), call('Read', { file_path: '/a/b/two.ts' }), result('…')]),
    agent([call('Bash', { command: 'false' }), result('exit 1', true)]),
    agent([call('Read', { file_path: '/a/b/three.ts' }), result('…')]),
    agent([text('done')], 'final'),
  ]);
  const steps = stepsOf(x.steps);
  assert.deepEqual(kinds(steps), ['Read×2', 'Bash×1', 'Read×1']);
  assert.equal(steps[0].details[0], '…/b/one.ts', 'a path keeps its last two parts');
  assert.equal(steps[1].failed, true, 'a failed result marks its group');
  assert.equal(steps[2].failed, false);
  assert.equal(stepSummary(x, steps).startsWith('3 steps · 4 tools'), true, stepSummary(x, steps));
}

// A tool call the reader had to cut mid-JSON still names what it acted on.
{
  const [x] = splitExchanges([
    user('edit it'),
    agent([{ type: 'tool_use', name: 'Edit', text: '{"file_path": "server/src/runner.js", "old_str' }]),
  ]);
  assert.equal(stepsOf(x.steps)[0].details[0], 'server/src/runner.js');
}

// ------------------------------------------------------------- formatting
assert.equal(fmtTok(954), '954');
assert.equal(fmtTok(21_000), '21.0k');
assert.equal(fmtTok(654_321), '654k', 'no decimal where it says nothing');
assert.equal(fmtTok(2_200_000), '2.2M');
assert.equal(fmtTok(1_400_000_000), '1.4B');

fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log('exchanges: ok');
