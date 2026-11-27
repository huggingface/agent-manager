import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-'));
const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
for (const cli of ['pi', 'opencode']) fs.writeFileSync(path.join(bin, cli), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi');
for (const key of ['HF_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) delete process.env[key];
const { cliCatalog } = await import('../src/config.js');
const ready = (cli) => cliCatalog().find((c) => c.id === cli).ready;

test('pi ignores empty auth and accepts saved credentials', () => {
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{}');
  assert.equal(ready('pi'), false);
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{"huggingface":{"type":"api_key","key":"x"}}');
  assert.equal(ready('pi'), true);
});
test('HF_TOKEN configures both harnesses', () => {
  process.env.HF_TOKEN = 'test';
  assert.equal(ready('pi'), true);
  assert.equal(ready('opencode'), true);
});
