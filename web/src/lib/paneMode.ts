// Which way a session's pane is being read: the terminal, or the conversation.
// (docs/conversation-view.md §3.3)
//
// A view preference, per session, kept in localStorage rather than the store —
// it says nothing about the session itself, and it should survive a reload
// without a round trip. The event exists because a pane that is ALREADY open
// cannot see a write from somewhere else: the Overview card's "full history ↗"
// sets the mode and then asks App to focus that pane.
export type PaneMode = 'tui' | 'render';

const KEY = 'am:pane-mode:';
const EVENT = 'am:pane-mode';

export function readPaneMode(id: string): PaneMode {
  try { return localStorage.getItem(KEY + id) === 'render' ? 'render' : 'tui'; } catch { return 'tui'; }
}

export function writePaneMode(id: string, mode: PaneMode): void {
  try { localStorage.setItem(KEY + id, mode); } catch { /* private mode: this session only */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id, mode } }));
}

/** Called when someone else sets the mode for this session. */
export function onPaneMode(id: string, apply: (m: PaneMode) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<{ id: string; mode: PaneMode }>).detail;
    if (d && d.id === id) apply(d.mode);
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
