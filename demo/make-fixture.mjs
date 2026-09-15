// Builds the demo's bundled session file: one normalized turn per line, the
// shape a trace window returns. Synthetic throughout — nothing here is copied
// from a real conversation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(HERE, 'session.jsonl');
const turns = [];
let at = Date.parse('2026-09-12T09:00:00Z');
const tick = (ms = 45_000) => (at += ms);
const push = (t) => turns.push({ ...t, ts: t.ts ?? tick() });

// Varied prose, so the demo reads like a conversation rather than filler. The
// bulk lives in tool output, which is where it lives in a real tool-heavy
// trace — logs and JSON really are repetitive; an agent's prose is not.
const OPENERS = [
  'Short answer: yes, and the cause is narrower than it looked.',
  'Not quite — the numbers say something different once you control for batch size.',
  'It checks out. Here is what I found and what I ruled out.',
  'Partly. Two of the three things you asked about are the same thing.',
  'I reproduced it, and it is not where the last run pointed.',
];
const MIDDLES = [
  'The run before it used a different shard order, which moves the first two hundred steps and nothing after them.',
  'I compared against last Tuesday and the gap closes entirely once the warmup is aligned.',
  'The eval harness was reading a stale merges file, so the tokenizer looked wrong when it was fine.',
  'Throughput is flat, so this is not a data-loading problem however much it resembles one.',
  'Memory peaks during the checkpoint write, not during the forward pass, which is why the ceiling moved.',
  'Two of the workers retried, and the retry landed after the barrier, so the step counts disagree by one.',
];
const CLOSERS = [
  'I would not change anything yet; one more run will tell us whether it is real.',
  'Worth pinning before it drifts again.',
  'Happy to dig further if you want the per-shard numbers.',
  'That leaves only the scheduler as an explanation, which I can check next.',
];
const pick = (list, n) => list[Math.abs(n) % list.length];
const CODE = (topic) => ['```python', `def check_${topic.replace(/[^a-z]/gi, '_')}(run):`,
  '    window = run.metrics[-24:]', '    return sum(window) / len(window)', '```'].join('\n');
const BULLETS = ['- the shard order changed between the two runs',
  '- the eval set is unchanged, checked by digest', '- nothing in the scheduler moved'].join('\n');

/** An answer: mostly a few sentences, sometimes several paragraphs. */
const answer = (topic, n, long) => {
  const parts = [pick(OPENERS, n), '', pick(MIDDLES, n)];
  if (n % 4 === 1) parts.push('', BULLETS);
  if (long) {
    for (let i = 0; i < 6; i++) parts.push('', pick(MIDDLES, n + i));
    parts.push('', CODE(topic), '', pick(MIDDLES, n + 11));
  }
  if (n % 3 === 0) parts.push('', pick(CLOSERS, n));
  return parts.join('\n');
};

/** Tool output: logs and JSON, which really are this repetitive. */
const toolOut = (topic, lines) => {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(i % 7 === 0
      ? `[${String(10 + (i % 14)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:12] step ${1000 + i * 3} | loss ${(2.4 - i * 0.0007).toFixed(4)} | lr ${(3e-4).toExponential(1)} | tok/s ${18000 + (i * 37) % 900}`
      : `  shard=${String(i % 32).padStart(2, '0')} host=node-${i % 8} ${topic.replace(/ /g, '_')}=${((i * 13) % 97) / 100} ok=${i % 11 !== 0}`);
  }
  return out.join('\n');
};

// A conversation that is long enough to need several backward pages.
const TOPICS = [
  'tokenizer drift', 'eval harness', 'dataset shard', 'checkpoint resume', 'lr schedule',
  'attention mask', 'batch packing', 'gradient clipping', 'weight decay', 'warmup steps',
  'loss spike', 'throughput', 'memory ceiling', 'sharding plan', 'export format',
  'quantisation', 'latency budget', 'cache hit rate', 'rollout replay', 'release notes',
  'tokenizer merges', 'shuffle seed', 'eval contamination', 'prompt template', 'stop tokens',
  'context window', 'kv cache', 'speculative decode', 'batch scheduler', 'retry policy',
];
// Enough conversation that the automatic fill reaches its target with history
// still above it — so the demo shows the actionable "Load earlier turns" state
// as well as the fill and the exhausted end.
const ALL = [...TOPICS.map((t) => `early ${t}`), ...TOPICS.map((t) => `mid ${t}`), ...TOPICS];

