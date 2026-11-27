import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-pi-trace-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi');
process.env.HOME = path.join(tmp, 'home');
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.OPENCLAW_STATE_DIR = path.join(tmp, 'openclaw');
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const id = '12345678-1234-1234-1234-123456789abc';
const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--work--');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `2026-01-01_${id}.jsonl`);
const records = [
  { type: 'session', version: 3, id, cwd: '/work', timestamp: '2026-01-01T00:00:00Z' },
  { type: 'model_change', modelId: 'model' },
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Read it' }] } },
  { type: 'message', message: { role: 'assistant', model: 'model', usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 100 }, content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/work/a' } }] } },
  { type: 'message', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'contents' }] } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } },
];
fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
const traces = await import('../src/traces.js');
const { findTrace } = await import('../src/share.js');
const store = await import('../src/sessions.js');
store.init();
store.create({ name: 'pi pane', cli: 'pi', path: 'work' });
const stored = store.list()[0];
store.update(stored.id, { sessionUuid: id });

test('pi trace is pinned, labelled and renders its tool result', async () => {
  const session = { id: 'pane', cli: 'pi', sessionUuid: id };
  assert.equal((await findTrace(session)).src, file);
  assert.equal(await findTrace({ ...session, sessionUuid: 'invalid' }), null);
  assert.equal((await traces.traceLocation(session)).path, file);
  const digest = await traces.digestFor(session);
  assert.equal(digest.lastPromptText, 'Read it');
  assert.equal(digest.sinceToolCalls, 1);
  assert.equal(digest.sinceTokens, 112);
  const stats = (await traces.buildTraces()).sessions.find((s) => s.id === stored.id);
  assert.equal(stats.tokensIn, 110);
  assert.equal(stats.cacheRead, 8);
  assert.equal((await traces.searchTrace(session, { q: 'Read it' })).hits.length, 1);
  assert.deepEqual(digest.sinceFiles, ['/work/a']);
  const trace = await traces.readTrace(session);
  assert.equal(trace.harness, 'pi');
  assert.equal(trace.harnessLabel, 'pi');
  assert.equal(trace.turns.find((t) => t.usage)?.usage.in, 110);
  assert.match(JSON.stringify(trace.turns), /contents/);
  const byPath = await traces.readTraceByPath(file);
  assert.equal(byPath.harness, 'pi');
});

test('the same v3 shape outside pi remains OpenClaw', async () => {
  const claw = path.join(tmp, 'openclaw.jsonl');
  fs.copyFileSync(file, claw);
  const trace = await traces.readTraceByPath(claw);
  assert.equal(trace.harness, 'openclaw');
  assert.equal(trace.harnessLabel, 'OpenClaw');
});


test('pi Reader retains image-only and mixed prompts in the turn index', async () => {
  const imageFile = path.join(dir, 'images.jsonl');
  const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  const rows = [
    { type: 'session', version: 3, id: 'images' },
    { type: 'message', message: { role: 'user', content: [image] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'seen' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'mixed' }, image] } },
  ];
  fs.writeFileSync(imageFile, rows.map(JSON.stringify).join('\n') + '\n');
  const page = await traces.readTraceByPath(imageFile);
  assert.deepEqual(page.userTurns, [0, 2]);
  const summary = await traces.readTraceByPath(imageFile, { summary: true });
  assert.deepEqual(summary.userTurns, [0, 2]);
  assert.deepEqual(page.turns[0].blocks[0], { type: 'image', src: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' });
  assert.deepEqual(page.turns[2].blocks.map((b) => b.type), ['text', 'image']);
});

test('pi windows reach the tail and new appends beyond 20,000 messages', async () => {
  const big = path.join(dir, 'long.jsonl');
  const row = (i) => JSON.stringify({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn-${i}` }] } });
  fs.writeFileSync(big, JSON.stringify({ type: 'session', version: 3, id: 'long' }) + '\n' + Array.from({ length: 20002 }, (_, i) => row(i)).join('\n') + '\n');
  const tail = await traces.readTraceByPath(big, { window: { at: 'tail', bytes: 4096 } });
  assert.equal(tail.window.atEnd, true);
  assert.match(JSON.stringify(tail.turns), /turn-20001/);
  fs.appendFileSync(big, row(20002) + '\n');
  const next = await traces.readTraceByPath(big, { window: { at: 'after', cursor: tail.window.end } });
  assert.match(JSON.stringify(next.turns), /turn-20002/);
});


test('duplicate or missing pi UUIDs never resolve to an arbitrary transcript', async () => {
  const session = { id: 'pane', cli: 'pi', sessionUuid: id };
  const another = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--other--');
  fs.mkdirSync(another, { recursive: true });
  const duplicate = path.join(another, `2026-02-01_${id}.jsonl`);
  fs.copyFileSync(file, duplicate);
  assert.equal(await findTrace(session), null);
  assert.equal(await traces.traceLocation(session), null);
  fs.unlinkSync(duplicate);
  assert.equal(await findTrace({ ...session, sessionUuid: '00000000-0000-0000-0000-000000000000' }), null);
});
