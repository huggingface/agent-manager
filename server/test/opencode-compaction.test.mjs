// opencode's context compaction, read as one turn with a marker.
//
// When a long turn overflows the context, opencode writes three records in the
// same second: a USER message whose only part is `{type:'compaction'}`, the
// compaction agent's summary (an assistant message with `summary: true`, mode
// 'compaction'), and then the interrupted prompt replayed verbatim as a plain
// user message, after which the agent carries on. Taken literally the reader
// showed the prompt, its steps, the SUMMARY as the turn's final answer, and then
// the same prompt again as a second turn — "my prompt appears twice".
//
// The fixture copies the shape of a real session (deepseek-f0b656), trimmed.
//
// Run with:  node test/opencode-compaction.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-compaction-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true });

const { readTrace, __readOpencodeForTest } = await import('../src/traces.js');

const PROMPT = 'i want you to work on a visualization: a fluorescent chromosome on black';
const SUMMARY = '## Objective\n- Render a fluorescent chromosome.\n\n## Work State\n- preview8.png still too dark.';

const db = new DatabaseSync(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT,
    tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
const addSession = db.prepare('INSERT INTO session VALUES (?,?,?,?,0,0,0,?,?)');
const addMessage = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
const addPart = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
// Parts are stamped after their message, as opencode's are: a reader that
// anchors on a part's time lands one record late.
let clock = 1_000;
const at = {}; // message id -> its time
function message(sid, id, data, parts = []) {
  const t = (at[id] = clock += 10);
  addMessage.run(id, sid, t, JSON.stringify(data));
  parts.forEach((p, i) => addPart.run(`${id}-p${i}`, id, sid, t + 1 + i, JSON.stringify(p)));
}
const user = () => ({ role: 'user', agent: 'build', summary: { diffs: [] } });
const step = (finish = 'tool-calls') => ({ role: 'assistant', mode: 'build', agent: 'build', finish });
const bash = (command, output) => ({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command }, output } });
const summaryMsg = { role: 'assistant', mode: 'compaction', agent: 'compaction', summary: true, finish: 'stop' };

// ---- the observed automatic compaction ----
addSession.run('ses_auto', '/w', 'Chromosome', '{"id":"deepseek"}', 1, 2);
message('ses_auto', 'u1', user(), [{ type: 'text', text: 'how are you?' }]);
message('ses_auto', 'a1', step('stop'), [{ type: 'step-start' }, { type: 'text', text: 'Fine — what shall we build?' }, { type: 'step-finish' }]);
message('ses_auto', 'u2', user(), [{ type: 'text', text: PROMPT }]);
message('ses_auto', 'a2', step(), [{ type: 'step-start' }, { type: 'reasoning', text: 'Still too dark.' },
  { type: 'text', text: '\n\n' }, bash('python3 render.py', 'wrote preview8.png'), { type: 'step-finish' }]);
message('ses_auto', 'a3', step(), [{ type: 'text', text: '\n\n' }, { type: 'tool', tool: 'read', state: { input: { filePath: 'preview8.png' }, output: 'Image read successfully' } }]);
message('ses_auto', 'a4', { role: 'assistant', mode: 'build', agent: 'build' }); // cut off by the overflow: no parts, no finish
message('ses_auto', 'c1', user(), [{ type: 'compaction', auto: true, overflow: true }]);
message('ses_auto', 's1', summaryMsg, [{ type: 'step-start' }, { type: 'reasoning', text: 'summarise' }, { type: 'text', text: SUMMARY }, { type: 'step-finish' }]);
message('ses_auto', 'r1', user(), [{ type: 'text', text: PROMPT }]); // the replay: no synthetic flag
message('ses_auto', 'a5', step(), [bash('python3 render.py --glow', 'wrote preview9.png')]);
message('ses_auto', 'a6', step(), [{ type: 'text', text: '\n\n' }, { type: 'tool', tool: 'read', state: { input: { filePath: 'shot.png' }, output: 'Image read successfully' } }]);
// A second overflow in the same turn, this time on media: instead of replaying
// the prompt, opencode writes a synthetic note flagged `compaction_continue`.
message('ses_auto', 'a7', { role: 'assistant', mode: 'build', agent: 'build' });
message('ses_auto', 'c2', user(), [{ type: 'compaction', auto: true, overflow: true, tail_start_id: 'a7' }]);
message('ses_auto', 's2', summaryMsg, [{ type: 'text', text: '## Objective\n- Build a realistic chromosome.' }]);
message('ses_auto', 'k2', user(), [{ type: 'text', synthetic: true, metadata: { compaction_continue: true },
  text: 'The previous request exceeded the provider\'s size limit due to large media attachments. The conversation was compacted…' }]);
