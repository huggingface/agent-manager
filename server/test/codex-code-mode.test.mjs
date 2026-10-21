// Codex "code mode": every tool call arrives as ONE `exec` script, and the
// reader and digest must unpack it into the calls the classic format writes.
// The fixture mirrors a real GPT-6-Astra rollout (carbon-astra), trimmed, with
// a 1×1 PNG in place of megabytes of base64. Run with:
//   node test/codex-code-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-code-mode-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.XDG_DATA_HOME = path.join(TMP, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { readTraceByPath, __parseCodexForTest: parseCodex } = await import('../src/traces.js');
const { codeModeCalls, codeModeOutput, stripDataUrls } = await import('../src/codex-code-mode.js');

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-code-mode.jsonl');
const PATCHED = '/data/workspaces/carbon-video/edit/astra-feedback-v2.md';

test('the reader shows the tools a script called, not the script', async () => {
  const page = await readTraceByPath(FIXTURE);
  const blocks = page.turns.flatMap((t) => t.blocks);
  const uses = blocks.filter((b) => b.type === 'tool_use');
  assert.deepEqual(uses.map((b) => b.name),
    ['exec_command', 'view_image', 'view_image', 'exec_command', 'write_stdin', 'apply_patch', 'script']);

  // Arguments are what the classic format writes: JSON for a call, the patch
  // text for apply_patch.
  assert.deepEqual(JSON.parse(uses[0].text), { cmd: 'rg --files looks/frames', max_output_tokens: 2000 });
  assert.deepEqual(JSON.parse(uses[1].text), { path: '/data/workspaces/carbon-video/ref/sheet-primeintellect.png' });
  assert.equal(JSON.parse(uses[3].text).cmd, "python3 - <<'PY'\nfrom PIL import Image\nprint('ok')\nPY");
  assert.deepEqual(JSON.parse(uses[4].text), { session_id: 53519, chars: '', yield_time_ms: 1000, max_output_tokens: 1000 });
  assert.match(uses[5].text, /^\*\*\* Begin Patch\n\*\*\* Add File: \/data\/workspaces\/carbon-video\/edit\/astra-feedback-v2\.md\n\+\*\*Visually/);

  // The unparsable snippet is a script with its code, not a raw one-line label.
  const script = JSON.parse(uses[6].text);
  assert.equal(script.description, 'Ran a script');
  assert.equal(script.code, 'const xs=[3,1,2].sort();\ntext(xs.join(","));\n');

  // Every call has a result next to it, and the wrapper is gone.
  for (const u of uses) assert.ok(blocks.some((b) => b.type === 'tool_result' && b.id === u.id), `${u.name} has a result`);
  const results = blocks.filter((b) => b.type === 'tool_result');
  assert.ok(results.every((r) => !/Script completed|Wall time|data:image/.test(r.text)), 'no wrapper and no base64 in result text');
  assert.equal(results.find((r) => r.id === 'call_one').text, 'looks/frames/bio_2_alphabet.png\nlooks/frames/bio_3_find.png');
  assert.equal(results.find((r) => r.id === 'call_one').durationMs, 1000);
  assert.equal(results.find((r) => r.id === 'call_stdin').text, 'ok');
  assert.equal(results.find((r) => r.id === 'call_patch').text, '');
  assert.equal(results.find((r) => r.id === 'call_script').text, '1,2,3');

  // The allSettled script's images follow the view_image call that made each.
  const settled = blocks.slice(blocks.indexOf(uses[1]), blocks.indexOf(uses[3]) + 2).map((b) => b.type);
  assert.deepEqual(settled, ['tool_use', 'tool_result', 'image', 'tool_use', 'tool_result', 'image', 'tool_use', 'tool_result']);
  assert.match(blocks.find((b) => b.type === 'image').src, /^data:image\/png;base64,/);
  assert.equal(blocks.filter((b) => b.type === 'image').length, 2);
});

