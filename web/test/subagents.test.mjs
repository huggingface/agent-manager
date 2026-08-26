// What the reader can honestly say about a sub-agent.
//
// The records here are the shapes real transcripts use, copied from the three
// sessions on this machine that spawn sub-agents (release-video, the-gatherer,
// rl-llm-wiki, CLI 2.1.181–2.1.209). Two of them are the whole point:
//
//   1. a BACKGROUND spawn's `tool_result` is a RECEIPT, not an outcome. It
//      arrives two seconds after the call and says "Async agent launched
//      successfully". Treating a result as completion marks every sub-agent
//      finished the moment it starts — measured end to end on one agent, that
//      would have been 4m26s early, and all 60 sub-agents in the two largest
//      sessions here are background spawns.
//   2. the completion is the `<task-notification>`, which also carries what the
//      sub-agent spent — the only place that number is written down.
//
// Run with:  node test/subagents.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'exchanges-subagents.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/conversation/exchanges.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { splitExchanges, agentSpawnsOf, agentCounts } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const T0 = 1_787_000_000_000;
const at = (s) => T0 + s * 1000;
const spawn = (sec, id, description, type = 'general-purpose') => ({
  role: 'assistant', ts: at(sec),
  blocks: [{ type: 'tool_use', id, name: 'Agent', text: JSON.stringify({ description, subagent_type: type, run_in_background: true, prompt: 'do the thing' }, null, 2) }],
});
const receipt = (sec, id, agentId) => ({
  role: 'assistant', ts: at(sec),
  blocks: [{ type: 'tool_result', id, text:
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n'
    + `agentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background.` }],
});
const notification = (sec, id, status, { tokens = 41_700, calls = 13, ms = 172_127 } = {}) => ({
  role: 'system', ts: at(sec),
  blocks: [{ type: 'text', text:
    `<task-notification>\n<task-id>b6ctfcert</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>`
    + `\n<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${calls}</tool_uses><duration_ms>${ms}</duration_ms></usage>\n</task-notification>` }],
});
const prompt = (sec, text) => ({ role: 'user', ts: at(sec), blocks: [{ type: 'text', text }] });
const said = (sec, text) => ({ role: 'assistant', ts: at(sec), blocks: [{ type: 'text', text }] });

console.log('a launch receipt is not a finished sub-agent');
{
  const turns = [
    prompt(0, 'rebuild the four scenes'),
    spawn(4, 'toolu_A', 'Rework the Scene 1 intro'),
    receipt(6, 'toolu_A', 'ab2015f99ef3e7f43'),
    said(8, 'It is running; I will report when it lands.'),
  ];
  const [x] = splitExchanges(turns);
  const spawns = agentSpawnsOf(x, turns);
  check('the spawn is seen, with the task the operator would recognise', () => {
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].description, 'Rework the Scene 1 intro');
    assert.equal(spawns[0].agentType, 'general-purpose');
  });
  check('the agentId is read out of the receipt, so the row can open its transcript',
    () => assert.equal(spawns[0].agentId, 'ab2015f99ef3e7f43'));
  check('…and the receipt does NOT count as an outcome', () => {
    assert.equal(spawns[0].outcome, undefined);
    assert.equal(spawns[0].background, true);
  });
  check('so a live pane calls it running', () => assert.equal(agentCounts(spawns, true).label, '1 sub-agent · 1 running'));
  check('and a dead pane calls it unfinished, which is the third state',
    () => assert.equal(agentCounts(spawns, false).label, '1 sub-agent · 1 unfinished'));
}

