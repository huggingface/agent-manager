// Reading a SUB-AGENT's transcript, on both harnesses.
//
// The bug this pins: a codex sub-agent is spawned with `fork_turns: "all"`, so
// its rollout opens with the parent's entire conversation copied into it and
// only then the task it was given. Rendered whole, an expanded sub-agent showed
// the parent's history — the operator's report was "the sub agents expanded
// seem to mirror the main agent trace". It is the file that says that, not the
// renderer, so the trim is here.
//
// Also pinned: a sub-agent rollout stays refused as a SESSION view, and is only
// readable through the deliberate path.
// Run with:  node test/subagent-traces.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-trace-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { readTraceByPath } = await import('../src/traces.js');

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const at = (s) => new Date(Date.UTC(2026, 7, 31, 13, 55, s)).toISOString();
const rec = (type, payload, sec) => JSON.stringify({ timestamp: at(sec), type, payload });

// A codex sub-agent rollout in the real shape: its own header, the parent's
// header, the forked conversation, the NEW_TASK hand-off, then its own work.
const child = path.join(TMP, 'rollout-2026-08-31T13-55-34-01a0581a-9c0c-child.jsonl');
fs.writeFileSync(child, [
  rec('session_meta', { id: '01a0581a-9c0c', cwd: TMP, thread_source: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: '01a0581a-5757', depth: 1, agent_path: '/root/pty_summary', agent_nickname: 'Curie' } } } }, 34),
  rec('session_meta', { id: '01a0581a-5757', cwd: TMP, thread_source: 'user', source: 'cli' }, 34),
  rec('event_msg', { type: 'task_started', turn_id: 'parent-turn' }, 34),
  rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'THE PARENT PROMPT: rebuild the five scenes' }] }, 34),
  rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'THE PARENT ANSWER: spawning three' }] }, 34),
  rec('event_msg', { type: 'task_started', turn_id: 'child-turn' }, 34),
  rec('response_item', { type: 'agent_message', author: '/root', recipient: '/root/pty_summary',
    content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/pty_summary\nSender: /root\nPayload:\n' },
              { type: 'encrypted_content', encrypted_content: 'gAAAAAB…' }] }, 35),
  rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ITS OWN WORK: reading the file' }] }, 39),
  rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ITS OWN ANSWER: a PTY is a pseudo-terminal.' }] }, 44),
].join('\n') + '\n');

console.log('a codex sub-agent renders its own conversation, not the one it was forked from');
{
  const w = await readTraceByPath(child, { offset: 0, limit: 50 }, true);
  const text = w.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
  check('the forked parent turns are gone', () => {
    assert.doesNotMatch(text, /THE PARENT PROMPT/);
    assert.doesNotMatch(text, /THE PARENT ANSWER/);
  });
  check('and everything the child itself did is there', () => {
    assert.match(text, /ITS OWN WORK/);
    assert.match(text, /ITS OWN ANSWER/);
  });
  check('the hand-off marks the boundary and stays as a system turn', () => {
    assert.match(text, /Message Type: NEW_TASK/);
    assert.equal(w.turns[0].role, 'system');
  });
  check('the encrypted payload is not rendered as content', () => assert.doesNotMatch(text, /gAAAAAB/));
}

console.log('\nand a codex sub-agent with no hand-off in view is shown whole, not empty');
{
  // A rollout whose NEW_TASK is outside the window — or a spawn shape that never
  // wrote one. Trimming to a guessed offset would leave the row empty, which is
  // worse than showing more than its own work.
  const noHandoff = path.join(TMP, 'rollout-2026-08-31T13-55-40-01a0581a-nohandoff.jsonl');
  fs.writeFileSync(noHandoff, [
    rec('session_meta', { id: '01a0581a-bbbb', cwd: TMP, thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: '01a0581a-5757', depth: 1, agent_path: '/root/late', agent_nickname: 'Kepler' } } } }, 40),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MID-TASK: still measuring' }] }, 41),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ITS ANSWER: 41 files' }] }, 42),
  ].join('\n') + '\n');
  const w = await readTraceByPath(noHandoff, { offset: 0, limit: 50 }, true);
  const text = w.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
  check('it still has its turns', () => {
    assert.ok(w.turns.length >= 2, `expected the whole thing, got ${w.turns.length} turns`);
    assert.match(text, /MID-TASK/);
    assert.match(text, /ITS ANSWER/);
  });
}

