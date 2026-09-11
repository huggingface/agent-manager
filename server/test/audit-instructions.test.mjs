// The environment skill is generated at boot. Exercise that output in an
// isolated data/home tree so its privacy claims cannot drift from the API-log
// documentation again.
//
// Run with: node test/audit-instructions.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-audit-instructions-'));
const dataDir = path.join(TMP, 'data');
const homeDir = path.join(TMP, 'home');
const generated = path.join(dataDir, 'workspaces', 'skills', 'environment.md');
fs.mkdirSync(homeDir, { recursive: true });

// Do not let a local test child inherit actual configured credential values.
// The request policy validates PORT at startup (#130), so an ephemeral 0 is refused.
const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const env = { ...process.env, DATA_DIR: dataDir, HOME: homeDir, PORT: String(port), AM_BASHRC: '/nonexistent' };
for (const key of Object.keys(env)) {
  if (/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
}
delete env.SPACE_ID;
delete env.AM_DISTRIBUTE_SKILLS;
env.AUDIT_TEST_SECRET = 'synthetic-configured-value';

const server = spawn(process.execPath, ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });

try {
  // The normal suite runner starts this immediately after filesystem-heavy
  // integration tests; allow a cold server boot without making the assertion
  // depend on host load. The loop still exits as soon as generation completes.
  for (let i = 0; i < 600 && !fs.existsSync(generated); i++) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}: ${output.slice(-2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(generated), `environment skill was not generated: ${output.slice(-300)}`);
  const text = fs.readFileSync(generated, 'utf8');
  assert.match(text, /full non-secret prompt, file and response content/);
  assert.match(text, /best-effort filtering for recognizable credentials/);
  assert.match(text, /remains sensitive and private/);
  assert.match(text, /deleting a source does not delete its audit copy/);
  assert.match(text, /older records were not rewritten/);
  assert.doesNotMatch(text, /prompt and file contents are hashed rather than copied/);

  const docs = fs.readFileSync(path.resolve('..', 'docs', 'api-audit-log.md'), 'utf8');
  assert.match(docs, /full non-secret\s+request, prompt, file-write, result and error content/);
  assert.match(docs, /not an export-safe artifact/);
  assert.match(docs, /existing JSONL bytes and backups are not inspected, rewritten/);
  console.log('audit-instructions: generated and long-form policy describe retained, filtered, prospective private logs');
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  fs.rmSync(TMP, { recursive: true, force: true });
}