// 1. The harness context the operator should never see as a prompt. Three
//    shapes: the tagged envelope, the AGENTS.md envelope Codex injects, and a
//    turn the server already normalized to `system`.
push({ id: 'ctx-1', role: 'user', blocks: [{ type: 'text',
  text: '<environment_context>\nworkspace: /data/workspaces/demo\nharness: demo\n</environment_context>' }] });
push({ id: 'ctx-2', role: 'user', blocks: [{ type: 'text',
  text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n<!-- BEGIN DEMO CONTEXT -->\n# Demo environment\n\nThis block is injected by the harness before the conversation starts. It is not\nsomething the operator typed, and the reader must not draw it as a prompt or\ncount it as an exchange.\n<!-- END DEMO CONTEXT -->\n</INSTRUCTIONS>' }] });
push({ id: 'ctx-3', role: 'system', blocks: [{ type: 'text',
  text: 'skills loaded: environment, visual-taste, dataviz' }] });

ALL.forEach((topic, n) => {
  // The newest third is where the weight is.
  const recent = n >= ALL.length - 7;
  const long = recent && n % 2 === 0;
  const bulk = recent ? 2.6 : 0.09;
  const lines = (k) => Math.max(3, Math.round(k * bulk));
  push({ id: `u${n}`, role: 'user', blocks: [{ type: 'text',
    text: n === ALL.length - 4
      ? 'read the environment skill and tell me what it says about <INSTRUCTIONS> blocks — I want a real prompt that mentions both and still shows up'
      : n === ALL.length - 9
      ? 'can you update AGENTS.md instructions for the new layout?'
      : `Can you look at the ${topic} and tell me whether it explains what we saw in the last run?` }] });

  if (recent || n % 3 === 0) {
    const call = `call-${n}`;
    push({ id: `a${n}-t`, role: 'assistant', blocks: [
      { type: 'thinking', text: `Checking the ${topic} before answering.` },
      { type: 'tool_use', id: call, name: 'Read', text: JSON.stringify({ path: `/data/runs/${topic.replace(/ /g, '-')}.json` }) },
    ] });
    push({ id: `r${n}`, role: 'user', blocks: [{ type: 'tool_result', id: call,
      text: toolOut(topic, lines(340)) }] });
  }
  if (recent || n % 4 === 1) {
    const call = `sh-${n}`;
    push({ id: `a${n}-s`, role: 'assistant', blocks: [
      { type: 'tool_use', id: call, name: 'Bash', text: JSON.stringify({ command: `grep -c "${topic}" /data/runs/*.log` }) },
    ] });
    push({ id: `rs${n}`, role: 'user', blocks: [{ type: 'tool_result', id: call, text: toolOut(topic, lines(110)) }] });
  }

  push({ id: `a${n}`, role: 'assistant', kind: 'final', blocks: [{ type: 'text',
    text: long
      ? answer(topic, n, true)
      : answer(topic, n, false) }] });

  // Injected context mid-conversation too, so the filter is exercised beyond
  // the opening page.
  if (n === ALL.length - 12) {
    push({ id: 'ctx-mid', role: 'user', blocks: [{ type: 'text',
      text: '<system-reminder>\nthe operator changed a setting\n</system-reminder>' }] });
  }
});

fs.writeFileSync(out, turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
const users = turns.filter((t) => t.role === 'user' && t.blocks.some((b) => b.type === 'text')).length;
console.log(`${out}: ${turns.length} turns, ${fs.statSync(out).size} bytes, ${users} user text turns`);
