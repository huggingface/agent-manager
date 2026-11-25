import fs from 'node:fs';
import path from 'node:path';

const fileFor = (directory, id) => path.join(
  directory, `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
);

export const TERMINAL_HISTORY_VERSION = 8;

const validAnsi = (ansi, text) => typeof ansi === 'string'
  && ansi.replace(/\x1b\[[0-9;]*m/g, '') === text;

/** Load a plain-text Ghostty scrollback checkpoint, ignoring old/bad schemas. */
export function loadTerminalHistory(directory, id) {
  try {
    const body = fs.readFileSync(fileFor(directory, id), 'utf8');
    const saved = JSON.parse(body);
    if (![1, 2, 3, 4, 5, 6, 7, TERMINAL_HISTORY_VERSION].includes(saved?.version)
        || !Number.isFinite(saved.cols) || !Array.isArray(saved.lines)) return null;
    const lines = saved.lines.flatMap((line) => {
      if (typeof line === 'string') return [{ text: line }];
      if (!line || typeof line.text !== 'string') return [];
      return [validAnsi(line.ansi, line.text)
        ? { text: line.text, ansi: line.ansi } : { text: line.text }];
    });
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
  let writing = null;
  let seq = 0;
  let lastBody = persistedBody;

  const writePending = () => {
    if (writing || !pending) return;
    const next = pending;
    pending = null;
    if (next === lastBody) return;
    const target = fileFor(directory, id);
    // Leading dot keeps `target` (`<id>.json`) from being a strict prefix of
    // the temp name — on hf-mount (#207), writing `foo.tmp` while `foo` is
    // uncached makes `stat("foo")` report a phantom directory until rename.
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${++seq}.tmp`);
    writing = fs.promises.mkdir(directory, { recursive: true })
      .then(() => fs.promises.writeFile(temporary, next))
      .then(() => fs.promises.rename(temporary, target))
      .then(() => { lastBody = next; })
      .catch((error) => {
        console.error('[runner] history checkpoint', error && error.message);
        return fs.promises.unlink(temporary).catch(() => {});
      })
      .finally(() => {
        writing = null;
        if (pending) writePending();
      });
  };

  const waitIdle = () => (writing ? writing.then(waitIdle) : Promise.resolve());

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    if (timer.unref) timer.unref();
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (blocked()) { schedule(); return waitIdle(); }
    let snap;
    try { snap = snapshot(); } catch { return waitIdle(); }
    const lines = (snap.scrollbackLines || []).map((line) => {
      const text = line.text || '';
      return validAnsi(line.ansi, text) ? { text, ansi: line.ansi } : text;
    });
    pending = JSON.stringify({ version: TERMINAL_HISTORY_VERSION, cols: snap.cols, lines });
    writePending();
    return waitIdle();
  };

  return { schedule, flush, settled: waitIdle };
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
