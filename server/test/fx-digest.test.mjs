// The fx transcript reader: digest, attribution, harness sniffing and the
// trace-panel normalizer.
//
// fx is unlike the other jsonl harnesses in one important way: a whole exchange
// lands in ONE `history_turn_committed` event (prompt + final answer together),
// and nothing durable is written mid-turn except a `recovery_checkpoint_set`
// carrying the prompt and only partial assistant text. The event shapes below
// are taken from a real fx v0.0.5 session log. Run with:
//   node test/fx-digest.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-digest-'));
process.env.HOME = path.join(TMP, 'home');
process.env.DATA_DIR = path.join(TMP, 'data');
// Keep the other harnesses out of this run: they would scan the real machine.
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'no-claude');
process.env.CODEX_HOME = path.join(TMP, 'no-codex');
const WORKSPACES = path.join(process.env.DATA_DIR, 'workspaces');
fs.mkdirSync(WORKSPACES, { recursive: true });

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = Object.is(got, want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

const GEN = 'a'.repeat(32);
let seq = 0;
const ev = (kind, payload, ms) => JSON.stringify({
  schema_version: 1, log_generation: GEN, seq: ++seq,
  event_id: String(seq).padStart(32, '0'), timestamp_ms: ms, kind, payload,
});

const started = (id, root, ms) => ev('session_started', {
  id, created_at_ms: ms, origin_workspace_root: root, workspace_root: root,
  conversation_language: 'und-Latn',
}, ms);

const committed = (turn, ms, tin = 0, tout = 0) => ev('history_turn_committed', {
  conversation_language: 'und-Latn', total_input_tokens: tin, total_output_tokens: tout, turn,
}, ms);

// Write a session directory exactly as fx lays one out.
function fxSession(id, root, lines, { updatedAtMs, createdAtMs } = {}) {
  const dir = path.join(process.env.HOME, '.fx', 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    schema_version: 3, id, workspace_root: root, origin_workspace_root: root,
    created_at_ms: createdAtMs ?? 1000, updated_at_ms: updatedAtMs ?? 2000,
  }));
  return dir;
}

const T0 = 1787565046000;
const dirFor = (folder) => path.join(WORKSPACES, folder);

