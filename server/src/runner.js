import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { USE_TMUX, cliById, WORKSPACES_DIR } from './config.js';
import * as groups from './groups.js';
import { update } from './sessions.js';

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

/**
 * Detect activity by DIFFING each pane's rendered text between polls. This
 * ignores colour-only animations (e.g. Codex's shimmering banner) that fooled a
 * raw output-activity check, while still catching spinners, streaming output and
 * elapsed-time counters (their text changes). Returns Map id -> { age } where
 * age is seconds since the pane text last changed.
 */
export function agentInfo() {
  const map = new Map();
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

function commandFor(session) {
  const cli = cliById(session.cli) || cliById('shell');
  if (cli.id === 'shell') return bashLaunch;

  // Claude keys conversations by working directory, so grouped sessions sharing
  // a folder would all `--continue` onto the SAME most-recent conversation. Pin
  // each session to its own conversation id instead: create it with
  // --session-id, resume it with --resume. The `|| …` chain self-heals when
  // there's nothing to resume yet (first-run setup) or the flag is unsupported,
  // so a failed resume can never exit/restart-loop the session.
  if (cli.id === 'claude' && session.sessionUuid) {
    const fresh = `claude --session-id ${session.sessionUuid}`;
    return session.everStarted
      ? `claude --resume ${session.sessionUuid} || ${fresh} || exec claude`
      : `${fresh} || exec claude`;
  }

  // Other agents: resume when one likely exists, else a fresh launch. `exec` so
  // the agent is the pane's foreground process; when it exits the tmux session
  // ends — a clear "done" signal — and the fallback preserves that.
  if (session.everStarted && cli.cont) return `${cli.cont} || exec ${cli.run}`;
  return `exec ${cli.run}`;
}

// The folder an agent runs in: its group's shared folder if grouped, else its own.
function effectiveFolder(session) {
  const g = groups.groupOf(session.id);
  return (g ? g.folder : session.folder) || session.id;
}

/** Attach a new PTY client to the session (creating the tmux session if needed). */
export function attach(session, cols, rows) {
  const folder = effectiveFolder(session);
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
      '-e', `AM_USER=${AM_USER}`,
      'sh', '-lc', full,
    );
    term = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: workdir, env: TERM_ENV });
  } else {
    const env = { ...TERM_ENV, AM_SESSION: folder, AM_USER };
    term = pty.spawn('bash', ['-lc', full], { name: 'xterm-256color', cols, rows, cwd: workdir, env });
  }

  if (!session.everStarted) update(session.id, { everStarted: true });

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
