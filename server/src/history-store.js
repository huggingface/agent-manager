import fs from 'node:fs';
import path from 'node:path';

const fileFor = (directory, id) => path.join(
  directory, `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
);

/** Load a plain-text Ghostty scrollback checkpoint, ignoring old/bad schemas. */
export function loadTerminalHistory(directory, id) {
  try {
    const body = fs.readFileSync(fileFor(directory, id), 'utf8');
    const saved = JSON.parse(body);
    if (saved?.version !== 1 || !Number.isFinite(saved.cols) || !Array.isArray(saved.lines)) return null;
    const lines = saved.lines.filter((line) => typeof line === 'string').map((text) => ({ text }));
    return lines.length ? { cols: Math.max(1, Math.round(saved.cols)), lines, body } : null;
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
    pending = JSON.stringify({ version: 1, cols: snap.cols, lines });
    writePending();
  };

  return { schedule, flush };
}