test('the digest counts the unpacked tools and the patched file', () => {
  const { stats, digest } = parseCodex(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(stats.tools, { exec_command: 2, view_image: 2, write_stdin: 1, apply_patch: 1, exec: 1 });
  assert.equal(stats.toolCalls, 7);
  assert.deepEqual(digest.sinceFiles, [PATCHED]);
  assert.ok(!JSON.stringify(digest).includes('base64'), 'no image data in the digest');
});

test('classic calls are untouched', async () => {
  const file = path.join(TMP, 'classic.jsonl');
  const line = (payload) => JSON.stringify({ timestamp: '2026-10-21T08:00:00.000Z', type: 'response_item', payload });
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: '2026-10-21T08:00:00.000Z', type: 'session_meta', payload: { id: 'x', cwd: TMP } }),
    line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    line({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"ls"}' }),
    line({ type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\nOutput:\na\n' }),
    line({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: /w/a.txt\n@@\n-a\n+b\n*** End Patch' }),
    line({ type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM /w/a.txt\n' }),
  ].join('\n') + '\n');
  const page = await readTraceByPath(file);
  const blocks = page.turns.flatMap((t) => t.blocks);
  assert.deepEqual(blocks.filter((b) => b.type === 'tool_use').map((b) => [b.id, b.name, b.text]),
    [['c1', 'exec_command', '{"cmd":"ls"}'], ['c2', 'apply_patch', '*** Begin Patch\n*** Update File: /w/a.txt\n@@\n-a\n+b\n*** End Patch']]);
  assert.deepEqual(blocks.filter((b) => b.type === 'tool_result').map((b) => b.text),
    ['Process exited with code 0\nOutput:\na\n', 'Success. Updated the following files:\nM /w/a.txt\n']);
  const { stats, digest } = parseCodex(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stats.tools, { exec_command: 1, apply_patch: 1 });
  assert.deepEqual(digest.sinceFiles, ['/w/a.txt']);
});

test('the parser reads literals and never runs the code', () => {
  globalThis.__ran = false;
  const { calls } = codeModeCalls('globalThis.__ran = true; await tools.exec_command({cmd:`echo ${x}`, "workdir": \'/a\', n: 0x10, ok: true, xs: [1, null,], /* c */ });');
  assert.equal(globalThis.__ran, false);
  assert.deepEqual(calls, [{ name: 'exec_command', args: { cmd: 'echo ${x}', workdir: '/a', n: 16, ok: true, xs: [1, null] } }]);

  // A variable argument is kept as source; a tool name inside a string is not a call.
  assert.deepEqual(codeModeCalls('const s = "tools.exec_command({cmd:1})"; tools.view_image(opts);').calls,
    [{ name: 'view_image', args: { raw: 'opts' } }]);
  assert.deepEqual(codeModeCalls('paths.map(p=>tools.view_image({path:`/f/${p}.png`}))').calls,
    [{ name: 'view_image', args: { path: '/f/${p}.png' } }]);
  assert.equal(codeModeCalls('text(1+1)').parsed, false);
  assert.equal(codeModeCalls('tools.exec_command({cmd:"unterminated').parsed, false, 'a call that never closes is a script');
});

test('outputs: wrapper stripped, exit codes and rejections kept, images separate', () => {
  const o = codeModeOutput([
    { type: 'input_text', text: 'Script completed\nWall time 2.5 seconds\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify({ exit_code: 2, output: 'boom\n' }) },
    { type: 'input_text', text: JSON.stringify({ i: 1, status: 'rejected', reason: { message: 'no such file' } }) },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ]);
  assert.equal(o.wallMs, 2500);
  assert.equal(o.text, 'boom\n(exit 2)\nno such file');
  assert.equal(o.failed, true);
  assert.deepEqual(o.images, [{ src: 'data:image/png;base64,AAAA' }]);
});

// ---------------------------------------------------------------- review #220
// One rollout per case: a script and its output, read by the reader and the digest.
let n = 0;
async function readScript(input, output) {
  const file = path.join(TMP, `case-${++n}.jsonl`);
  const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-21T08:00:00.000Z', type, payload });
  fs.writeFileSync(file, [
    line('session_meta', { id: `case-${n}`, cwd: TMP }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }),
    line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c', input }),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'c', output }),
  ].join('\n') + '\n');
  const page = await readTraceByPath(file);
  return { blocks: page.turns.flatMap((t) => t.blocks), digest: parseCodex(fs.readFileSync(file, 'utf8')) };
}
const wrapper = { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' };
const txt = (text) => ({ type: 'input_text', text: typeof text === 'string' ? text : JSON.stringify(text) });
const resultOf = (blocks, id) => blocks.find((b) => b.type === 'tool_result' && b.id === id);

test('1. an escape naming no character stays as written instead of throwing', async () => {
  const input = 'tools.exec_command({cmd:"\\u{110000}"})';
  assert.deepEqual(codeModeCalls(input).calls, [{ name: 'exec_command', args: { cmd: '\\u{110000}' } }]);
  const { blocks, digest } = await readScript(input, [wrapper, txt({ exit_code: 0, output: '' })]);
  assert.equal(JSON.parse(blocks.find((b) => b.type === 'tool_use').text).cmd, '\\u{110000}');
  assert.deepEqual(digest.stats.tools, { exec_command: 1 });
});

test('2. deep nesting is capped and the snippet becomes a script', async () => {
  const input = 'tools.exec_command(' + '['.repeat(10000) + '0' + ']'.repeat(10000) + ')';
  assert.equal(codeModeCalls(input).parsed, false);
  const { blocks, digest } = await readScript(input, [wrapper]);
  const use = blocks.find((b) => b.type === 'tool_use');
  assert.equal(use.name, 'script');
  // 20 KB of code is past the block cap, so the text is a clipped prefix.
  assert.ok(use.text.startsWith('{"description":"Ran a script","code":"tools.exec_command([[['), use.text.slice(0, 80));
  assert.ok(use.more > 0);
  assert.deepEqual(digest.stats.tools, { exec: 1 });
  // 64 levels is still read.
  const ok = 'tools.exec_command({x:' + '['.repeat(60) + '0' + ']'.repeat(60) + '})';
  assert.equal(codeModeCalls(ok).parsed, true);
});

test('3. unclosed calls are read in linear time and fall back to a script', async () => {
  const input = 'tools.exec_command('.repeat(4000);
  let t = performance.now();
  assert.equal(codeModeCalls(input).parsed, false);
  assert.ok(performance.now() - t < 200, `took ${Math.round(performance.now() - t)} ms`);
  const { blocks } = await readScript(input, [wrapper]);
  assert.equal(blocks.find((b) => b.type === 'tool_use').name, 'script');
  // The work budget bounds the other pathological shapes too.
  for (const bad of ['`${'.repeat(20000), '"'.repeat(1) + "'x".repeat(40000), `tools.a(${'"\\u'.repeat(30000)})`]) {
    t = performance.now();
    codeModeCalls(bad);
    assert.ok(performance.now() - t < 300, `${bad.slice(0, 12)}… took ${Math.round(performance.now() - t)} ms`);
  }
  // Oversized input is not read at all.
  assert.equal(codeModeCalls(`tools.exec_command({cmd:"${'x'.repeat(2 * 1024 * 1024)}"})`).parsed, false);
});

test('4. each call gets its own output and failure, or the script gets the lot', async () => {
  const input = 'const rs=await Promise.allSettled([tools.exec_command({cmd:"false"}),tools.exec_command({cmd:"echo OK"})]);for(let i=0;i<rs.length;i++){text(i);text(rs[i].value)}';
  const fail = { exit_code: 1, output: '' };
  const ok = { exit_code: 0, output: 'OK\n' };
  // text(i) before each result
  let { blocks } = await readScript(input, [wrapper, txt('0'), txt(fail), txt('1'), txt(ok)]);
  assert.deepEqual([resultOf(blocks, 'c:0').text, !!resultOf(blocks, 'c:0').failed], ['(exit 1)', true]);
  assert.deepEqual([resultOf(blocks, 'c:1').text, !!resultOf(blocks, 'c:1').failed], ['OK', false]);
  // text({i, ...r})
  ({ blocks } = await readScript(input, [wrapper,
    txt({ i: 0, status: 'fulfilled', value: fail }), txt({ i: 1, status: 'fulfilled', value: ok })]));
  assert.deepEqual([resultOf(blocks, 'c:0').text, !!resultOf(blocks, 'c:0').failed], ['(exit 1)', true]);
  assert.deepEqual([resultOf(blocks, 'c:1').text, !!resultOf(blocks, 'c:1').failed], ['OK', false]);
  assert.equal(blocks.some((b) => b.name === 'script'), false);

  // Two view_image calls, only the first succeeds: the image is the first's.
  const views = 'const rs=await Promise.allSettled([tools.view_image({path:"/tmp/a.png"}),tools.view_image({path:"/tmp/b.png"})]);for(let i=0;i<rs.length;i++){text(i);if(rs[i].status==="fulfilled")image(rs[i].value.image_url);else text(rs[i]);}';
  ({ blocks } = await readScript(views, [wrapper, txt('0'), { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    txt('1'), txt({ status: 'rejected', reason: { message: 'no such file' } })]));
  assert.deepEqual(blocks.map((b) => [b.type, b.id || '', !!b.failed]), [
    ['text', '', false],
    ['tool_use', 'c:0', false], ['tool_result', 'c:0', false], ['image', '', false],
    ['tool_use', 'c:1', false], ['tool_result', 'c:1', true],
  ]);
  assert.equal(resultOf(blocks, 'c:1').text, 'no such file');

  // No indexes: nothing says whose output is whose, so it goes on the script once.
  ({ blocks } = await readScript(input, [wrapper, txt(fail), txt(ok)]));
  assert.deepEqual([resultOf(blocks, 'c:0'), resultOf(blocks, 'c:1')].map((r) => [r.text, !!r.failed]), [['', false], ['', false]]);
  const script = blocks.find((b) => b.type === 'tool_use' && b.name === 'script');
  assert.equal(JSON.parse(script.text).code, input);
  assert.equal(resultOf(blocks, script.id).text, '(exit 1)\nOK');
  assert.equal(blocks.indexOf(script), blocks.indexOf(resultOf(blocks, 'c:1')) + 1, 'right after the calls');
});

test('5. data URLs never stay in text', async () => {
  const input = 'text(await tools.view_image({path:"/tmp/a.png"}))';
  const { blocks } = await readScript(input, [wrapper, txt({ image_url: 'data:image/png;base64,AAAA' })]);
  assert.ok(blocks.every((b) => !('text' in b) || !/base64|AAAA/.test(b.text)), JSON.stringify(blocks));
  assert.equal(resultOf(blocks, 'c').text, '{"image_url":"[image, 0 KB]"}');
  // In arguments and in a script's code too.
  const inArgs = 'tools.write_file({content:"data:image/png;base64,QUJD"})';
  assert.equal(codeModeCalls(inArgs).parsed, true);
  const r = await readScript(inArgs, [wrapper]);
  assert.ok(r.blocks.every((b) => !('text' in b) || !b.text.includes('base64')));
  const s = await readScript('text("data:image/png;base64,QUJD")', [wrapper, txt('data:image/png;base64,QUJD')]);
  assert.ok(s.blocks.every((b) => !('text' in b) || !b.text.includes('base64')), JSON.stringify(s.blocks));
  assert.equal(stripDataUrls('a data:text/plain;base64,QUJD b'), 'a [data, 0 KB] b');
});

test('malformed outputs never break the parse', async () => {
  for (const output of [null, 42, 'Script completed\n', { type: 'input_text' }, [null, 7, { type: 'input_image' }, { type: 'input_text', text: 5 }]]) {
    const { blocks } = await readScript('text(await tools.exec_command({cmd:"ls"}))', output);
    assert.equal(blocks.find((b) => b.type === 'tool_use').name, 'exec_command');
  }
});
