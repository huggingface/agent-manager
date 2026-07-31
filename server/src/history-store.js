import fs from 'node:fs';
import path from 'node:path';

const fileFor = (directory, id) => path.join(
  directory, `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
);

export const TERMINAL_HISTORY_VERSION = 4;

/** Load a plain-text Ghostty scrollback checkpoint, ignoring old/bad schemas. */
export function loadTerminalHistory(directory, id) {
  try {
    const body = fs.readFileSync(fileFor(directory, id), 'utf8');
    const saved = JSON.parse(body);
    if (![1, 2, 3, TERMINAL_HISTORY_VERSION].includes(saved?.version)
        || !Number.isFinite(saved.cols) || !Array.isArray(saved.lines)) return null;
    const lines = saved.lines.filter((line) => typeof line === 'string').map((text) => ({ text }));
    return lines.length ? {
      version: saved.version, cols: Math.max(1, Math.round(saved.cols)), lines, body,
    } : null;
  } catch { return null; }
}

/**
 * Debounced, atomic checkpoint writer for one held terminal.
 *
 * `snapshot` is deliberately injected: storage knows nothing about Ghostty or
 * session hosts. `blocked` keeps an in-flight repaint transaction from saving
 * a pre-commit grid. At most one write is active; a newer snapshot supersedes
 * any queued one.
 */
export function createTerminalHistoryCheckpoint({
  directory, id, delayMs, snapshot, blocked, persistedBody = null,
}) {
  let timer = null;
  let pending = null;
  let writing = false;
  let lastBody = persistedBody;

  const writePending = () => {
    if (writing || !pending) return;
    const next = pending;
    pending = null;
    if (next === lastBody) return;
    writing = true;
    const target = fileFor(directory, id);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.promises.mkdir(directory, { recursive: true })
      .then(() => fs.promises.writeFile(temporary, next))
      .then(() => fs.promises.rename(temporary, target))
      .then(() => { lastBody = next; })
      .catch((error) => {
        console.error('[runner] history checkpoint', error && error.message);
        fs.promises.unlink(temporary).catch(() => {});
      })
      .finally(() => {
        writing = false;
        if (pending) writePending();
      });
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    if (timer.unref) timer.unref();
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (blocked()) { schedule(); return; }
    let snap;
    try { snap = snapshot(); } catch { return; }
    const lines = (snap.scrollbackLines || []).map((line) => line.text || '');
    pending = JSON.stringify({ version: TERMINAL_HISTORY_VERSION, cols: snap.cols, lines });
    writePending();
  };

  return { schedule, flush };
}

const normalText = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Render earlier conversational turns as plain terminal history.
 *
 * The latest user turn is deliberately omitted: the resumed TUI owns that
 * viewport. Messages already visible in the live grid are omitted as well, so
 * trace recovery cannot create a second copy of content Claude did repaint.
 */
export function traceHistoryLines(page, currentText = '', maxChars = 1024 * 1024) {
  const turns = Array.isArray(page?.turns) ? page.turns : [];
  let latestUser = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'user') { latestUser = i; break; }
  }
  const current = normalText(currentText);
  const currentLines = new Set(String(currentText || '').split(/\r?\n/)
    .map(normalText).filter(Boolean));
  const lines = [];
  let chars = 0;
  for (const turn of turns.slice(0, latestUser < 0 ? turns.length : latestUser)) {
    if (turn?.role !== 'user' && turn?.role !== 'assistant') continue;
    if (turn.role === 'assistant' && turn.kind && turn.kind !== 'final') continue;
    const text = (turn.blocks || [])
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text || ''))
      .join('\n')
      .trim();
    if (!text) continue;
    const rendered = `${turn.role === 'user' ? '❯' : '●'} ${text}`;
    // Prefix matching needs a minimum length to avoid accidental prose hits,
    // but short prompts are safe to match as complete marked terminal rows.
    if (!rendered.includes('\n') && currentLines.has(normalText(rendered))) continue;
    const normalized = normalText(text);
    const probe = normalized.slice(0, 80);
    if (probe.length >= 12 && current.includes(probe)) continue;
    const next = [...rendered.split('\n'), ''];
    for (const line of next) { lines.push(line); chars += line.length + 1; }
    while (chars > maxChars && lines.length) chars -= lines.shift().length + 1;
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.map((text) => ({ text }));
}
