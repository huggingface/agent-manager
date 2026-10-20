// How every session pane is being read: the terminal itself, or reader mode.
// (docs/conversation-view.md §3.3)
//
// One setting for the whole app, like zoom — not per session. Reading a fleet
// means reading it the same way; flipping panes one at a time was a preference
// nobody wanted to manage. Kept in localStorage so a reload does not undo it,
// and announced so an already-mounted pane hears about it.
export type PaneMode = 'terminal' | 'reader';

const KEY = 'am-pane-mode';
const EVENT = 'am:pane-mode';

export function readPaneMode(): PaneMode {
  try { return localStorage.getItem(KEY) === 'reader' ? 'reader' : 'terminal'; } catch { return 'terminal'; }
}

export function writePaneMode(mode: PaneMode): void {
  try { localStorage.setItem(KEY, mode); } catch { /* private mode: this session only */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

/** Someone else changed it — the Overview card asking for the full history. */
export function onPaneMode(apply: (m: PaneMode) => void): () => void {
  const h = (e: Event) => apply((e as CustomEvent<PaneMode>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
