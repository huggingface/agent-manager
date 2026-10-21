// Code-mode parsing under random input: a few thousand snippets and outputs
// mutated from the fixture's real shapes and the review's reproductions, with a
// fixed seed. Nothing may throw, no parse may take more than 50 ms, and no
// base64 data URL may survive into text. Run with:
//   node test/codex-code-mode-fuzz.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-code-mode-fuzz-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.XDG_DATA_HOME = path.join(TMP, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { readTraceByPath, __parseCodexForTest: parseCodex } = await import('../src/traces.js');
const { codeModeUses, codeModeResults } = await import('../src/codex-code-mode.js');

// mulberry32: small, seeded, the same sequence on every run.
let seed = 0x5eed2200;
const rand = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (n) => Math.floor(rand() * n);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-code-mode.jsonl');
const lines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l).payload);
const INPUTS = [
  ...lines.filter((p) => p.type === 'custom_tool_call').map((p) => p.input),
  'tools.exec_command({cmd:"\\u{110000}"})',
  'tools.exec_command(' + '['.repeat(100) + '0' + ']'.repeat(100) + ')',
  'tools.exec_command({cmd:"ok"}' + ' '.repeat(500) + '/*x*/)',
  'tools.exec_command({raw:{toString:null}})',
  'text((await tools.exec_command({cmd:"echo 0"})).output.trim());text(await tools.exec_command({cmd:"echo second"}));',
  'const rs=await Promise.allSettled([tools.exec_command({cmd:"a"}),tools.view_image({path:"/b.png"})]); rs.forEach((r,i)=>text({i,...r}));',
  'tools.write_file({content:"data:image\\/png;base64,QUJD"})',
];
const OUTPUTS = lines.filter((p) => p.type === 'custom_tool_call_output').map((p) => p.output);
const TOKENS = ['tools.', 'tools.exec_command(', 'tools["x"](', '(', ')', '[', ']', '{', '}', '"', "'", '`', '${', '\\', '\\u{', '\\u{110000}',
  '\\x4', '/*', '*/', '//', '\n', ',', ':', '...', '0x', '1e999', '-', '__proto__:', 'toString:null', 'for(let i=0;i<r.length;i++){text(i);',
  'text({i,...r})', 'data:image/png;base64,QUJD', 'data:image\\/png;base64,QUJD', ' '.repeat(64), '0', '1', '"\\n"'];
const JSONS = [{ toString: null }, { status: 'rejected', reason: { message: { toString: null } } }, { status: 'rejected', reason: null },
  { i: 0, status: 'fulfilled', value: { output: 'data:image\\/png;base64,AAAA', exit_code: 'x' } }, { i: 1, status: 'rejected', reason: 5 },
  { output: { toString: null } }, { exit_code: 1e308, output: 'x' }, { exit_code: 2, output: 'data:image/png;base64,AAAA' },
  { output: '0' }, { i: 9, status: 'fulfilled' }, [1, 2], 'str', 0, null];

function mutate(s) {
  for (let n = 1 + int(4); n > 0; n--) {
    const at = int(s.length + 1);
    switch (int(6)) {
      case 0: s = s.slice(0, at) + pick(TOKENS) + s.slice(at); break;
      case 1: s = s.slice(0, at) + s.slice(at + int(20)); break;
      case 2: { const piece = s.slice(at, at + 1 + int(40)); s = s.slice(0, at) + piece.repeat(1 + int(400)) + s.slice(at); break; }
      case 3: s = s.slice(0, at) + pick('()[]{}"\'`\\$/*,:; \n09.ax') + s.slice(at + 1); break;
      case 4: s = s.slice(0, at); break;
      default: s = s.slice(0, at) + pick(TOKENS).repeat(1 + int(2000)) + s.slice(at);
    }
  }
  return s.slice(0, 100_000);
}
function mutateOutput(output) {
  if (rand() < 0.05) return pick([null, 7, 'Script completed\n', { type: 'input_text', text: { toString: null } }]);
  const parts = Array.isArray(output) ? output.map((p) => ({ ...p })) : [];
  for (let n = 1 + int(4); n > 0; n--) {
    const at = int(parts.length + 1);
    switch (int(5)) {
      case 0: if (parts[at] && typeof parts[at].text === 'string') parts[at].text = mutate(parts[at].text); break;
      case 1: parts.splice(at, 0, { type: 'input_text', text: rand() < 0.5 ? JSON.stringify(pick(JSONS)) : mutate(JSON.stringify(pick(JSONS)) || '') }); break;
      case 2: parts.splice(at, 1); break;
      case 3: parts.splice(at, 0, pick([null, 3, {}, { type: 'input_image', image_url: { toString: null } }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: String(int(4)) }, { type: 'input_text', text: 'Script failed\nWall time x seconds\n' }])); break;
      default: parts.splice(at, 0, { type: 'input_text', text: pick(TOKENS) });
    }
  }
  return parts;
}

// A base64 data URL as plain text, with or without JSON's escaped slash.
const DATA_URL = /data:[\w.+$-]+(?:\\\/|\/)[\w.+$-]+(?:;[\w.+=$-]+)*;base64,/;
const clean = (text, where) => assert.ok(!DATA_URL.test(text), `${where}: ${text.slice(0, 200)}`);

// The parse's own cost: a slow reading is taken again and the faster kept, so
// a garbage-collection pause on a busy test machine does not count as one.
const timed = (fn) => {
  let t = performance.now(); fn(); const first = performance.now() - t;
  if (first < 50) return first;
  t = performance.now(); fn(); return Math.min(first, performance.now() - t);
};

test('thousands of mutated snippets and outputs: no throw, under 50 ms, no data URLs', () => {
  let slowest = 0;
  for (let i = 0; i < 3000; i++) {
    const input = mutate(pick(INPUTS));
    const output = mutateOutput(pick(OUTPUTS));
    const uses = codeModeUses(input);
    slowest = Math.max(slowest, timed(() => codeModeUses(input)));
    assert.ok(uses === null || Array.isArray(uses), `#${i}`);
    for (const u of uses || []) {
      assert.equal(typeof u.name, 'string');
      assert.equal(typeof u.text, 'string');
      clean(u.text, `#${i} call`);
    }
    const res = codeModeResults(output, input, uses ? uses.length : 1);
    slowest = Math.max(slowest, timed(() => codeModeResults(output, input, uses ? uses.length : 1)));
    for (const r of res.perCall || [res.script]) {
      assert.equal(typeof r.text, 'string');
      clean(r.text, `#${i} result`);
    }
  }
  assert.ok(slowest < 50, `slowest parse ${slowest.toFixed(1)} ms`);
});

test('the reader and the digest survive the same inputs', async () => {
  const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-21T08:00:00.000Z', type, payload });
  for (let i = 0; i < 150; i++) {
    const file = path.join(TMP, `fuzz-${i}.jsonl`);
    const body = [line('session_meta', { id: `f${i}`, cwd: TMP }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] })];
    for (let k = 0; k < 3; k++) {
      const id = rand() < 0.1 ? { toString: null } : `c${k}`;
      body.push(line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input: mutate(pick(INPUTS)) }));
      body.push(line('response_item', { type: 'custom_tool_call_output', call_id: id, output: mutateOutput(pick(OUTPUTS)) }));
    }
    fs.writeFileSync(file, body.join('\n') + '\n');
    const page = await readTraceByPath(file);
    for (const b of page.turns.flatMap((t) => t.blocks)) if (typeof b.text === 'string') clean(b.text, `file ${i}`);
    parseCodex(fs.readFileSync(file, 'utf8'));
  }
});
