#!/usr/bin/env node
// A compatibility experiment, not a deployment script. Owns only the children
// it spawns, uses a fresh CODEX_HOME, never starts model inference or pairs Remote.
// Exit 0: legacy context held; 2: legacy context changed; 1: probe could not run.
// Exit 2 alone does not block a design that resolves AM identity from the native thread ID.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'am-codex-compat-'));
const home = path.join(root, 'codex');
await fs.mkdir(home);
// No real provider or credentials. The only executable input is the fixed
// printf below through the explicit user-shell RPC, which is unsandboxed.
await fs.writeFile(path.join(home, 'config.toml'), `model = "am-test-model"
model_provider = "am-test"
[model_providers.am-test]
name = "AM compatibility fixture"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
`);
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR']
  .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
Object.assign(env, { CODEX_HOME: home, AM_ID: 'synthetic-server', TERM: 'dumb' });
const processes = new Set();

async function start() {
  const child = spawn('codex', ['app-server', '--stdio'], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.add(child);
  // Drain logs but never publish possibly sensitive diagnostic payloads.
  child.stderr.resume();
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  let dead = false;
  const closed = () => {
    dead = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('fixture server exited')); }
    pending.clear();
  };
  child.on('exit', closed); child.on('error', closed); child.stdin.on('error', closed);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { closed(); return; }
    if (msg.method) { for (const fn of listeners) fn(msg); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`RPC ${p.method} failed`)); else p.resolve(msg.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error('fixture server exited')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => { if (error) closed(); });
  });
  const init = await call('initialize', { clientInfo: { name: 'am_compat_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  if (await fs.realpath(init.codexHome) !== await fs.realpath(home)) throw new Error('fixture home mismatch');
  const shellIdentity = async (threadId) => {
    let output = null;
    let finish, timer;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error('fixture shell timed out')), 15000);
    });
    // Install before issuing the RPC: events may precede its acknowledgement.
    const onEvent = (msg) => {
      if (msg.params?.threadId !== threadId) return;
      if (msg.method === 'item/completed' && msg.params.item.type === 'commandExecution') output = msg.params.item.aggregatedOutput;
      if (msg.method === 'turn/completed') finish();
    };
    listeners.add(onEvent);
    try {
      // Promise.all installs rejection handlers immediately on both operations.
      await Promise.all([done, call('thread/shellCommand', {
        threadId, command: 'printf "%s|%s" "$AM_ID" "$CODEX_THREAD_ID"', timeoutMs: 5000,
      })]);
      const [amId, nativeThreadId] = (output || '').split('|');
      return { amId, nativeThreadId };
    } finally { clearTimeout(timer); listeners.delete(onEvent); }
  };
  return { call, shellIdentity, version: /\/(\d+\.\d+\.\d+)/.exec(init.userAgent)?.[1] || null, child };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { processes.delete(child); return; }
  const exit = once(child, 'exit');
  child.stdin.end();
  // Only this test's direct child. Never search processes or signal a daemon.
  const term = setTimeout(() => child.kill('SIGTERM'), 2000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exit; } finally { clearTimeout(term); clearTimeout(kill); processes.delete(child); }
}

try {
  let server = await start();
  const report = { version: server.version, modelCalls: 0, threadCount: 2, initial: [], afterRestart: [] };
  const threads = [];
  for (const label of ['a', 'b']) {
    const cwd = path.join(root, label); await fs.mkdir(cwd);
    const identity = `synthetic-${label}`;
    const result = await server.call('thread/start', {
      cwd, config: { 'shell_environment_policy.set': { AM_ID: identity } },
      sandbox: 'read-only', approvalPolicy: 'never',
    });
    const threadId = result.thread.id;
    threads.push({ threadId, cwd, identity });
    const observed = await server.shellIdentity(threadId);
    report.initial.push({ identityMatches: observed.amId === identity, nativeThreadMatches: observed.nativeThreadId === threadId, cwdMatches: result.cwd === cwd,
      approvalMatches: result.approvalPolicy === 'never', sandboxMatches: result.sandbox?.type === 'readOnly' });
  }
  // Check the first thread again after creating the second to detect shared env.
  report.initialIsolation = (await server.shellIdentity(threads[0].threadId)).amId === threads[0].identity;
  await stop(server.child);
  server = await start();
  for (const { threadId, cwd, identity } of threads) {
    const result = await server.call('thread/resume', { threadId, excludeTurns: true });
    const observed = await server.shellIdentity(threadId);
    report.afterRestart.push({ sameThread: result.thread.id === threadId,
      identityMatches: observed.amId === identity, nativeThreadMatches: observed.nativeThreadId === threadId, inheritedServerIdentity: observed.amId === 'synthetic-server',
      cwdMatches: result.cwd === cwd, approvalMatches: result.approvalPolicy === 'never',
      sandboxMatches: result.sandbox?.type === 'readOnly' });
  }
  report.legacyContextPreserved = report.initialIsolation && report.initial.every((r) => Object.values(r).every(Boolean))
    && report.afterRestart.every((r) => r.sameThread && r.identityMatches && r.cwdMatches && r.approvalMatches && r.sandboxMatches);
  report.nativeThreadIdentityPreserved = [...report.initial, ...report.afterRestart].every((r) => r.nativeThreadMatches);
  // Neither result settles launch readiness: no model tool, TUI, Remote
  // approval routing or active-turn survival is exercised by this experiment.
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.legacyContextPreserved ? 0 : 2;
} catch {
  console.error('Compatibility probe could not complete; no existing sessions were touched.');
  process.exitCode = 1;
} finally {
  for (const child of processes) await stop(child);
  await fs.rm(root, { recursive: true, force: true });
}