// --- A: two complete turns, pinned to a session -----------------------------
fxSession('sess-a', dirFor('alpha'), [
  started('sess-a', dirFor('alpha'), T0),
  committed({
    kind: 'assistant',
    user: { text: 'first question', images: [] },
    assistant: 'first answer',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 10, 120, 30),
  committed({
    kind: 'assistant',
    user: { text: 'second question', images: [] },
    assistant: 'second answer',
    execution: {
      schema_version: 3,
      tool_steps: [{
        assistant: 'let me look',
        tool_calls: [{ id: 'c1', name: 'read_file', arguments_json: '{"path":"/w/a.js"}', provider_result: null }],
        tool_results: [{ tool_call_id: 'c1', tool_name: 'read_file', status: 'ok', output: 'contents' }],
      }],
      files: [{ path: '/w/a.js', tool_name: 'edit_file', action: 'modified', status: 'ok' }],
    },
  }, T0 + 20, 200, 70),
]);

// --- B: a turn in flight (checkpoint written, not yet committed) ------------
fxSession('sess-b', dirFor('bravo'), [
  started('sess-b', dirFor('bravo'), T0),
  committed({
    kind: 'assistant', user: { text: 'old question', images: [] }, assistant: 'old answer',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 10, 50, 10),
  ev('recovery_checkpoint_set', {
    checkpoint: {
      version: 1, turn_id: 2, user: { text: 'live question', images: [] },
      assistant_source: 'half-written th', cause: 'network_interrupted', action: 'retrying_request',
    },
  }, T0 + 20),
]);

// --- C: interrupted turn, plus base64 durable bytes and a compaction marker --
fxSession('sess-c', dirFor('charlie'), [
  started('sess-c', dirFor('charlie'), T0),
  committed({ kind: 'compacted_summary', summary: 'earlier turns summarised', removed_turn_count: 3 }, T0 + 5),
  committed({
    kind: 'interrupted',
    user: { text: 'cancelled question', images: [] },
    assistant: 'partial tho',
    terminal_reason: 'cancelled',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 20, 15, 8),
]);

// --- G: text stored as durable base64 bytes (invalid UTF-8 in the original) --
fxSession('sess-g', dirFor('golf'), [
  started('sess-g', dirFor('golf'), T0),
  committed({
    kind: 'assistant',
    user: { text: { encoding: 'base64', data: Buffer.from('bytes prompt').toString('base64') } },
    assistant: { encoding: 'base64', data: Buffer.from('bytes answer').toString('base64') },
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 10, 10, 5),
]);

// --- D + E: two unpinned sessions sharing one folder (ambiguous) ------------
fxSession('sess-d', dirFor('delta'), [
  started('sess-d', dirFor('delta'), T0),
  committed({
    kind: 'assistant', user: { text: 'from d', images: [] }, assistant: 'answer d',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 10, 1, 1),
]);
fxSession('sess-e', dirFor('delta'), [
  started('sess-e', dirFor('delta'), T0),
  committed({
    kind: 'assistant', user: { text: 'from e', images: [] }, assistant: 'answer e',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 10, 1, 1),
]);

// --- F: a session that was rebound to another folder ------------------------
fxSession('sess-f', dirFor('foxtrot'), [
  started('sess-f', dirFor('elsewhere'), T0),
  ev('workspace_rebound', { previous_workspace_root: dirFor('elsewhere'), workspace_root: dirFor('foxtrot') }, T0 + 1),
  committed({
    kind: 'assistant', user: { text: 'after the move', images: [] }, assistant: 'moved answer',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 10, 3, 2),
]);

// --- H: a turn abandoned without committing (checkpoint set, then cleared) --
fxSession('sess-h', dirFor('hotel'), [
  started('sess-h', dirFor('hotel'), T0),
  ev('recovery_checkpoint_set', {
    checkpoint: { version: 1, turn_id: 1, user: { text: 'abandoned question', images: [] }, assistant_source: 'half' },
  }, T0 + 10),
  ev('recovery_checkpoint_cleared', {}, T0 + 20),
]);

// --- I: a SECOND fx conversation in the pinned pane's folder ----------------
// Not pinned to any pane, and newer than sess-a. It must not be folded into the
// pinned pane, which resumes sess-a and would otherwise display this instead.
fxSession('sess-i', dirFor('alpha'), [
  started('sess-i', dirFor('alpha'), T0 + 100),
  committed({
    kind: 'assistant', user: { text: 'someone else asked', images: [] }, assistant: 'foreign answer',
    execution: { schema_version: 3, tool_steps: [], files: [] },
  }, T0 + 200, 9999, 9999),
], { createdAtMs: T0 + 100, updatedAtMs: T0 + 200 });

// --- J: two tool calls inside ONE step, each with its own result ------------
fxSession('sess-j', dirFor('juliet'), [
  started('sess-j', dirFor('juliet'), T0),
  committed({
    kind: 'assistant',
    user: { text: 'run both', images: [] },
    assistant: 'ran both',
    execution: {
      schema_version: 3,
      tool_steps: [{
        assistant: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', arguments_json: '{"path":"/w/one"}', provider_result: null },
          { id: 'c2', name: 'run_command', arguments_json: '{"cmd":"ls"}', provider_result: null },
        ],
        tool_results: [
          { tool_call_id: 'c1', tool_name: 'read_file', status: 'ok', output: 'one contents' },
          { tool_call_id: 'c2', tool_name: 'run_command', status: 'ok', output: 'two contents' },
        ],
      }],
      files: [],
    },
  }, T0 + 10, 5, 5),
]);

// --- K: a compaction commit, which carries token totals but no user turn ----
fxSession('sess-k', dirFor('kilo'), [
  started('sess-k', dirFor('kilo'), T0),
  committed({ kind: 'compacted_summary', summary: 'summary of earlier work', removed_turn_count: 9 }, T0 + 10, 40, 20),
]);

// Seed the session store: A is pinned by id, the rest match by folder.
fs.writeFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), JSON.stringify([
  { id: 'am-a', name: 'a', cli: 'fx', path: 'alpha', fxSessionId: 'sess-a' },
  { id: 'am-b', name: 'b', cli: 'fx', path: 'bravo' },
  { id: 'am-c', name: 'c', cli: 'fx', path: 'charlie' },
  { id: 'am-d1', name: 'd1', cli: 'fx', path: 'delta' },
  { id: 'am-d2', name: 'd2', cli: 'fx', path: 'delta' },
  { id: 'am-f', name: 'f', cli: 'fx', path: 'foxtrot' },
  { id: 'am-g', name: 'g', cli: 'fx', path: 'golf' },
  { id: 'am-h', name: 'h', cli: 'fx', path: 'hotel' },
  { id: 'am-j', name: 'j', cli: 'fx', path: 'juliet' },
  { id: 'am-k', name: 'k', cli: 'fx', path: 'kilo' },
]));

const store = await import('../src/sessions.js');
store.init();
const traces = await import('../src/traces.js');

const digests = await traces.traceDigests();
const A = digests.get('am-a');
const B = digests.get('am-b');
const C = digests.get('am-c');
const F = digests.get('am-f');
const G = digests.get('am-g');
const H = digests.get('am-h');
const K = digests.get('am-k');

console.log('a committed turn carries both halves of the exchange');
check('last prompt is the newest one', A && A.lastPromptText, 'second question');
check('last answer is the newest one', A && A.lastAssistantText, 'second answer');
check('the previous answer did not leak into this segment', A && A.turnsLog.length, 0);
check('touched files come from the turn evidence', A && A.sinceFiles.join(), '/w/a.js');
check('tool calls are counted', A && A.sinceToolCalls, 1);
check('tool names are recorded', A && A.sinceTools.read_file, 1);
// Totals are cumulative per session, so "since the last prompt" is the delta
// across that turn: (200+70) - (120+30).
check('sinceTokens is this turn, not the session', A && A.sinceTokens, 120);

console.log('\na turn still in flight shows the prompt and no answer');
check('prompt comes from the checkpoint', B && B.lastPromptText, 'live question');
check('the previous answer is not shown as this one', B && B.lastAssistantText, '');
check('partial assistant text is never the answer', B && B.lastAssistantMd, '');
check('the pane reads as running', B && B.running, true);

console.log('\ninterrupted, compacted and base64 turns');
check('an interrupted prompt is still the last prompt', C && C.lastPromptText, 'cancelled question');
check('its partial text is not a final answer', C && C.lastAssistantText, '');
check('durable base64 bytes decode in the prompt', G && G.lastPromptText, 'bytes prompt');
check('...and in the answer', G && G.lastAssistantText, 'bytes answer');

console.log('\na turn that ends without committing stops running');
// fx clears the checkpoint instead of committing when a turn is abandoned or
// fails. No commit ever arrives, so this is the only signal the turn is over.
check('the prompt still stands', H && H.lastPromptText, 'abandoned question');
check('the pane is no longer running', H && H.running, false);
check('nothing is passed off as an answer', H && H.lastAssistantText, '');

console.log('\nattribution');
check('an unpinned session in a shared folder gets nothing', digests.has('am-d1'), false);
check('...and neither does its neighbour', digests.has('am-d2'), false);
check('rebinding follows the CURRENT workspace_root', F && F.lastPromptText, 'after the move');

// A folder can hold conversations this pane never owned — older ones, or some
// started outside Agent Manager. Only an UNPINNED pane may claim a log by folder.
check('a pinned pane keeps its own conversation', A && A.lastAssistantText, 'second answer');
check('...and does not absorb a foreign one\'s tokens', A && A.sinceTokens, 120);

console.log('\na compaction commit still carries the session totals');
check('tokens are not lost at compaction', K && K.sinceTokens, 60);

console.log('\nthe pinned fast path agrees with the bulk pass');
const direct = await traces.digestFor({ id: 'am-a', cli: 'fx', path: 'alpha', fxSessionId: 'sess-a' });
check('digestFor returns the same last answer', direct && direct.lastAssistantText, 'second answer');
const loc = await traces.traceLocation({ id: 'am-a', cli: 'fx', fxSessionId: 'sess-a' });
check('traceLocation points at events.jsonl', loc && path.basename(loc.path), 'events.jsonl');
check('...as jsonl', loc && loc.format, 'jsonl');
const gone = await traces.traceLocation({ id: 'am-x', cli: 'fx', fxSessionId: 'not-a-session' });
check('a purged pin has no location', gone, null);

console.log('\ncapture-and-pin');
const hit = traces.captureFxSession(dirFor('alpha'), 0, new Set());
check('takes the newest conversation bound to the folder', hit && hit.id, 'sess-i');
const mine = traces.captureFxSession(dirFor('alpha'), 0, new Set(['sess-i']));
check('...and the next one down once that is claimed', mine && mine.id, 'sess-a');
const claimed = traces.captureFxSession(dirFor('alpha'), 0, new Set(['sess-a', 'sess-i']));
check('skips ones a sibling already claims', claimed, null);
// The floor is what stops a pane adopting a conversation that was already in the
// folder when it launched — here sess-i, which belongs to nobody.
check('skips conversations older than the pane',
  traces.captureFxSession(dirFor('alpha'), T0 + 150, new Set(['sess-a'])), null);
check('a live pin exists', traces.fxSessionExists('sess-a'), true);
check('a purged pin does not', traces.fxSessionExists('nope'), false);

console.log('\nharness sniffing (fx events all carry a payload, like codex)');
const eventsA = path.join(process.env.HOME, '.fx', 'sessions', 'sess-a', 'events.jsonl');
check('an fx log is not mistaken for codex', await traces.traceHarnessOf(eventsA), 'fx');

console.log('\nthe trace panel renders the exchange');
const view = await traces.readTraceByPath(eventsA);
const roles = view.turns.map((m) => m.role).join(',');
check('user and assistant alternate', roles, 'user,assistant,user,assistant');
check('the workspace is reported', view.cwd, dirFor('alpha'));
check('session usage is the last cumulative total', view.usage && view.usage.in, 200);
const last = view.turns[view.turns.length - 1];
check('the answer is the final block', last.blocks[last.blocks.length - 1].text, 'second answer');
check('a tool call is rendered', last.blocks.some((b) => b.type === 'tool_use' && b.name === 'read_file'), true);
check('its result is rendered too', last.blocks.some((b) => b.type === 'tool_result'), true);
check('the answer is marked final', last.kind, 'final');

console.log('\nparallel tool calls keep their own results');
// The reader groups a result with the call it directly follows, so appending
// all results after all calls would hand both to the second call.
const eventsJ = path.join(process.env.HOME, '.fx', 'sessions', 'sess-j', 'events.jsonl');
const viewJ = await traces.readTraceByPath(eventsJ);
const turnJ = viewJ.turns[viewJ.turns.length - 1];
const shape = turnJ.blocks.map((b) => `${b.type}:${b.id || ''}`).join(' ');
check('each result sits next to its own call', shape.startsWith('tool_use:c1 tool_result:c1 tool_use:c2 tool_result:c2'), true);
check('tool arguments survive as text', turnJ.blocks[0].text, '{"path":"/w/one"}');

console.log('\na partial answer is never presented as the final one');
const eventsC = path.join(process.env.HOME, '.fx', 'sessions', 'sess-c', 'events.jsonl');
const viewC = await traces.readTraceByPath(eventsC);
const interrupted = viewC.turns.filter((m) => m.role === 'assistant').pop();
check('the interrupted turn holds its partial text', interrupted.blocks.some((b) => b.text === 'partial tho'), true);
check('but is not marked final', interrupted.kind, 'partial');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
