// What the NORMALIZER does with injected harness context, through the real
// parser on real rollout files.
//
// This exists because the client's `isOperatorPrompt` and the server's
// `isHarnessText` are two copies of one rule, and only the client half had
// coverage. A comment claiming they were pinned together was not true; this is
// the half that was missing.
//
// The case: Codex injects the project's AGENTS.md as an ordinary `role: user`
// message rather than a tagged envelope, so a tag list alone let it through and
// the reader drew the manager's own instructions as the operator's first
// prompt. Matched on the two-line shape it emits, so a prompt that merely
// mentions AGENTS.md or quotes <INSTRUCTIONS> is still a prompt.
//
// Run with:  node test/harness-envelope.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTraceByPath } from '../src/traces.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-envelope-'));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const INJECTED = '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n<!-- BEGIN CONTEXT -->\nbe helpful\n<!-- END CONTEXT -->\n</INSTRUCTIONS>';
// Prompts a person really writes about the same things.
// [prompt, a needle unique to it]. The needle matters: "# AGENTS.md
// instructions" appears in the injected envelope too, so searching for it finds
// the system turn and proves nothing.
const REAL = [
  ['can you update AGENTS.md instructions for the new layout?', 'for the new layout'],
  ['the skill says to wrap it in <INSTRUCTIONS> — should we?', 'should we?'],
  ['# AGENTS.md instructions\n\nthis heading is mine and there is no envelope under it', 'this heading is mine'],
  ['read the environment skill and tell me what it says about ports', 'what it says about ports'],
];

const read = async (file) => {
  const page = await readTraceByPath(file, {
    window: { at: 'tail', cursor: 0, bytes: 8 * 1024 * 1024, min: 1_000_000, version: 2 },
  });
  return page.turns || [];
};
const textOf = (t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const roleOfText = (turns, needle) => {
  const hit = turns.find((t) => textOf(t).includes(needle));
  return hit ? hit.role : `(no turn contained ${JSON.stringify(needle.slice(0, 30))})`;
};

// ---- Codex: the rollout shape the injection actually arrives in ----
{
  const file = path.join(dir, 'codex.jsonl');
  const rec = (payload, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), type: 'response_item', payload });
  const msg = (role, text, i) => rec({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }, i);
  const lines = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { cwd: '/w' } }),
    msg('user', INJECTED, 1),
    ...REAL.map(([text], i) => msg('user', text, i + 2)),
    msg('assistant', 'Understood.', 9),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const turns = await read(file);
  check('codex: the injected AGENTS.md envelope is filed as system, not a prompt', () => {
    assert.equal(roleOfText(turns, 'BEGIN CONTEXT'), 'system');
  });
  for (const [, needle] of REAL) {
    check(`codex: a real prompt survives — ${JSON.stringify(needle)}`, () => {
      assert.equal(roleOfText(turns, needle), 'user');
    });
  }
  check('codex: exactly the real prompts are user turns', () => {
    assert.equal(turns.filter((t) => t.role === 'user').length, REAL.length);
  });
}

// ---- Claude: the same rule, through the other normalizer ----
{
  const file = path.join(dir, 'claude.jsonl');
  const msg = (type, text, i) => JSON.stringify({
    type, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    message: { role: type, content: [{ type: 'text', text }] },
  });
  fs.writeFileSync(file, [
    msg('user', INJECTED, 1),
    ...REAL.map(([text], i) => msg('user', text, i + 2)),
    msg('assistant', 'Understood.', 9),
  ].join('\n') + '\n');
  const turns = await read(file);
  check('claude: the same envelope is filed as system there too', () => {
    assert.equal(roleOfText(turns, 'BEGIN CONTEXT'), 'system');
  });
  check('claude: and the real prompts are still prompts', () => {
    for (const [, needle] of REAL) assert.equal(roleOfText(turns, needle), 'user');
  });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nharness-envelope: injected context filed as system, real prompts kept');
process.exit(failed ? 1 : 0);