message('ses_auto', 'a8', step('stop'), [{ type: 'text', text: 'Done: preview9.png glows green.' }]);

// ---- a manual /compact, then a genuinely new prompt ----
addSession.run('ses_manual', '/w', 'Manual', '{"id":"deepseek"}', 1, 2);
message('ses_manual', 'mu1', user(), [{ type: 'text', text: 'build it' }]);
message('ses_manual', 'ma1', step('stop'), [{ type: 'text', text: 'Built.' }]);
message('ses_manual', 'mc1', user(), [{ type: 'compaction', auto: false }]);
message('ses_manual', 'ms1', summaryMsg, [{ type: 'text', text: '## Objective\n- build it' }]);
message('ses_manual', 'mu2', user(), [{ type: 'text', text: 'now make it blue' }]);
message('ses_manual', 'ma2', step('stop'), [{ type: 'text', text: 'Blue now.' }]);
// The same prompt again, but not straight after a compaction: a new turn.
message('ses_manual', 'mu3', user(), [{ type: 'text', text: 'now make it blue' }]);
message('ses_manual', 'ma3', step('stop'), [{ type: 'text', text: 'Still blue.' }]);
// ---- review regressions ----
// 1. A manual /compact, then the operator sends the SAME prompt again. Only an
//    automatic compaction is followed by a replay opencode writes itself.
addSession.run('ses_repeat', '/w', 'Repeat', '{"id":"deepseek"}', 1, 2);
message('ses_repeat', 'ru1', user(), [{ type: 'text', text: 'build it' }]);
message('ses_repeat', 'ra1', step('stop'), [{ type: 'text', text: 'Built once.' }]);
message('ses_repeat', 'rc1', user(), [{ type: 'compaction', auto: false }]);
message('ses_repeat', 'rs1', summaryMsg, [{ type: 'text', text: '## Objective\n- build it' }]);
message('ses_repeat', 'ru2', user(), [{ type: 'text', text: 'build it' }]);
message('ses_repeat', 'ra2', step('stop'), [{ type: 'text', text: 'Built twice.' }]);
// 2. Two prompts longer than the 20,000-character display cap that share it
//    and differ after: the second is not a replay of the first.
const LONG = 'x'.repeat(20_000);
addSession.run('ses_long', '/w', 'Long', '{"id":"deepseek"}', 1, 2);
message('ses_long', 'lu1', user(), [{ type: 'text', text: `${LONG} first` }]);
message('ses_long', 'la1', step(), [bash('ls', 'ok')]);
message('ses_long', 'lc1', user(), [{ type: 'compaction', auto: true, overflow: true }]);
message('ses_long', 'ls1', summaryMsg, [{ type: 'text', text: '## Objective\n- long' }]);
message('ses_long', 'lu2', user(), [{ type: 'text', text: `${LONG} second` }]);
message('ses_long', 'la2', step('stop'), [{ type: 'text', text: 'Did the second.' }]);
// 3. An automatic compaction whose summary ABORTED (error, no text, no finish),
//    then the operator retries the same prompt: a retry, not a replay.
addSession.run('ses_abort', '/w', 'Abort', '{"id":"deepseek"}', 1, 2);
message('ses_abort', 'bu1', user(), [{ type: 'text', text: 'build it' }]);
message('ses_abort', 'ba1', step(), [bash('ls', 'ok')]);
message('ses_abort', 'bc1', user(), [{ type: 'compaction', auto: true, overflow: true }]);
message('ses_abort', 'bs1', { role: 'assistant', mode: 'compaction', agent: 'compaction', summary: true,
  error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }, [{ type: 'step-start' }]);
