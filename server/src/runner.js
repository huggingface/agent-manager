import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { USE_TMUX, cliById, WORKSPACES_DIR } from './config.js';
import { update, list } from './sessions.js';

const TERM_ENV = {
  ...process.env,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: process.env.LANG || 'C.UTF-8',
};

const BASHRC = process.env.AM_BASHRC || '/app/session.bashrc';
const TMUX_CONF = process.env.TMUX_CONF || '/app/tmux.conf';
const AM_USER = process.env.SPACE_AUTHOR_NAME || process.env.AM_USER || os.userInfo().username || 'user';

// Interactive bash that loads our prompt rcfile (bash ignores a missing rcfile,
// so this is safe in local dev where /app/session.bashrc doesn't exist).
const bashLaunch = `exec bash --rcfile ${BASHRC} -i`;

const tmuxName = (id) => `am-${id}`;

// If the rendered pane text hasn't changed for this long, it's not working.
const BUSY_SECS = 4;
const paneSig = new Map(); // id -> { sig, changedAt } (changedAt in unix seconds)

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// In direct-PTY (no-tmux) mode we track live handles to report running status.
const live = new Map(); // id -> Set(handle)
const track = (id, h) => {
  if (!live.has(id)) live.set(id, new Set());
  live.get(id).add(h);
};
const untrack = (id, h) => {
  const s = live.get(id);
  if (s) {
    s.delete(h);
    if (!s.size) live.delete(id);
  }
};

