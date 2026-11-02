// safeagents (github.com/huggingface/safeagents): a local proxy between an
// agent and its model server that checks every tool call the model makes
// before the harness sees it, and swaps the ones it blocks for a text notice.
//
// The manager runs ONE proxy as a child process and points Claude Code
// sessions at it through ANTHROPIC_BASE_URL. Only Claude Code: it is the one
// agent here whose endpoint is a single env var and whose protocol (Anthropic
// Messages) safeagents guards. Codex speaks the Responses API, which it does not
// check; opencode and Hermes need their config files rewritten, which is a
// change to the operator's own settings rather than to a launch.
//
// Two records come out of it, and the Safety page shows both:
//   - the proxy's stdout: one plain line per reviewed call, PASS included
//     (safeagents prints that format whenever its output is not a terminal).
//     Kept in memory only — it is the live view, and it starts again on reboot.
//   - the journal: every call that did NOT simply pass, with its full
//     arguments, task and findings. Kept on the bucket, since that is the one a
//     user comes back to look at.
//
// Turning the guard off must not cut off a session already launched through
// it: that session's base URL points at the proxy for as long as it runs. So
// "off" lets the proxy drain — it keeps forwarding, in log-only mode, until no
// session it was handed to is still running.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const MODES = ['off', 'log-only', 'block'];
const VERDICTS = { PASS: 'passed', WARN: 'suspicious', FLAG: 'flagged', BLOCK: 'blocked' };
// `HH:MM:SS  #12    BLOCK  Bash          curl … paste.example.com  host `paste.example.com` …`
// The call ref is only there for journaled calls; the tool column is padded to 12.
const CALL_LINE = /^(\d\d:\d\d:\d\d)  (#\d+)?\s*  (PASS|WARN|FLAG|BLOCK)\s+(\S+)\s+(.*)$/;
const LOG_LINES = 1000;
const CALLS = 1000;
const READY_TIMEOUT_MS = 30_000;
const DRAIN_CHECK_MS = 30_000;
// Reading the journal is a page of the newest entries, never the whole file:
// arguments are kept whole, so a long-lived journal is megabytes.
const JOURNAL_TAIL_BYTES = 8 * 1024 * 1024;

/** One stdout line as a call, or null when it is a log message instead. */
export function parseCallLine(line) {
  const m = CALL_LINE.exec(line);
  if (!m) return null;
  const [, time, ref, tag, tool, rest] = m;
  // `what` and `why` are both separated by two spaces, and a command can hold
  // two spaces of its own. A pass has no reason, so all of it is the call; for
  // the others the reason is what follows the last gap.
  let what = rest;
  let why = '';
  if (tag !== 'PASS') {
    const gap = rest.lastIndexOf('  ');
    if (gap >= 0) { what = rest.slice(0, gap); why = rest.slice(gap + 2).trim(); }
  }
  return { time, journalId: ref ? Number(ref.slice(1)) : null, verdict: VERDICTS[tag], tool, what: what.trim(), why };
}

/** The journal's entries, newest first, from the tail of the file. */
export function readJournal(file, { limit = 200, tailBytes = JOURNAL_TAIL_BYTES } = {}) {
  let raw;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      // a tail read starts mid-line; that partial line is not an entry
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && Number.isInteger(entry.id)) entries.push(entry);
    } catch {}
  }
  return entries.reverse().slice(0, limit);
}

/** The command line for one proxy, given what it guards and how. */
export function proxyArgs({ upstream, listen, mode, allowHosts = [], journal }) {
  return [
    upstream, listen,
    ...(mode === 'block' ? [] : ['--log-only']),
    ...allowHosts.flatMap((h) => ['--allow-host', h]),
    '--journal', journal,
  ];
}

