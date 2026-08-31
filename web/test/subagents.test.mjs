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
const { splitExchanges, agentSpawnsOf, agentCounts, agentStatus, isLive, anyLive, capRows, stepsOf, stepSummary, STALE_MS } = await import(pathToFileURL(out).href);

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

console.log('\nand a spawn is its own step row, never grouped into one');
{
  // Three spawns in a row is the real shape: release-video's turn 24 spawned
  // three inside ninety seconds. Grouped, they would be one `Agent ×3` row.
  // The server files a result next to the call that made it (the stitcher), so
  // a real spawn turn carries both blocks — which is also what makes grouping
  // dangerous: three of these in a row are three consecutive `Agent` calls.
  const spawnTurn = (sec, id, description, agentId) => ({
    role: 'assistant', ts: at(sec),
    blocks: [...spawn(sec, id, description).blocks, ...receipt(sec + 2, id, agentId).blocks],
  });
  const turns = [
    prompt(0, 'rebuild the three scenes'),
    spawnTurn(4, 'toolu_A', 'Recapture second-agent sequence', 'aaa1'),
    spawnTurn(8, 'toolu_B', 'Rapid-fire feature captures', 'aaa2'),
    spawnTurn(12, 'toolu_C', 'Add step legend to comms animation', 'aaa3'),
    { role: 'assistant', ts: at(20), blocks: [
      { type: 'tool_use', id: 'toolu_D', name: 'Bash', text: '{"command":"ffmpeg -v error -y"}' },
      { type: 'tool_use', id: 'toolu_E', name: 'Bash', text: '{"command":"du -sh sift"}' },
    ] },
  ];
  const steps = stepsOf(turns.slice(1));
  check('three spawns are three rows', () => {
    const agents = steps.filter((s) => s.kind === 'agent');
    assert.equal(agents.length, 3);
    assert.deepEqual(agents.map((a) => a.description),
      ['Recapture second-agent sequence', 'Rapid-fire feature captures', 'Add step legend to comms animation']);
  });
  check('…while two Bash calls still collapse into one, as they always did', () => {
    const tools = steps.filter((s) => s.kind === 'tools');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].count, 2);
  });
  check('and the summary line counts them as sub-agents rather than twice', () => {
    const [x] = splitExchanges(turns);
    const spawns = agentSpawnsOf(x, turns);
    const line = stepSummary(x, stepsOf(x.steps), spawns.length);
    assert.match(line, /3 sub-agents/);
    assert.match(line, /2 tools/, `the two Bash calls, not the five tool_uses: ${line}`);
    assert.doesNotMatch(line, /5 tools/);
  });
}

console.log('\nand the live strip only claims what it can');
{
  const spawnOf = (outcome) => ({ toolUseId: 't', description: 'Capture group view in reader', agentType: 'general-purpose', background: true, spawnedAt: at(0), ...(outcome ? { outcome } : {}) });
  const now = at(10_000);
  check('a live pane with a recent write is running', () => {
    assert.equal(agentStatus(spawnOf(), { live: true, lastWroteAt: now - 30_000, now }), 'running');
  });
  check('the same row on a pane that is not running says no result, never running', () => {
    assert.equal(agentStatus(spawnOf(), { live: false, lastWroteAt: now - 30_000, now }), 'no-result');
  });
  check('a silence longer than the threshold stops the claim', () => {
    assert.equal(agentStatus(spawnOf(), { live: true, lastWroteAt: now - STALE_MS - 1000, now }), 'stalled');
  });
  check('…and the threshold clears the longest silence ever measured inside a live run (601s)', () => {
    assert.ok(STALE_MS > 601_000 * 1.4, `${STALE_MS}ms must clear the 601s worst case with room`);
    assert.equal(agentStatus(spawnOf(), { live: true, lastWroteAt: now - 601_000, now }), 'running');
  });
  check('an outcome always wins over any amount of silence', () => {
    assert.equal(agentStatus(spawnOf('completed'), { live: true, lastWroteAt: now - 9e6, now }), 'done');
    assert.equal(agentStatus(spawnOf('killed'), { live: true, lastWroteAt: now, now }), 'killed');
  });
  check('two states count as still going, and four do not', () => {
    assert.deepEqual(['running', 'stalled', 'done', 'failed', 'killed', 'no-result'].filter(isLive), ['running', 'stalled']);
  });
  check('with no roster to read, a live pane still says running rather than guessing quiet', () => {
    assert.equal(agentStatus(spawnOf(), { live: true, now }), 'running');
  });
}

