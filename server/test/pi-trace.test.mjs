import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-pi-trace-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi');
process.env.HOME = path.join(tmp, 'home');
const id = '12345678-1234-1234-1234-123456789abc';
const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--work--');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `2026-01-01_${id}.jsonl`);
const records = [
  { type: 'session', version: 3, id, cwd: '/work', timestamp: '2026-01-01T00:00:00Z' },
  { type: 'model_change', modelId: 'model' },
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Read it' }] } },
  { type: 'message', message: { role: 'assistant', model: 'model', usage: { input: 10, output: 2, cacheRead: 8 }, content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/work/a' } }] } },
  { type: 'message', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'contents' }] } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } },
];
fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
const traces = await import('../src/traces.js');

test('pi trace is pinned, labelled and renders its tool result', async () => {
  const session = { id: 'pane', cli: 'pi', sessionUuid: id };
  assert.equal((await traces.traceLocation(session)).path, file);
  const digest = await traces.digestFor(session);
  assert.equal(digest.lastPromptText, 'Read it');
  assert.equal(digest.sinceToolCalls, 1);
  assert.deepEqual(digest.sinceFiles, ['/work/a']);
  const trace = await traces.readTrace(session);
  assert.equal(trace.harness, 'pi');
  assert.equal(trace.harnessLabel, 'pi');
  assert.equal(trace.turns.find((t) => t.usage)?.usage.in, 10);
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