export function isRunning(id) {
  if (USE_TMUX) {
    try {
      execFileSync('tmux', ['has-session', '-t', tmuxName(id)], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return live.has(id);
}

// Which sessions have a pane in copy mode right now — one tmux call covers all
// panes, so the server can push a copy-mode hint to attached clients cheaply.
export function paneModes() {
  const modes = {};
  if (!USE_TMUX) return modes;
  let out = '';
  try {
    // Mode first (a single 0/1), then the session name — which is `am-<id>`
    // and never contains a space, so splitting on the first space is safe.
    out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_in_mode} #{session_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return modes; } // no tmux server yet
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const name = line.slice(sp + 1);
    if (!name.startsWith('am-')) continue;
    const id = name.slice(3);
    modes[id] = modes[id] || line.slice(0, sp) === '1';
  }
  return modes;
}

/**
 * Detect activity by DIFFING each pane's rendered text between polls. This
 * ignores colour-only animations (e.g. Codex's shimmering banner) that fooled a
 * raw output-activity check, while still catching spinners, streaming output and
 * elapsed-time counters (their text changes). Returns Map id -> { age } where
 * age is seconds since the pane text last changed.
 */
let infoMemo = { ts: 0, map: new Map() };

export function agentInfo() {
  // The sweep shells out to tmux once per session, synchronously. Memoize it
  // briefly so N browser tabs polling /api/tree don't multiply that cost.
  if (Date.now() - infoMemo.ts < 1500) return infoMemo.map;
  const map = new Map();
  infoMemo = { ts: Date.now(), map };
  if (!USE_TMUX) return map;
  let list;
  try {
    list = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  } catch {
    paneSig.clear();
    return map; // no server / no sessions
  }
  const now = Math.floor(Date.now() / 1000);
  const live = new Set();
  for (const name of list.split('\n')) {
    if (!name.startsWith('am-')) continue;
    const id = name.slice(3);
    live.add(id);
    let text = '';
    try { text = execFileSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' }); } catch {}
    const sig = djb2(text);
    const prev = paneSig.get(id);
    const changedAt = !prev || prev.sig !== sig ? now : prev.changedAt;
    paneSig.set(id, { sig, changedAt });
    map.set(id, { age: now - changedAt });
  }
  for (const id of [...paneSig.keys()]) if (!live.has(id)) paneSig.delete(id);
  return map;
}

/**
 * Map activity + the session's known CLI into a UI state:
 *   working  — pane text is actively changing (thinking / streaming / a command)
 *   waiting  — agent alive but its screen is static → it's your turn
 *   idle     — a plain shell sitting at its prompt
 *   stopped  — no live session
 */
export function deriveState(session, info) {
  if (session.cli === 'files') return 'idle'; // passive panel, not a process
  if (!info) return isRunning(session.id) ? 'idle' : 'stopped';
  if (info.age <= BUSY_SECS) return 'working';
  return session.cli === 'shell' ? 'idle' : 'waiting';
}

// ---------- Codex conversation pinning ----------
// Codex picks its own conversation id at launch and doesn't accept one up
// front — but it announces the pick immediately: a rollout file named
// rollout-<ts>-<id>.jsonl appears under $CODEX_HOME/sessions with the cwd in
// its first line. Capture that id shortly after launch and pin it on the
// session, so restarts resume THIS agent's conversation — `resume --last`
// would grab whichever Codex agent in the same folder ran last.
const codexCapturing = new Set(); // session ids with a capture in flight

function codexSessionsRoot() {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

// Rollout files touched since `sinceMs`, newest first.
function codexRolloutsSince(sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { const m = fs.statSync(p).mtimeMs; if (m >= sinceMs) out.push({ p, m }); } catch {}
      }
    }
  };
  walk(codexSessionsRoot(), 0);
  return out.sort((a, b) => b.m - a.m);
}

// First line of a (potentially large) file without reading all of it. Codex's
// session_meta line carries the full embedded instruction text (~22KB as of
// 0.142), so read in chunks until the newline — a fixed small buffer would
// truncate the JSON and make every capture silently fail.
function firstLine(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const CHUNK = 65536, MAX = 1024 * 1024;
    let buf = Buffer.alloc(0);
    for (let pos = 0; pos < MAX; pos += CHUNK) {
      const b = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, b, 0, CHUNK, pos);
      buf = Buffer.concat([buf, b.subarray(0, n)]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) return buf.toString('utf8', 0, nl);
      if (n < CHUNK) break; // EOF
    }
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function tryCaptureCodexId(sessionId, workdir, sinceMs) {
  const claimed = new Set(list().filter((s) => s.id !== sessionId && s.codexSessionId).map((s) => s.codexSessionId));
  for (const c of codexRolloutsSince(sinceMs)) {
    const m = c.p.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    if (!m || claimed.has(m[1])) continue;
    let meta;
    try { meta = JSON.parse(firstLine(c.p)); } catch { continue; }
    const mp = (meta && meta.payload) || {};
    if (mp.cwd !== workdir) continue;
    // A sibling's ongoing conversation in the same folder gets fresh writes
    // (mtime) during our capture window — require the rollout to have been
    // CREATED after this launch so we never claim someone else's thread.
    const created = Date.parse(mp.timestamp || meta.timestamp || '') || 0;
    if (created && created < sinceMs - 15_000) continue;
    // Skip Codex's internal guardian/subagent rollouts — they share the cwd but
    // aren't this agent's conversation, so pinning one would break resume and
    // the Overview digest.
    if (mp.thread_source === 'subagent' || (mp.source && mp.source.subagent)) continue;
    update(sessionId, { codexSessionId: m[1], codexRollout: c.p });
    return true;
  }
  return false;
}

// A pin captured before subagents were filtered out (or one whose rollout was
// rotated away) may point at a guardian/missing rollout — clear it so we
// re-capture the real conversation on this launch.
function pinIsStale(session) {
  if (!session.codexSessionId) return false;
  const p = session.codexRollout;
  if (!p || !fs.existsSync(p)) return true;
  try {
    const mp = (JSON.parse(firstLine(p)) || {}).payload || {};
    return mp.thread_source === 'subagent' || !!(mp.source && mp.source.subagent);
  } catch { return false; }
}

function scheduleCodexCapture(session, workdir) {
  if (session.codexSessionId && pinIsStale(session)) {
    session = update(session.id, { codexSessionId: undefined, codexRollout: undefined }) || session;
  }
  if (session.codexSessionId || codexCapturing.has(session.id)) return;
  codexCapturing.add(session.id);
  const since = Date.now() - 2000;
  const delays = [5000, 15000, 45000]; // rollout appears ~instantly; retries cover slow starts
  const attempt = (i) => {
    if (tryCaptureCodexId(session.id, workdir, since) || i + 1 >= delays.length) {
      codexCapturing.delete(session.id);
      return;
    }
    const t = setTimeout(() => attempt(i + 1), delays[i + 1] - delays[i]);
    if (t.unref) t.unref();
  };
  const t0 = setTimeout(() => attempt(0), delays[0]);
  if (t0.unref) t0.unref();
}

// Single-quote a string for embedding in an `sh -lc` command line.
const shq = (t) => `'${String(t).replace(/'/g, `'\\''`)}'`;

function commandFor(session) {
  const cli = cliById(session.cli) || cliById('shell');
  if (cli.id === 'shell') return bashLaunch;
  // Quickstart: a prompt queued at creation rides the FIRST launch command
  // (claude 'p', codex 'p', gemini -i 'p', opencode --prompt 'p') — the CLI
  // starts already working on it, no typing race against a booting TUI.
  const q0 = !session.everStarted && session.pendingPrompt ? shq(session.pendingPrompt) : '';

  // Claude keys conversations by working directory, so grouped sessions sharing
  // a folder would all `--continue` onto the SAME most-recent conversation. Pin
  // each session to its own conversation id instead: create it with
  // --session-id, resume it with --resume. Decide resume-vs-fresh by whether the
  // transcript exists on disk (NOT via `resume || fresh`: that chain also fired
  // when claude itself exited non-zero, silently respawning a crashed session
  // as a fresh conversation and eating the pane's "done" signal). The fresh
  // branch keeps `|| exec claude` as a last resort for an unsupported flag.
  if (cli.id === 'claude' && session.sessionUuid) {
    const fresh = `claude --session-id ${session.sessionUuid}${q0 ? ` ${q0}` : ''} || exec claude`;
    if (!session.everStarted) return fresh;
    const projects = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"';
    const hasTranscript = `[ -n "$(find ${projects} -name '${session.sessionUuid}*' -print -quit 2>/dev/null)" ]`;
    return `if ${hasTranscript}; then exec claude --resume ${session.sessionUuid}; else ${fresh}; fi`;
  }

  // OpenClaw: first run needs its onboarding wizard (keys, workspace); once the
  // config exists, go straight to the TUI. Decided by config-file existence —
  // same honest pattern as the Claude transcript check.
  if (cli.id === 'openclaw') {
    // OpenClaw runs with its own HOME on local disk (see entrypoint.sh): its
    // state can't live on the FUSE bucket and it rejects symlinked paths.
    // Locally (no OPENCLAW_HOME) the real HOME is used unchanged.
    return 'HOME="${OPENCLAW_HOME:-$HOME}"; export HOME; '
      + 'if [ -s "$HOME/.openclaw/openclaw.json" ]; then exec openclaw chat; '
      + 'else openclaw onboard && exec openclaw chat; fi';
  }

  // Codex: resume this agent's pinned conversation (captured from its rollout
  // file after launch — see scheduleCodexCapture). Existence-checked like
  // Claude, so a purged rollout starts fresh honestly and a crash ends the
  // pane instead of respawning. Unpinned sessions fall through to the generic
  // `resume --last` below (correct while the agent has its folder to itself).
  if (cli.id === 'codex' && session.codexSessionId && session.codexRollout) {
    return `if [ -f '${session.codexRollout}' ]; then exec codex resume ${session.codexSessionId}; else exec codex; fi`;
  }

  // opencode (seen on 1.17.13): at startup it creates a DIRECTORY named
  // opencode.json at its own config path, then every message dies re-reading
  // it (EISDIR → the model silently never responds; the next launch exits
  // instantly). Clear a directory-shaped entry AND occupy the path with a real
  // config file — copied from opencode.jsonc when one exists — so the bug
  // can't re-trigger mid-session. An existing config FILE is left untouched.
  if (cli.id === 'opencode') {
    const guard = 'G="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"; '
      + 'mkdir -p "$(dirname "$G")"; [ -d "$G" ] && rm -rf "$G"; '
      + '[ -e "$G" ] || { [ -f "${G}c" ] && cp "${G}c" "$G" || echo "{}" > "$G"; }; ';
    const base = session.everStarted && cli.cont
      ? `${cli.cont} || exec ${cli.run}`
      : `exec ${q0 && cli.withPrompt ? cli.withPrompt(q0) : cli.run}`;
    return `${guard}${base}`;
  }

  // codex without a pinned conversation: `resume --last` scopes to the cwd,
  // so in a SHARED folder it can resume a SIBLING's conversation (cross-talk).
  // Only resume when this session has the folder to itself; otherwise start
  // fresh — capture pins the new conversation right away.
  if (cli.id === 'codex' && session.everStarted) {
    const folder = session.path ?? session.id;
    const shared = list().some((o) => o.id !== session.id && o.cli === 'codex' && (o.path ?? o.id) === folder);
    if (shared) return `exec ${cli.run}`;
  }

  // Other agents: resume when one likely exists, else a fresh launch. `exec` so
  // the agent is the pane's foreground process; when it exits the tmux session
  // ends — a clear "done" signal — and the fallback preserves that.
  if (session.everStarted && cli.cont) return `${cli.cont} || exec ${cli.run}`;
  if (q0 && cli.withPrompt) return `exec ${cli.withPrompt(q0)}`;
  return `exec ${cli.run}`;
}

/** Attach a new PTY client to the session (creating the tmux session if needed). */
export function attach(session, cols, rows) {
  // The recorded workspace-relative path ('' = the workspaces root itself).
  // If the folder was deleted or moved, mkdir simply recreates it empty — no
  // tracking, no magic.
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  fs.mkdirSync(workdir, { recursive: true });
  const full = commandFor(session);

  let term;
  if (USE_TMUX) {
    const args = [];
    if (fs.existsSync(TMUX_CONF)) args.push('-f', TMUX_CONF);
    args.push(
      // -A: attach if it exists, else create. We deliberately do NOT pass -D
      // (detach others): the same session may be open in two browser windows,
      // and -D + auto-reconnect would make them fight. Instead each client
      // re-syncs its size on focus (see TerminalPane), and window-size=latest
      // makes the focused window fit exactly.
      'new-session', '-A', '-s', tmuxName(session.id), '-c', workdir,
      '-e', `AM_SESSION=${folder}`,
      '-e', `AM_NAME=${session.name}`,
      '-e', `AM_ID=${session.id}`,
      '-e', `AM_USER=${AM_USER}`,
      '-e', `AM_ROOT=${WORKSPACES_DIR}`, // prompt shows $PWD relative to this
      'sh', '-lc', full,
    );
    term = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: workdir, env: TERM_ENV });
  } else {
    const env = { ...TERM_ENV, AM_SESSION: folder, AM_NAME: session.name, AM_ID: session.id, AM_USER, AM_ROOT: WORKSPACES_DIR };
    term = pty.spawn('bash', ['-lc', full], { name: 'xterm-256color', cols, rows, cwd: workdir, env });
  }

  if (!session.everStarted) update(session.id, { everStarted: true, pendingPrompt: undefined });
  if (session.cli === 'codex') scheduleCodexCapture(session, workdir);

  const handle = {
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(cb),
    write: (d) => { try { term.write(d); } catch {} },
    resize: (c, r) => { try { term.resize(c, r); } catch {} },
    kill: () => { try { term.kill(); } catch {} },
  };
  track(session.id, handle);
  term.onExit(() => untrack(session.id, handle));
  return handle;
}

/**
 * Make sure the session's tmux process exists WITHOUT a browser pane attached
 * (used by the Overview reply box to wake a stopped agent). Returns true if it
 * had to spawn. Direct-PTY mode has no detached equivalent — throws if dead.
 */
export function ensureRunning(session) {
  if (isRunning(session.id)) return false;
  if (!USE_TMUX) throw new Error('session is not running');
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  fs.mkdirSync(workdir, { recursive: true });
  const args = [];
  if (fs.existsSync(TMUX_CONF)) args.push('-f', TMUX_CONF);
  args.push(
    'new-session', '-d', '-s', tmuxName(session.id), '-c', workdir,
    '-x', '200', '-y', '50', // sane size until a client attaches (window-size=latest)
    '-e', `AM_SESSION=${folder}`,
    '-e', `AM_NAME=${session.name}`,
    '-e', `AM_ID=${session.id}`,
    '-e', `AM_USER=${AM_USER}`,
    '-e', `AM_ROOT=${WORKSPACES_DIR}`,
    'sh', '-lc', commandFor(session),
  );
  execFileSync('tmux', args, { stdio: 'ignore', env: TERM_ENV });
  if (!session.everStarted) update(session.id, { everStarted: true, pendingPrompt: undefined });
  if (session.cli === 'codex') scheduleCodexCapture(session, workdir);
  return true;
}

/** Type a line into the session's terminal (works with no browser attached). */
export async function sendInput(id, text) {
  // Multi-line prompts go in as a bracketed paste so the CLI's composer treats
  // the inner newlines as soft line breaks instead of submitting early.
  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  // The Enter must arrive as its OWN keypress: TUIs (codex) detect rapid input
  // bursts as a paste, and a CR inside the burst becomes a newline in the
  // composer instead of a submit. A short gap breaks the burst.
  const gap = () => new Promise((r) => setTimeout(r, 300));
  if (USE_TMUX) {
    execFileSync('tmux', ['send-keys', '-t', tmuxName(id), '-l', '--', payload], { stdio: 'ignore' });
    await gap();
    execFileSync('tmux', ['send-keys', '-t', tmuxName(id), 'Enter'], { stdio: 'ignore' });
    return;
  }
  const set = live.get(id);
  if (!set || !set.size) throw new Error('session is not running');
  const h = set.values().next().value;
  h.write(payload);
  await gap();
  h.write('\r');
}

/** Return the last mouse selection for this session as a browser-consumable OSC 52. */
export function copySelection(id) {
  if (!USE_TMUX) return null;
  const bufferName = `am-copy-${tmuxName(id)}`;
  let text = '';
  try {
    text = execFileSync('tmux', ['save-buffer', '-b', bufferName, '-'], { encoding: 'utf8', env: TERM_ENV });
  } catch {
    try {
      text = execFileSync('tmux', ['save-buffer', '-'], { encoding: 'utf8', env: TERM_ENV });
    } catch {
      return null;
    }
  }
  if (!text) return null;
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** Stop a session entirely (kills the tmux session / the running process). */
export function stop(id) {
  if (USE_TMUX) {
    try {
      execFileSync('tmux', ['kill-session', '-t', tmuxName(id)], { stdio: 'ignore' });
    } catch {}
  } else {
    const s = live.get(id);
    if (s) for (const h of s) h.kill();
  }
}
