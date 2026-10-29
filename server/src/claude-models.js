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
import pty from 'node-pty';

const DOWN = '\x1b[B';
const ESC = '\x1b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `1. Opus 5.5 · Most capable…` rows on a screen → their display names. */
export function pickerRows(screen) {
  const rows = [];
  for (const line of String(screen).split('\n')) {
    const m = /^[\s│]*(?:[❯>›]\s*)?(\d{1,2})\.\s+(.+?)\s*[│]?\s*$/.exec(line);
    if (!m) continue;
    const name = m[2].replace(/[✔✓]/g, ' ').split(/\s+·\s+|\s{2,}/)[0].trim();
    if (name) rows.push({ n: Number(m[1]), name });
  }
  return rows;
}

/**
 * A picker name to a model id: "Opus 5.5" → claude-opus-5-5. Only ids the
 * installed binary knows are kept (`known`), and "Default (recommended)" is
 * the absence of a flag, not a model.
 */
export function idForName(name, known) {
  const m = /^([A-Za-z]+)\s+(\d+(?:\.\d+)?)\b/.exec(name);
  if (!m || /^default$/i.test(m[1])) return null;
  const id = `claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}`;
  return !known || known.has(id) ? id : null;
}

/**
 * Read the picker. Resolves [{ id, label }] in picker order. `command` is run
 * with `bash -lc exec …` like a session; tests pass a fake picker.
 */
export async function scrapeClaudePicker({ command = 'claude', cwd, env = process.env, known = null, timeoutMs = 45_000, cols = 120, rows = 40 } = {}) {
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
        if (/\? for shortcuts/.test(s)) { term.write('/model'); typedAt = Date.now(); state = 'typed'; }
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
      for (const r of found) if (!names.has(r.n)) names.set(r.n, r.name);
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
    if (!exited) {
      term.write(ESC); await sleep(200); term.write(ESC); await sleep(200);
      try { term.kill('SIGTERM'); } catch {}
      await sleep(300);
      if (!exited) try { term.kill('SIGKILL'); } catch {}
    }
    try { vt.dispose(); } catch {}
  }
  const seen = new Set();
  const out = [];
  for (const n of [...names.keys()].sort((a, b) => a - b)) {
    const label = names.get(n);
    const id = idForName(label, known);
    if (id && !seen.has(id)) { seen.add(id); out.push({ id, label }); }
  }
  return out;
}
