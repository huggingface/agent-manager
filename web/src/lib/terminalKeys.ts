// What a terminal pane does with a keydown before xterm sees it. Pure, so the
// rules can be tested without a browser.

export interface TerminalKeyEvent {
  type?: string;
  key: string;
  code: string;
  keyCode?: number;
  isComposing?: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface TerminalKeyAction {
  // Bytes to write to the PTY ourselves; xterm must not also handle the key.
  send?: string;
  // Stop the browser acting on the key (focus change, find, history, ...).
  preventDefault: boolean;
  // Let xterm encode and send the key as usual.
  passToXterm: boolean;
  // Clear the local scrollback (Cmd+K, iTerm2's Clear Buffer).
  clear?: boolean;
}

export const isMacPlatform = (nav: { platform?: string; userAgent?: string } = navigator) =>
  /Mac|iPhone|iPad/i.test(nav.platform || nav.userAgent || '');

// Option+<key> combos the agent CLIs use as Meta shortcuts (word back/forward,
// model switch, thinking toggle, kill-ring cycle, delete word, newline), plus
// iTerm2's "Natural Text Editing" Option+arrows and Option+Forward Delete.
// Keyed by the physical key (`code`), not `key`: with Option held macOS reports
// the composed character (⌥B is "∫"), so `key` no longer says which key it was.
const OPTION_AS_META: Record<string, string> = {
  KeyB: '\x1bb', KeyF: '\x1bf', KeyP: '\x1bp', KeyT: '\x1bt', KeyY: '\x1by', KeyD: '\x1bd',
  Backspace: '\x1b\x7f', Enter: '\x1b\r',
  ArrowLeft: '\x1bb', ArrowRight: '\x1bf', Delete: '\x1bd',
};

// Cmd+<key> on macOS, from iTerm2's "Natural Text Editing" preset: line start,
// line end, delete to line start. A terminal has no encoding for Cmd, so native
// terminals translate these to readline control bytes; xterm.js drops them.
const CMD_KEYS: Record<string, string> = {
  ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15',
};

// Ctrl+<letter> combos the TUIs bind and a browser may claim (reload/history,
// address bar, downloads, ...). W and N only help where a page may capture
// them: an installed PWA or app window.
const CTRL_KEYS = new Set(['r', 'l', 'k', 'u', 'y', 'd', 'j', 't', 'p', 'w', 'n']);

const PASS: TerminalKeyAction = { preventDefault: false, passToXterm: true };

export function terminalKeyAction(e: TerminalKeyEvent, mac: boolean): TerminalKeyAction {
  if (e.type && e.type !== 'keydown') return PASS;
  // Composition owns the key (Enter commits a candidate; keyCode 229 is the
  // browser's "IME is handling this"). Never rewrite it.
  if (e.isComposing || e.keyCode === 229) return PASS;
  if (mac && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
    const send = CMD_KEYS[e.key];
    if (send) return { send, preventDefault: true, passToXterm: false };
    if (e.key.toLowerCase() === 'k') return { clear: true, preventDefault: true, passToXterm: false };
  }
  // Any other Cmd (and the Windows key elsewhere) belongs to the browser or OS:
  // Cmd+R, Cmd+T, Cmd+W, Cmd+L, Cmd+V all stay as they are.
  if (e.metaKey) return PASS;

  // Shift/Ctrl+Enter inserts a newline. A bare \r would submit, and a terminal
  // gives xterm no way to tell Shift+Enter apart, so use Meta+Enter, which
  // Claude Code and Codex both read as "newline".
  if (e.code === 'Enter' || e.key === 'Enter') {
    if ((e.shiftKey || e.ctrlKey) && !e.altKey) return { send: '\x1b\r', preventDefault: true, passToXterm: false };
    if (mac && e.altKey && !e.ctrlKey && !e.shiftKey) return { send: '\x1b\r', preventDefault: true, passToXterm: false };
    return PASS;
  }

  // Option as Meta only for the combos above. macOptionIsMeta would turn every
  // Option chord into Meta and break the characters non-US layouts type with
  // Option (@ [ ] { } | ~ on German, French, ...), so everything else keeps
  // reaching xterm as the composed character. Off macOS xterm already sends
  // ESC for Alt.
  if (mac && e.altKey && !e.ctrlKey && !e.shiftKey) {
    const send = OPTION_AS_META[e.code];
    if (send) return { send, preventDefault: true, passToXterm: false };
    return PASS;
  }

  // preventDefault but still pass: xterm writes the control byte, and the
  // browser must not also act on the key. Shift is excluded so Ctrl+Shift+V
  // (paste) and Ctrl+Shift+T/N (reopen tab, incognito) stay the browser's.
  if (e.ctrlKey && !e.altKey && !e.shiftKey && CTRL_KEYS.has(e.key.toLowerCase())) {
    return { preventDefault: true, passToXterm: true };
  }
  if (!e.ctrlKey && !e.altKey && (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey))) {
    return { preventDefault: true, passToXterm: true };
  }
  return PASS;
}