message('ses_abort', 'bu2', user(), [{ type: 'text', text: 'build it' }]);
message('ses_abort', 'ba2', step('stop'), [{ type: 'text', text: 'Built.' }]);
// A real step between the summary and a matching prompt ends the compaction:
// the prompt after it is the operator's. (The digest only reads such gaps.)
addSession.run('ses_gap', '/w', 'Gap', '{"id":"deepseek"}', 1, 2);
message('ses_gap', 'gu1', user(), [{ type: 'text', text: 'build it' }]);
message('ses_gap', 'gc1', user(), [{ type: 'compaction', auto: true, overflow: true }]);
message('ses_gap', 'gs1', summaryMsg, [{ type: 'text', text: '## Objective\n- build it' }]);
message('ses_gap', 'ge1', { role: 'assistant', mode: 'build', agent: 'build' });
message('ses_gap', 'ga1', step('stop'), [{ type: 'text', text: 'Carried on by itself.' }]);
message('ses_gap', 'gu2', user(), [{ type: 'text', text: 'build it' }]);
// 4. Ten automatic compactions in one turn, each followed by a replay, and ten
//    each followed by opencode's "carry on" note. Any length of chain must
//    read as one prompt, in the reader and the digest alike.
for (const [sid, resume] of [
  ['ses_chain_replay', () => [{ type: 'text', text: PROMPT }]],
  ['ses_chain_note', () => [{ type: 'text', synthetic: true, metadata: { compaction_continue: true }, text: 'Carry on; media were removed.' }]],
]) {
  addSession.run(sid, '/w', 'Chain', '{"id":"deepseek"}', 1, 2);
  message(sid, `${sid}-u`, user(), [{ type: 'text', text: PROMPT }]);
  message(sid, `${sid}-a`, step(), [bash('ls', 'ok')]);
  for (let i = 0; i < 10; i++) {
    message(sid, `${sid}-e${i}`, { role: 'assistant', mode: 'build', agent: 'build' }); // cut off
    message(sid, `${sid}-c${i}`, user(), [{ type: 'compaction', auto: true, overflow: true }]);
    message(sid, `${sid}-s${i}`, summaryMsg, [{ type: 'text', text: `## Objective\n- round ${i}` }]);
    message(sid, `${sid}-r${i}`, user(), resume());
    message(sid, `${sid}-a${i}`, step(i === 9 ? 'stop' : 'tool-calls'), [i === 9 ? { type: 'text', text: 'Finished.' } : bash('ls', `ok ${i}`)]);
  }
}
db.close();

const texts = (t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text);
const read = async (sid) => (await readTrace({ id: sid, cli: 'opencode', path: 'w', opencodeSessionId: sid })).turns;

// ---- the reader ----
{
  const turns = await read('ses_auto');
  const prompts = turns.filter((t) => t.role === 'user').map((t) => texts(t).join(''));
  assert.deepEqual(prompts, ['how are you?', PROMPT], 'the prompt appears once; the replay is not a new turn');

  const markers = turns.filter((t) => t.blocks.some((b) => b.type === 'compaction'));
  assert.equal(markers.length, 2, 'one marker per compaction');
  const marker = markers[0].blocks.find((b) => b.type === 'compaction');
  assert.match(marker.text, /^Context compacted \(automatic, context full\)/);
  assert.ok(marker.text.includes('## Objective'), 'the summary sits under the marker');
  assert.ok(!turns.some((t) => t.role === 'assistant' && texts(t).some((x) => x.includes('## Objective'))),
    'and nowhere as an ordinary text block');
  assert.notEqual(markers[0].kind, 'final', 'the marker is never the final answer');

  // Everything after the marker belongs to the same turn: no user row between.
  const at = turns.indexOf(markers[0]);
  assert.equal(turns[at - 1].role, 'assistant');
  assert.ok(turns.slice(at).every((t) => t.role === 'assistant'), 'the work after compaction continues the original turn');
  const finals = turns.filter((t) => t.kind === 'final').map((t) => texts(t).join(''));
  assert.deepEqual(finals, ['Fine — what shall we build?', 'Done: preview9.png glows green.'],
    'each turn has one final answer, and it is not the summary');

  assert.ok(turns.every((t) => t.blocks.length > 0), 'no empty step for the message the overflow cut off');
  assert.ok(!turns.some((t) => t.blocks.some((b) => b.type === 'text' && !b.text.trim())), 'no whitespace-only text steps');
}

{
  const turns = await read('ses_manual');
  const prompts = turns.filter((t) => t.role === 'user').map((t) => texts(t).join(''));
  assert.deepEqual(prompts, ['build it', 'now make it blue', 'now make it blue'],
    'a new prompt after a compaction is a new turn, and so is a repeat that does not follow one');
  const marker = turns.flatMap((t) => t.blocks).find((b) => b.type === 'compaction');
  assert.match(marker.text, /^Context compacted \(manual\)/, 'a manual /compact shows the marker too');
}

{
  const turns = await read('ses_repeat');
  assert.deepEqual(turns.filter((t) => t.role === 'user').map((t) => texts(t).join('')), ['build it', 'build it'],
    'after a MANUAL /compact a matching prompt is the operator\'s, and stays');
  assert.deepEqual(turns.filter((t) => t.kind === 'final').map((t) => texts(t).join('')), ['Built once.', 'Built twice.'],
    'two exchanges, not merged');
}

