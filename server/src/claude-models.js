// Claude Code's model list, read from its own `/model` picker.
//
// Claude Code has no list command, and most operators sign in rather than set
// ANTHROPIC_API_KEY, so the API's model list is not an option. The picker is
// what the signed-in CLI offers, so it is read off the screen: start `claude`
// in a PTY, open `/model`, scroll the picker with Down to its last row, and
// leave with Esc, Esc. No prompt is sent, so no tokens are spent.
//
// Keys are the risk. Enter (or `s`) in the picker makes the highlighted model
// the default for EVERY session, so the only keys ever sent are:
//  - Down / Enter on the folder-trust dialog, Enter only while the cursor is on
//    "Yes, I trust this folder"
//  - `/model`, then Enter only once the input line shows exactly that
//  - Down and Esc in the picker
// Any other screen (sign-in, theme picker, an update notice) is never
// answered: the probe waits, times out, and the caller falls back.
//
// Starting Claude is a risk of its own: a plain `claude` runs the operator's
// SessionStart hooks, plugins and MCP servers before any prompt. So the probe
// starts it in safe mode (all of those off; sign-in and the model list work as
// usual), with hooks also disabled by setting and no MCP config, in case a
// future safe mode lets one through. `--bare` would do it too, but it never
// reads the OAuth sign-in, and most operators sign in.
//
// It runs in its own process group (a PTY child is a session leader), and the
// whole group is killed when the probe ends, so nothing it started survives.
import pty from 'node-pty';