console.log('\nand the strip comes and goes as one thing, not row by row');
{
  const rowsOf = (...statuses) => statuses.map((status, i) => ({ status, id: `t${i}` }));
  check('while one is still going, the strip is shown', () => {
    assert.equal(anyLive(['done', 'done', 'running']), true);
    assert.equal(anyLive(['done', 'stalled']), true);
  });
  check('and when the last one lands it is gone — the rows are in the work', () => {
    assert.equal(anyLive(['done', 'failed', 'killed']), false);
    assert.equal(anyLive(['no-result']), false, 'a dead pane has nothing running under it');
    assert.equal(anyLive([]), false);
  });
  check('a finished sub-agent does NOT leave while a sibling runs', () => {
    // the rule the six-second linger used to soften, inverted: nothing is
    // dropped for being finished, so there is nothing to soften.
    const rows = rowsOf('done', 'running', 'done', 'running');
    const { shown, hidden } = capRows(rows, 10);
    assert.equal(shown.length, 4);
    assert.equal(hidden.length, 0);
  });
}

console.log('\nand the cap tells the truth about what it is holding back');
{
  const rowsOf = (...statuses) => statuses.map((status, i) => ({ status, id: `t${i}` }));
  check('under the cap, everything shows and nothing is said', () => {
    const { shown, note } = capRows(rowsOf('running', 'done'), 10);
    assert.equal(shown.length, 2);
    assert.equal(note, '');
  });
  check('over the cap, the finished rows give way and every live one is kept', () => {
    // release-video's busiest turn: 22 sub-agents, 4 still going at the end
    const rows = rowsOf(...Array(18).fill('done'), 'running', 'running', 'stalled', 'running');
    const { shown, hidden, note } = capRows(rows, 10);
    assert.equal(shown.length, 10);
    assert.equal(shown.filter((r) => ['running', 'stalled'].includes(r.status)).length, 4, 'all four live rows survive');
    assert.equal(hidden.length, 12);
    assert.ok(hidden.every((r) => r.status === 'done'), 'only finished rows gave way');
    assert.equal(note, '…and 12 more — 12 done — open the work to see them all');
  });
  check('…and the oldest finished go first, so the newest landings stay on screen', () => {
    const rows = rowsOf('done', 'done', 'done', 'running');
    const { shown } = capRows(rows, 2);
    assert.deepEqual(shown.map((r) => r.id), ['t2', 't3'], 't0 and t1 are the oldest finished');
  });
  check('when even the live rows do not fit, the line counts them by state', () => {
    const rows = rowsOf(...Array(6).fill('done'), ...Array(6).fill('running'));
    const { shown, note } = capRows(rows, 4);
    assert.equal(shown.length, 4);
    assert.ok(shown.every((r) => r.status === 'running'), 'live rows are the last to go');
    assert.equal(note, '…and 8 more — 6 done, 2 running — open the work to see them all');
  });
  check('and never says "running" about rows that are done', () => {
    const { note } = capRows(rowsOf(...Array(12).fill('done')), 10);
    assert.match(note, /2 done/);
    assert.doesNotMatch(note, /running/);
  });
}