console.log('\nand a sub-agent rollout is still not a session view');
{
  let code = null;
  try { await readTraceByPath(child, { offset: 0, limit: 50 }); } catch (e) { code = e.code; }
  check('reading it as a session is refused, as it always was',
    () => assert.equal(code, 'trace-not-user-conversation'));
}

console.log('\nand a CLAUDE fork does not render itself as its own child');
{
  // `subagent_type: "fork"` inherits the parent's transcript, and the LAST
  // inherited record is the Agent call that created this fork — so read whole,
  // the fork appears to have spawned itself, and opening that row opens the
  // same file again. The harness marks the boundary itself.
  const fork = path.join(TMP, 'agent-a69e9dcf7fcc38c68.jsonl');
  const spawnId = 'toolu_01EMfLbhWBZwwwT5dv5psJwS';
  fs.writeFileSync(fork, [
    JSON.stringify({ type: 'user', isSidechain: true, cwd: TMP, timestamp: at(5),
      message: { role: 'user', content: 'THE PARENT PROMPT: research the week' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, cwd: TMP, timestamp: at(6),
      message: { id: 'p1', role: 'assistant', content: [
        { type: 'tool_use', id: spawnId, name: 'Agent',
          input: { subagent_type: 'fork', description: 'Research Meta news', prompt: 'Use WebSearch…' } }] } }),
    JSON.stringify({ type: 'user', isSidechain: true, cwd: TMP, timestamp: at(6),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: spawnId, content: 'Fork started — processing in background' }] } }),
    JSON.stringify({ type: 'user', isSidechain: true, cwd: TMP, timestamp: at(7),
      message: { role: 'user', content: '<fork-boilerplate>\nYou are a worker fork. The transcript above is the parent\u2019s history — inherited reference, not your situation.' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, cwd: TMP, timestamp: at(9),
      message: { id: 'c1', role: 'assistant', content: [{ type: 'text', text: 'ITS OWN ANSWER: Meta shipped three things.' }] } }),
  ].join('\n') + '\n');

  const w = await readTraceByPath(fork, { offset: 0, limit: 50 }, true);
  const text = w.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
  const spawnsInside = w.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'tool_use' && b.name === 'Agent'));
  check('the inherited parent turns are gone', () => assert.doesNotMatch(text, /THE PARENT PROMPT/));
  check('…including the Agent call that created it, so it is not its own child',
    () => assert.deepEqual(spawnsInside, [], 'a fork must not carry its own spawning call'));
  check('and its own answer is there', () => assert.match(text, /ITS OWN ANSWER/));
  // (a fork's sidechain is not refused the way a codex subagent rollout is, so
  // the untrimmed read is what any other caller still gets — awaited out here,
  // because `check` runs its callback synchronously)
  const whole = await readTraceByPath(fork, { offset: 0, limit: 50 });
  const wholeText = whole.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
  check('read as a session, the same file is unchanged — the trim is opt-in',
    () => assert.match(wholeText, /THE PARENT PROMPT/));
}

console.log('\nand a sub-agent with no fork is shown whole');
{
  // Claude's children are not forks: their transcript begins with the task.
  const claudeChild = path.join(TMP, 'agent-a441b23d799f09ede.jsonl');
  fs.writeFileSync(claudeChild, [
    JSON.stringify({ type: 'user', isSidechain: true, agentId: 'a441b23d799f09ede', cwd: TMP, timestamp: at(10),
      message: { role: 'user', content: 'Reshoot scene 3 with a clean sidebar.' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a441b23d799f09ede', cwd: TMP, timestamp: at(20),
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Done — the plate is clean.' }] } }),
  ].join('\n') + '\n');
  const w = await readTraceByPath(claudeChild, { offset: 0, limit: 50 }, true);
  const text = w.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
  check('the task it was given is the first thing in it', () => {
    assert.match(text, /Reshoot scene 3/);
    assert.equal(w.turns[0].role, 'user');
  });
  check('…and its answer is the last', () => assert.match(text, /the plate is clean/));
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