{
  const turns = await read('ses_long');
  const prompts = turns.filter((t) => t.role === 'user');
  assert.equal(prompts.length, 2, 'prompts equal only up to the display cap are still two prompts');
}

{
  const turns = await read('ses_abort');
  assert.deepEqual(turns.filter((t) => t.role === 'user').map((t) => texts(t).join('')), ['build it', 'build it'],
    'a failed summary does not turn the retry into a replay');
  assert.ok(turns.some((t) => t.blocks.some((b) => b.type === 'compaction')), 'the compaction still shows');
}

for (const sid of ['ses_chain_replay', 'ses_chain_note']) {
  const turns = await read(sid);
  assert.deepEqual(turns.filter((t) => t.role === 'user').map((t) => texts(t).join('')), [PROMPT], `${sid}: one prompt`);
  assert.equal(turns.filter((t) => t.blocks.some((b) => b.type === 'compaction')).length, 10, `${sid}: ten markers`);
  assert.deepEqual(turns.filter((t) => t.kind === 'final').map((t) => texts(t).join('')), ['Finished.']);
}

// ---- the digest (Overview tile, unread, "since your prompt") ----
{
  const rows = new Map(__readOpencodeForTest().map((r) => [r.sessionId, r.parsed]));
  const auto = rows.get('ses_auto');
  assert.ok(auto, 'the digest read the fixture');
  assert.equal(auto.stats.prompts, 2, 'two prompts, not four (no marker, no replay)');
  assert.equal(auto.digest.lastPromptText, PROMPT);
  assert.equal(auto.digest.lastPromptTs, at.u2, 'the turn started at the ORIGINAL prompt (u2), not a replay');
  assert.equal(auto.digest.lastAssistantText, 'Done: preview9.png glows green.');
  assert.equal(auto.stats.turns, 8, 'a1-a8: the summaries are not assistant turns');

  const repeat = rows.get('ses_repeat');
  assert.equal(repeat.stats.prompts, 2, 'a repeat after a manual compaction is counted');
  assert.equal(repeat.digest.lastPromptTs, at.ru2, 'and the last prompt is the repeat, not the original');
  const long = rows.get('ses_long');
  assert.equal(long.stats.prompts, 2, 'the reader and the digest agree on long prompts');
  assert.equal(long.digest.lastPromptTs, at.lu2);

  const abort = rows.get('ses_abort');
  assert.equal(abort.stats.prompts, 2, 'the retry after a failed summary is counted');
  assert.equal(abort.digest.lastPromptTs, at.bu2);
  for (const sid of ['ses_chain_replay', 'ses_chain_note']) {
    const chain = rows.get(sid);
    assert.equal(chain.stats.prompts, 1, `${sid}: one prompt however long the chain`);
    assert.equal(chain.digest.lastPromptTs, at[`${sid}-u`], `${sid}: the last prompt is the original`);
    assert.equal(chain.digest.sinceTurns, 1 + 10 * 2, `${sid}: every step since it (cut-off ones included), no summaries`);
    assert.equal(chain.digest.lastAssistantText, 'Finished.');
  }
  assert.equal(rows.get('ses_gap').stats.prompts, 2, 'a step after the summary ends the compaction');
  // The reader and the digest agree on every conversation in the fixture.
  for (const [sid, parsed] of rows) {
    const turns = await read(sid);
    assert.equal(parsed.stats.prompts, turns.filter((t) => t.role === 'user').length, `${sid}: reader and digest agree`);
  }

  const manual = rows.get('ses_manual');
  assert.equal(manual.stats.prompts, 3);
  assert.equal(manual.digest.lastPromptText, 'now make it blue');
  assert.equal(manual.digest.lastAssistantText, 'Still blue.');
}

// ---- mid-compaction: marker and summary written, replay not yet ----
{
  const db2 = new DatabaseSync(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  db2.exec(`DELETE FROM part WHERE message_id IN ('r1','a5','a6','a7','c2','s2','k2','a8');
    DELETE FROM message WHERE id IN ('r1','a5','a6','a7','c2','s2','k2','a8');`);
  db2.close();
  const turns = await read('ses_auto');
  assert.ok(!turns.some((t) => t.kind === 'final' && texts(t).some((x) => x.includes('## Objective'))),
    'the summary is not shown as the answer while the turn is still compacting');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('opencode-compaction: ok');