console.log('\nand codex, whose plumbing is different in every part');
{
  // Record shapes from a real run on this machine (codex 0.149.1): three
  // `collaboration.spawn_agent` calls, each answered with an acknowledgement,
  // then one `agent_message` per child posting its FINAL_ANSWER back.
  const spawnAgent = (sec, callId, task) => ({
    role: 'assistant', ts: at(sec),
    blocks: [
      { type: 'tool_use', id: callId, name: 'spawn_agent', text: JSON.stringify({ task_name: task, fork_turns: 'all', message: 'gAAAAABqlYfWFbr-j04I4HN5d-YU…' }) },
      { type: 'tool_result', id: callId, text: JSON.stringify({ task_name: `/root/${task}` }) },
    ],
  });
  const waited = (sec, callId) => ({
    role: 'assistant', ts: at(sec),
    blocks: [
      { type: 'tool_use', id: callId, name: 'wait_agent', text: '{"timeout_ms":3600000}' },
      { type: 'tool_result', id: callId, text: '{"message":"Wait completed.","timed_out":false}' },
    ],
  });
  const finalAnswer = (sec, task, payload) => ({
    role: 'system', ts: at(sec),
    blocks: [{ type: 'text', text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/${task}\nPayload:\n${payload}` }],
  });
  // and the protocol documentation codex puts in its own developer prompt
  const protocolDoc = {
    role: 'system', ts: at(1),
    blocks: [{ type: 'text', text: 'You are `/root`… Message Type: MESSAGE | FINAL_ANSWER\nTask name: <task>\nSender: <author>\nPayload: <text>' }],
  };
  // …and the same explanation written with a real task in it, which is what a
  // loose match would happily read as "pty_summary finished".
  const protocolDocWithExample = {
    role: 'system', ts: at(1),
    blocks: [{ type: 'text', text: 'Posts look like: Message Type: MESSAGE | FINAL_ANSWER\nTask name: /root\nSender: /root/pty_summary\nPayload: <text>' }],
  };

  const turns = [
    protocolDoc,
    prompt(2, 'spawn three subagents, one summary each'),
    spawnAgent(18, 'call_nq41', 'pty_summary'),
    spawnAgent(20, 'call_dYuG', 'jsonl_summary'),
    spawnAgent(22, 'call_84zW', 'cron_summary'),
    waited(25, 'call_zPXG'),
    finalAnswer(28, 'pty_summary', 'A PTY is a software interface that behaves like a physical terminal.'),
    finalAnswer(31, 'jsonl_summary', 'JSONL is a text format where each line is one JSON value.'),
    said(40, 'All three are back.'),
  ];
  // codex opens with four system turns of its own, so the operator's prompt is
  // not the first thing in the file — take the exchange the prompt opened.
  const exchanges = splitExchanges(turns);
  const x = exchanges[exchanges.length - 1];
  const spawns = agentSpawnsOf(x, turns);
  check('three spawn_agent calls are three sub-agents', () => {
    assert.equal(spawns.length, 3);
    assert.deepEqual(spawns.map((s) => s.description), ['pty_summary', 'jsonl_summary', 'cron_summary']);
    assert.deepEqual(spawns.map((s) => s.taskName), ['pty_summary', 'jsonl_summary', 'cron_summary']);
  });
  check('the FINAL_ANSWER post is the completion, matched by task name', () => {
    assert.equal(spawns[0].outcome, 'reported');
    assert.equal(spawns[0].outcomeAt, at(28));
    assert.equal(spawns[1].outcome, 'reported');
  });
  check('the spawn acknowledgement is NOT a completion', () => {
    // `{"task_name":"/root/cron_summary"}` comes back instantly, like Claude's
    // async receipt. Reading it as a result marks every codex sub-agent done
    // the moment it starts.
    assert.equal(spawns[2].outcome, undefined);
    assert.equal(agentStatus(spawns[2], { live: true }), 'running');
    assert.equal(agentStatus(spawns[2], { live: false }), 'no-result');
  });
  check('"Wait completed." marks nothing — it names no agent', () => {
    const noPosts = agentSpawnsOf(x, turns.filter((t) => !(t.blocks[0].text || '').includes('FINAL_ANSWER')));
    assert.deepEqual(noPosts.map((s) => s.outcome), [undefined, undefined, undefined]);
  });
  check('and the protocol documentation does not complete a phantom sub-agent', () => {
    // "Message Type: MESSAGE | FINAL_ANSWER" with "Sender: <author>" is codex
    // explaining the format to itself, in the same thread.
    const noPostTurns = [protocolDoc, protocolDocWithExample, ...turns.slice(1, 6)];
    const docEx = splitExchanges(noPostTurns);
    const docOnly = agentSpawnsOf(docEx[docEx.length - 1], noPostTurns);
    assert.deepEqual(docOnly.map((s) => s.outcome), [undefined, undefined, undefined]);
  });
  check('the count and the states read the same as Claude’s', () => {
    assert.equal(agentCounts(spawns, true).label, '3 sub-agents · 2 done · 1 running');
    assert.equal(agentCounts(spawns, false).label, '3 sub-agents · 2 done · 1 unfinished');
  });
  check('a wait_agent call is not itself a sub-agent row', () => {
    const kinds = stepsOf(turns.slice(1)).filter((s) => s.kind === 'agent').map((s) => s.description);
    assert.deepEqual(kinds, ['pty_summary', 'jsonl_summary', 'cron_summary']);
  });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