const shq = (t) => `'${String(t).replace(/'/g, `'\\''`)}'`;
export const CLAUDE_PROBE_COMMAND = `claude --safe-mode --strict-mcp-config --no-chrome --settings ${shq(JSON.stringify({ disableAllHooks: true }))}`;

const DOWN = '\x1b[B';
const ESC = '\x1b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const groupAlive = (pgid) => {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
/**
 * Kill a process group (TERM, then KILL) and wait until it is gone, at most
 * `waitMs`. The group leader's pid is the group id.
 */
export async function killGroup(pgid, { graceMs = 300, waitMs = 3000 } = {}) {
  if (!pgid || !groupAlive(pgid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone */ }
  const until = Date.now() + graceMs;
  while (Date.now() < until && groupAlive(pgid)) await sleep(50);
  if (!groupAlive(pgid)) return;
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  const end = Date.now() + waitMs;
  while (Date.now() < end && groupAlive(pgid)) await sleep(50);
}

// The prompt is up: an empty `❯` input line (the footer under it changes from
// version to version, so it is not relied on).
const promptReady = (s) => /\? for shortcuts/.test(s) || s.split('\n').some((l) => /^[\s│]*[>❯]\s*[│]?\s*$/.test(l));

/**
 * `1. Opus 5.5 · Most capable…` or `2. Opus   Opus 5.5 · Best for…` rows on a
 * screen → their display name and the text after it.
 */
export function pickerRows(screen) {
  const rows = [];
  for (const line of String(screen).split('\n')) {
    const m = /^[\s│]*(?:[❯>›]\s*)?(\d{1,2})\.\s+(.+?)\s*[│]?\s*$/.exec(line);
    if (!m) continue;
    const [name, ...rest] = m[2].replace(/[✔✓]/g, ' ').split(/\s+·\s+|\s{2,}/).map((x) => x.trim());
    if (name) rows.push({ n: Number(m[1]), name, detail: rest.join(' · ') });
  }
  return rows;
}

const FAMILY_VERSION = /^([A-Za-z]+)\s+(\d+(?:\.\d+)?)\b/;

/**
 * A picker row to a model id. "Opus 5.5" → claude-opus-5-5. A bare family row
 * ("Opus", whose text says "Opus 5.5 · …") takes the version from that text.
 * Only ids the installed binary knows are kept (`known`); a bare family whose
 * version can't be pinned that way stays the alias (`opus`), which is what
 * that row means. "Default (recommended)" is the absence of a flag.
 */
export function idForName(name, known, detail = '') {
  if (/^default\b/i.test(name)) return null;
  const family = /^[A-Za-z]+$/.test(name) ? name : null;
  const m = FAMILY_VERSION.exec(name) || (family && FAMILY_VERSION.exec(detail));
  if (m && (!family || m[1].toLowerCase() === family.toLowerCase())) {
    const id = `claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}`;
    if (!known || known.has(id)) return id;
  }
  return family && CLAUDE_FAMILIES.includes(family.toLowerCase()) ? family.toLowerCase() : null;
}

/** Families `claude --model <family>` takes as an alias for its newest model. */
export const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** The label a row shows in the form: "Opus 5.5", not just "Opus". */
const labelFor = (name, detail) => {
  const m = /^[A-Za-z]+$/.test(name) && FAMILY_VERSION.exec(detail);
  return m && m[1].toLowerCase() === name.toLowerCase() ? m[0] : name;
};

/**
 * Read the picker. Resolves [{ id, label }] in picker order. `command` is run
 * with `bash -lc exec …` like a session; tests pass a fake picker.
 */
export async function scrapeClaudePicker({ command = CLAUDE_PROBE_COMMAND, cwd, env = process.env, known = null, timeoutMs = 45_000, cols = 120, rows = 40 } = {}) {
  const { createTerminal } = await import('@coder/libghostty-vt-node');
  const vt = createTerminal({ cols, rows, scrollbackLimit: 256 * 1024 });
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AM_')));
  const term = pty.spawn('bash', ['-lc', `exec ${command}`], { name: 'xterm-256color', cols, rows, cwd, env: { ...clean, TERM: 'xterm-256color' } });
  let exited = false;
  term.onData((d) => { try { vt.feed(d); } catch { /* keep reading */ } });
  term.onExit(() => { exited = true; });
  const screen = () => { try { return vt.getVisibleText(); } catch { return ''; } };
  const deadline = Date.now() + timeoutMs;
  const names = new Map();
  try {
    let state = 'boot', typedAt = 0, still = 0, trustKeys = 0, downs = 0;
    while (Date.now() < deadline && !exited) {
      await sleep(250);
      const s = screen();
      if (state === 'boot') {
        if (/trust this folder/i.test(s)) {
          const cursor = s.split('\n').find((l) => /^[\s│]*[❯>›]/.test(l)) || '';
          if (/Yes, I trust/i.test(cursor)) { term.write('\r'); trustKeys = 0; await sleep(800); }
          else if (trustKeys++ < 4) term.write(DOWN);
          continue;
        }
        if (promptReady(s)) { term.write('/model'); typedAt = Date.now(); state = 'typed'; }
        continue;
      }
      if (state === 'typed') {
        // Enter only when the input line holds exactly "/model".
        if (s.split('\n').some((l) => /^[\s│]*[>❯]\s*\/model\s*[│]?\s*$/.test(l))) { await sleep(300); term.write('\r'); state = 'picker'; }
        else if (Date.now() - typedAt > 5000) throw new Error('the /model command did not appear in the input');
        continue;
      }
      // state === 'picker': collect, scroll, until the list stops growing.
      const found = pickerRows(s);
      const before = names.size;
      for (const r of found) if (!names.has(r.n)) names.set(r.n, r);
      // The cursor walks the visible window before the list scrolls, so a
      // Down that adds no row is normal while "↓ … +N models" is still shown.
      const more = /↓|\+\d+\s+models?/.test(s);
      still = names.size === before ? still + 1 : 0;
      if (names.size && still >= 3 && !more) break;
      if (names.size && downs >= 80) break;
      if (names.size) { term.write(DOWN); downs++; }
    }
    if (!names.size) throw new Error(exited ? 'claude exited before its model picker opened' : 'the model picker did not open (not signed in, or a first-run screen)');
  } finally {
    if (!exited) { term.write(ESC); await sleep(200); term.write(ESC); await sleep(200); }
    await killGroup(term.pid);
    try { vt.dispose(); } catch {}
  }
  const seen = new Set();
  const out = [];
  for (const n of [...names.keys()].sort((a, b) => a - b)) {
    const { name, detail } = names.get(n);
    const id = idForName(name, known, detail);
    if (id && !seen.has(id)) { seen.add(id); out.push({ id, label: labelFor(name, detail) }); }
  }
  return out;
}
