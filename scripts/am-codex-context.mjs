#!/usr/bin/env node
// A native Codex tool's AM attribution, resolved at call time. No AM_ID fallback.
// Configuration is administrator-owned, separate from the thread environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function readConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return localOrigin(cfg.baseUrl);
}
export function localOrigin(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Configure a local AM HTTP origin in baseUrl.');
  }
  return url.origin;
}
export function tuiSpec(target, env = process.env) {
  if (!target || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(target.threadId)
      || ![target.socket, target.codexHome, target.workdir].every((p) => typeof p === 'string' && path.isAbsolute(p) && !/[\x00-\x1f]/.test(p))) {
    throw new Error('Invalid shared client target.');
  }
  const clean = { ...env, CODEX_HOME: target.codexHome };
  // Inherited parent identity must not impersonate this thread in hooks/tools.
  for (const k of Object.keys(clean)) if (k.startsWith('AM_') || k === 'CODEX_THREAD_ID') delete clean[k];
  return { command: 'codex', args: ['--remote', `unix://${target.socket}`, 'resume', target.threadId],
    options: { cwd: target.workdir, env: clean, stdio: 'inherit' } };
}
export async function run(args, { env = process.env, fetchImpl = fetch, print = console.log, launch = spawn } = {}) {
  let configFile = path.join(os.homedir(), '.config', 'agent-manager', 'codex-context.json');
  let baseOverride;
  if (args[0] === '--base-url') { baseOverride = localOrigin(args[1]); args = args.slice(2); }
  else if (args[0] === '--config') { configFile = args[1]; args = args.slice(2); }
  const [command = 'resolve', ...rest] = args;
  if (!['resolve', 'tui'].includes(command) || (command === 'resolve' && rest.some((x) => x !== '--id-only'))
      || (command === 'tui' && rest.length !== 1)) throw new Error('Usage: am-codex-context.mjs [--config FILE] resolve [--id-only] | tui AM_NAME_OR_ID');
  if (command === 'resolve' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(env.CODEX_THREAD_ID || '')) {
    throw new Error('CODEX_THREAD_ID is required; AM_ID is not a fallback.');
  }
  const base = baseOverride || readConfig(configFile);
  const query = command === 'resolve' ? `/api/codex/context?threadId=${encodeURIComponent(env.CODEX_THREAD_ID)}`
    : `/api/codex/client-target?session=${encodeURIComponent(rest[0])}`;
  const response = await fetchImpl(base + query, { headers: { 'x-am-request': '1' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`AM context lookup refused (HTTP ${response.status}).`);
  const data = await response.json();
  if (command === 'resolve') {
    if (data?.threadId !== env.CODEX_THREAD_ID || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.amSessionId || '')) throw new Error('Invalid AM context response.');
    print(rest.includes('--id-only') ? data.amSessionId : JSON.stringify(data, null, 2));
    return 0;
  }
  const spec = tuiSpec(data, env);
  const child = launch(spec.command, spec.args, spec.options);
  const relays = new Map(['SIGHUP', 'SIGTERM'].map((signal) => [signal, () => child.kill(signal)]));
  // The foreground process group already delivers keyboard Ctrl-C to the TUI.
  // Keep the wrapper alive; relaying it again would send two interrupts.
  relays.set('SIGINT', () => {});
  for (const [signal, handler] of relays) process.on(signal, handler);
  try { return await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not launch the shared Codex client.')));
    child.once('exit', (code) => resolve(code ?? 1));
  }); } finally { for (const [signal, handler] of relays) process.off(signal, handler); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
