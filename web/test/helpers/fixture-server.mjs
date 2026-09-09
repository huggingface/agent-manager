// A real backend over a throwaway DATA_DIR, holding a small fleet the browser
// suites and the startup benchmark both drive: two Claude sessions (one with a
// transcript the Reader can show, one empty so the composer is the whole view),
// a Files pane, a Trace pane over the first session, and a group with a Files
// and a Trace pane side by side. Nothing here is live — the Claude sessions are
// never attached (reader mode reads transcripts), and `claude` on PATH is a stub
// that would only sleep if something did spawn it.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves when nothing listens on the port; rejects otherwise. */
const assertPortFree = (port) => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', (e) => reject(new Error(`port ${port} is not free (${e.code}): another server is there, and seeding it would write fixtures into someone else's instance`)));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
});

export async function startFixtureServer({ port, publicDir, tag = 'am-fixture-' }) {
  // Never seed a listener this helper did not start: with the port taken, the
  // child dies of EADDRINUSE while /api/health from the OTHER server answers
  // 200, and every fixture write below would land in that instance — and the
  // measurement would be of whatever build it serves.
  await assertPortFree(port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  const cfgDir = path.join(dataDir, 'claude-config');
  const binDir = path.join(dataDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\necho "fixture claude stub — nothing to see"; sleep 3600\n', { mode: 0o755 });

  // No skill publishing from a test server (SPACE_ID would fan this checkout's
  // templates into every live agent's skills dir), no production hostname.
  const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...base } = process.env;
  const child = spawn('node', ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...base,
      PORT: String(port), DATA_DIR: dataDir, PUBLIC_DIR: publicDir,
      CLAUDE_CONFIG_DIR: cfgDir, PATH: `${binDir}:${base.PATH || ''}`,
      AM_BASHRC: '/nonexistent', SPACE_HOST: '', AM_ALLOW_MISSING_ORIGIN: '1', USE_TMUX: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const origin = `http://127.0.0.1:${port}`;
  const api = async (p, method = 'GET', body) => {
    const r = await fetch(origin + p, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  // Ready means THIS child answers: /api/info names the DATA_DIR it was given,
  // which no other instance shares. A child that exited is a failure at once.
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  const until = Date.now() + 60_000;
  let up = false;
  while (Date.now() < until && !up && !exited) {
    up = await fetch(`${origin}/api/info`).then((r) => (r.ok ? r.json() : null)).then((i) => i?.dataDir === dataDir).catch(() => false);
    if (!up) await sleep(100);
  }
  if (!up) {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`fixture server did not come up on ${port}${exited ? ` (child exited: ${JSON.stringify(exited)})` : ''}\n${logs}`);
  }

  await api('/api/welcome/seen', 'POST');
  const cadence = await api('/api/sessions', 'POST', { name: 'cadence', cli: 'claude', path: 'cadence' });
  const fresh = await api('/api/sessions', 'POST', { name: 'fresh', cli: 'claude', path: 'fresh' });
  const files = await api('/api/sessions', 'POST', { name: 'files', cli: 'files' });
  const trace = await api('/api/sessions', 'POST', { name: 'trace', cli: 'trace' });
  await api(`/api/trace/${trace.id}/source`, 'PUT', { kind: 'session', ref: cadence.id });
  const group = await api('/api/groups', 'POST', { name: 'mixed' });
  const groupFiles = await api('/api/sessions', 'POST', { name: 'g-files', cli: 'files', groupId: group.id });
  const groupTrace = await api('/api/sessions', 'POST', { name: 'g-trace', cli: 'trace', groupId: group.id });
  await api(`/api/trace/${groupTrace.id}/source`, 'PUT', { kind: 'session', ref: cadence.id });
  writeTranscript(cfgDir, path.join(dataDir, 'workspaces', cadence.path || cadence.id));
  // Something for the Files pane to list.
  const ws = path.join(dataDir, 'workspaces');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes', 'README.md'), '# notes\n\nA fixture file.\n');
  fs.writeFileSync(path.join(ws, 'notes', 'plan.txt'), 'one\ntwo\n');

  return {
    origin, api, dataDir, cfgDir,
    ids: { cadence: cadence.id, fresh: fresh.id, files: files.id, trace: trace.id, group: group.id, groupFiles: groupFiles.id, groupTrace: groupTrace.id },
    logs: () => logs,
    stop: async () => {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A Claude transcript of the shape the reader renders (tool calls, a table,
// several turns) — enough history to scroll, small enough to be the same size
// every run. Matched to the session by cwd, so the folder is exactly the one
// the server gave the session.
function writeTranscript(cfgDir, cwd) {
  const UUID = 'f1c7a0de-0000-4000-8000-00000000cade';
  const t0 = Date.parse('2026-08-06T21:14:00Z');
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const msg = (i, content, usage) => ({
    type: 'assistant', uuid: `a${i}`, timestamp: at(i), cwd, sessionId: UUID,
    message: { id: `msg_${i}`, role: 'assistant', content, usage },
  });
  const user = (i, text) => ({
    type: 'user', uuid: `u${i}`, timestamp: at(i), cwd, sessionId: UUID,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const result = (i, id, out) => ({
    type: 'user', uuid: `r${i}`, timestamp: at(i), cwd, sessionId: UUID, toolUseResult: { stdout: out },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] },
  });
  const U = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const EARLIER = [
    ['is the nightly export still green?', 'Green — last run 03:12, 41s, no retries.'],
    ['how big is the bucket now?', '2.4 TB, up 60 GB this week. The trace archive is most of the growth.'],
    ['anything stuck in the queue?', 'Nothing stuck. Two jobs waiting on the same lock, both under a minute old.'],
    ['did the cert renewal go through?', 'Yes, renewed Tuesday, expires 2026-11-04.'],
    ['why did CI take 22 minutes yesterday?', 'A cold npm cache on the runner. Warm again since the last build: 6m 40s.'],
    ['is anyone else on this box?', 'One other session, idle for three hours.'],
    ['what changed in the deploy config?', 'Only the health-check path, from /healthz to /api/health.'],
    ['do we still need the nightly vacuum?', 'Not really — autovacuum keeps up now. It costs 90s a night and reclaims ~12 MB.'],
  ];
  const lines = [
    ...EARLIER.flatMap(([q, a], k) => [
      user(-200 + k * 20, q),
      msg(-199 + k * 20, [{ type: 'tool_use', id: `e${k}`, name: 'Bash', input: { command: 'systemctl status export.service' } }], U(2000, 40)),
      result(-198 + k * 20, `e${k}`, 'active (exited) since Tue 2026-08-06 03:12:44 UTC'),
      msg(-197 + k * 20, [{ type: 'text', text: a }], U(900, 50)),
    ]),
    user(0, 'can you check whether the backup job still runs hourly?'),
    msg(1, [
      { type: 'text', text: 'Checking the timer.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'systemctl list-timers backup.timer' } },
    ], U(8900, 120)),
    result(2, 'tu1', 'NEXT                        LEFT     LAST                        UNIT\nTue 2026-08-06 22:00:00 UTC 42min    Tue 2026-08-06 20:56:00 UTC backup.timer'),
    msg(3, [{ type: 'text', text: 'Hourly, and the last run was 18 minutes ago — nothing to fix.' }], U(1200, 60)),
    user(10, 'the terminal freezes for about a second every 20s. why?'),
    msg(11, [
      { type: 'text', text: 'Let me look at what runs on a 20s cadence.' },
      { type: 'tool_use', id: 'tu2', name: 'Grep', input: { pattern: 'setInterval', path: 'server/src' } },
    ], U(12000, 210)),
    result(12, 'tu2', 'server/src/runner.js:184:  setInterval(tick, 20_000);'),
    msg(15, [{
      type: 'text',
      text: 'Found it — the repin watcher, not the terminal.\n\n**What happens:** `tick()` walks every candidate transcript with a *synchronous* `statSync` every 20s. On the bucket mount those stats are bimodal: **3ms warm, ~1.2s cold**.\n\n| backstop | blocked share |\n| --- | --- |\n| 20s (today) | ~6% |\n| 1 min | ~2% |\n| 10 min | ~0.2% |\n\n**The fix is not blocking:** `fsp.stat` hands the same I/O to the threadpool.',
    }], U(83300, 1900)),
  ];
  const dir = path.join(cfgDir, 'projects', cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** `vite build` into a fresh directory; returns it. Reuses $AM_TEST_DIST if set. */
export function buildWeb(spawnSync, tag = 'am-dist-') {
  if (process.env.AM_TEST_DIST) return process.env.AM_TEST_DIST;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  const r = spawnSync('npx', ['vite', 'build', '--outDir', out], { cwd: path.join(ROOT, 'web'), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`web build failed:\n${r.stdout}\n${r.stderr}`);
  return out;
}