console.log('\nthe notification is the outcome, and it says what was spent');
{
  const turns = [
    prompt(0, 'four scenes'),
    spawn(4, 'toolu_A', 'Rework the Scene 1 intro'),
    receipt(6, 'toolu_A', 'ab2015f99ef3e7f43'),
    spawn(8, 'toolu_B', 'Reshoot scene 3 with clean sidebar'),
    receipt(10, 'toolu_B', 'a441b23d799f09ede'),
    said(12, 'Both are running.'),
    // …and these arrive in a LATER turn, which is why the search is over the
    // window and not over the exchange.
    notification(1361, 'toolu_A', 'completed'),
    notification(940, 'toolu_B', 'failed'),
    said(2100, 'One is back, one failed.'),
  ];
  const [x] = splitExchanges(turns);
  const spawns = agentSpawnsOf(x, turns);
  check('both spawns are attributed to the turn that started them', () => assert.equal(spawns.length, 2));
  check('completed and failed are read from the notification, not guessed', () => {
    assert.equal(spawns[0].outcome, 'completed');
    assert.equal(spawns[1].outcome, 'failed');
  });
  check('the harness’s own duration, tool count and tokens come with it', () => {
    assert.equal(spawns[0].durationMs, 172_127);
    assert.equal(spawns[0].toolCalls, 13);
    assert.equal(spawns[0].tokens, 41_700);
  });
  check('the count says done and failed separately — and the pane being dead changes nothing here',
    () => {
      assert.equal(agentCounts(spawns, true).label, '2 sub-agents · 1 done · 1 failed');
      assert.equal(agentCounts(spawns, false).label, '2 sub-agents · 1 done · 1 failed');
    });
  check('a killed pane is neither done nor failed silently', () => {
    const killed = agentSpawnsOf(x, [...turns.slice(0, 6), notification(500, 'toolu_A', 'killed')]);
    assert.equal(killed[0].outcome, 'killed');
    assert.equal(agentCounts(killed, true).label, '2 sub-agents · 1 failed · 1 running');
  });
}

console.log('\na synchronous spawn is the one case where the result IS the outcome');
{
  const turns = [
    prompt(0, 'review the deploy config'),
    { role: 'assistant', ts: at(2), blocks: [{ type: 'tool_use', id: 'toolu_C', name: 'Task', text: JSON.stringify({ description: 'Review the deploy config', subagent_type: 'general-purpose' }, null, 2) }] },
    { role: 'assistant', ts: at(300), blocks: [{ type: 'tool_result', id: 'toolu_C', text: 'Only the health-check path changed: /healthz → /api/health.' }] },
  ];
  const [x] = splitExchanges(turns);
  const spawns = agentSpawnsOf(x, turns);
  check('the report it handed back marks it finished', () => {
    assert.equal(spawns[0].background, false);
    assert.equal(spawns[0].outcome, 'reported');
    assert.equal(spawns[0].outcomeAt, at(300));
  });
  check('and a failed result is a failure, not a report', () => {
    const bad = agentSpawnsOf(x, [turns[0], turns[1], { ...turns[2], blocks: [{ ...turns[2].blocks[0], failed: true }] }]);
    assert.equal(bad[0].outcome, 'failed');
  });
}

console.log('\nand nothing else in a turn is mistaken for a sub-agent');
{
  const turns = [
    prompt(0, 'check the timer'),
    { role: 'assistant', ts: at(2), blocks: [
      { type: 'tool_use', id: 'toolu_D', name: 'Bash', text: '{"command":"systemctl list-timers"}' },
      { type: 'tool_use', id: 'toolu_E', name: 'Read', text: '{"file_path":"runner.js"}' },
    ] },
    // a background BASH command gets the same notification shape, and it is not
    // a sub-agent: the strip counts spawns, and matches outcomes to them by id.
    notification(30, 'toolu_D', 'completed'),
  ];
  const [x] = splitExchanges(turns);
  check('a Bash and a Read are not sub-agents', () => assert.deepEqual(agentSpawnsOf(x, turns), []));
  check('…and a background command’s notification does not invent one',
    () => assert.equal(agentCounts(agentSpawnsOf(x, turns), true).total, 0));
}

console.log('\nand a prompt-shaped harness notification is not a prompt');
{
  // CLI 2.1.209 opens a task-notification inside a SUB-AGENT's transcript with
  // this marker instead of the tag, so the reader would otherwise start a new
  // exchange with harness noise in the prompt band.
  const turns = [
    prompt(0, 'review the articles'),
    said(4, 'Reading them now.'),
    prompt(30, '[SYSTEM NOTIFICATION - NOT USER INPUT] This is an automated message.\n<task-notification>\n<tool-use-id>toolu_Z</tool-use-id>\n<status>completed</status>\n</task-notification>'),
  ];
  check('it does not open a second exchange', () => assert.equal(splitExchanges(turns).length, 1));
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