function portAnswers(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export function createSafeAgents({
  dataDir,
  bin = process.env.AM_SAFEAGENTS_BIN || 'safeagents',
  port = Number(process.env.AM_SAFEAGENTS_PORT) || 8787,
  // Whatever Claude Code would have talked to: a gateway the operator already
  // set as a Space variable stays the upstream, the proxy only sits in front.
  upstream = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  isRunning = () => false,
} = {}) {
  const dir = path.join(dataDir, 'safeagents');
  const journal = path.join(dir, 'calls.jsonl');
  const listen = `127.0.0.1:${port}`;
  const baseUrl = `http://${listen}`;

  let wanted = { mode: 'off', allowHosts: [] };
  let child = null;
  let running = null; // the settings the current child was started with
  let state = 'off'; // off | starting | ready | draining | failed | unavailable
  let lastError = null;
  let startedAt = null;
  let restarts = 0;
  let restartTimer = null;
  let drainTimer = null;
  let stopping = null;
  const log = [];
  const calls = [];
  const counts = { passed: 0, suspicious: 0, flagged: 0, blocked: 0 };
  // Sessions whose launch env named the proxy, with the run they were handed
  // it for — the ones that must not lose it when the guard is turned off.
  const routed = new Map();

  const push = (list, item, max) => { list.push(item); if (list.length > max) list.splice(0, list.length - max); };
  const note = (text) => push(log, { at: Date.now(), text }, LOG_LINES);

  const installed = () => new Promise((resolve) => {
    execFile(bin, ['--help'], { timeout: 15_000 }, (error) => resolve(!error));
  });

  function onLine(line) {
    if (!line.trim()) return;
    const call = parseCallLine(line);
    if (call) {
      counts[call.verdict] += 1;
      push(calls, { at: Date.now(), ...call }, CALLS);
    } else {
      note(line);
    }
  }

  function pipeLines(stream) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    });
    stream.on('end', () => { if (buf) onLine(buf); buf = ''; });
  }

  async function start(settings) {
    if (!(await installed())) {
      state = 'unavailable';
      lastError = `\`${bin}\` is not on PATH`;
      return;
    }
    if (await portAnswers(port)) {
      state = 'failed';
      lastError = `${listen} is already in use`;
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const args = proxyArgs({ upstream, listen, mode: settings.mode, allowHosts: settings.allowHosts, journal });
    note(`$ ${bin} ${args.join(' ')}`);
    state = 'starting';
    lastError = null;
    running = settings;
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Plain lines, not the boxed live view, and no colour codes in them.
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PYTHONUNBUFFERED: '1' },
    });
    child = proc;
    pipeLines(proc.stdout);
    pipeLines(proc.stderr);
    proc.on('error', (e) => { lastError = e.message; note(`[agent-manager] ${e.message}`); });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      note(`[agent-manager] proxy exited (${signal || `code ${code}`})`);
      if (stopping) return;
      // Sessions already point at this port, so a proxy that died has to come
      // back — a backoff keeps a proxy that cannot start from spinning.
      state = 'failed';
      lastError = lastError || `the proxy exited (${signal || `code ${code}`})`;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(restarts, 6));
      restarts += 1;
      restartTimer = setTimeout(() => { restartTimer = null; void reconcile(); }, delay);
    });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (child === proc && Date.now() < deadline) {
      if (await portAnswers(port)) {
        state = running.mode === 'off' ? 'draining' : 'ready';
        startedAt = Date.now();
        restarts = 0;
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (child === proc) {
      lastError = 'the proxy did not start listening in time';
      proc.kill('SIGKILL');
    }
  }

  async function stop() {
    const proc = child;
    if (!proc) return;
    let done;
    stopping = new Promise((r) => { done = r; });
    proc.once('exit', () => done());
    proc.kill('SIGTERM');
    const killer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await stopping;
    clearTimeout(killer);
    stopping = null;
    child = null;
    running = null;
  }

  const stillRouted = () => {
    for (const [id, runId] of routed) {
      if (!isRunning(id, runId)) routed.delete(id);
    }
    return routed.size > 0;
  };

  // What should be running, given the setting and who still depends on the
  // proxy. Serialized: a mode change arriving mid-start waits for that start.
  let chain = Promise.resolve();
  function reconcile() {
    chain = chain.then(async () => {
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      const target = wanted.mode === 'off'
        ? (stillRouted() ? { mode: 'off', allowHosts: wanted.allowHosts } : null)
        : wanted;
      const same = running && target && running.mode === target.mode
        && running.allowHosts.join('\n') === target.allowHosts.join('\n');
      if (child && same) {
        if (target.mode === 'off') state = 'draining';
        return;
      }
      await stop();
      if (!target) { state = 'off'; lastError = null; return; }
      await start(target);
    }).catch((e) => { state = 'failed'; lastError = String((e && e.message) || e); });
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    if (wanted.mode === 'off') {
      drainTimer = setInterval(() => { if (!stillRouted()) void reconcile(); }, DRAIN_CHECK_MS);
      drainTimer.unref?.();
    }
    return chain;
  }

  return {
    journalPath: journal,
    configure(settings) {
      wanted = {
        mode: MODES.includes(settings?.mode) ? settings.mode : 'off',
        allowHosts: Array.isArray(settings?.allowHosts) ? settings.allowHosts : [],
      };
      return reconcile();
    },
    /** Extra env for a session about to launch: the proxy, or nothing. A proxy
     *  that is not up gets nothing, rather than a URL nobody answers. */
    envFor(session, runId) {
      if (session?.cli !== 'claude' || wanted.mode === 'off' || state !== 'ready') return {};
      routed.set(session.id, runId);
      return { ANTHROPIC_BASE_URL: baseUrl };
    },
    status() {
      stillRouted();
      return {
        mode: wanted.mode,
        state,
        error: lastError,
        upstream,
        listen: baseUrl,
        runningMode: running?.mode === 'off' ? 'log-only' : running?.mode || null,
        startedAt,
        pid: child?.pid || null,
        counts,
        guarded: [...routed.keys()],
      };
    },
    recentCalls: (limit = 300) => calls.slice(-limit).reverse(),
    recentLog: (limit = 300) => log.slice(-limit).reverse(),
    journal: (limit) => readJournal(journal, { limit }),
    shutdown: async () => {
      wanted = { mode: 'off', allowHosts: [] };
      routed.clear();
      if (drainTimer) clearInterval(drainTimer);
      if (restartTimer) clearTimeout(restartTimer);
      await stop();
    },
  };
}
