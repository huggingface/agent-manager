# Terminal keyboard shortcuts

Terminal panes forward the core Claude Code and Codex shortcuts to the PTY. The
rules live in `web/src/lib/terminalKeys.ts` and are applied from the key handler
in `TerminalPane.tsx`.

## Forwarded

| Keys | Sent | Notes |
|---|---|---|
| Shift+Enter, Ctrl+Enter | `ESC CR` | Newline in the prompt instead of submit. Plain Enter is unchanged. |
| Option+Enter (macOS) | `ESC CR` | Same newline. |
| Option+B / F / P / T / Y / D (macOS) | `ESC b/f/p/t/y/d` | Word back/forward, model switch, thinking toggle, kill-ring cycle, delete word forward. |
| Option+Backspace (macOS) | `ESC DEL` | Delete word back. |
| Option+Left / Right (macOS) | `ESC b` / `ESC f` | Word back/forward. |
| Option+Forward Delete (macOS) | `ESC d` | Delete word forward. |
| Cmd+Left / Right (macOS) | `Ctrl+A` / `Ctrl+E` | Start / end of line. |
| Cmd+Backspace (macOS) | `Ctrl+U` | Delete to start of line. |
| Cmd+K (macOS) | nothing | Clears the pane's local scrollback, like iTerm2's Clear Buffer. The server keeps its copy, so a reload or reconnect brings it back. |
| Ctrl+R, L, K, U, Y, D, J, T, P, W, N | the control byte | The browser's own action is cancelled so the key reaches the TUI. |
| Shift+Tab, Esc | usual sequences | The browser's own action is cancelled. |

On Windows and Linux, Alt+key already arrives as Meta, so nothing extra is needed.

## Cmd keys on macOS follow iTerm2

A terminal has no encoding for Cmd, so Cmd+Left and friends only work in a
native terminal because the terminal app translates them into readline bytes.
xterm.js does not, so the Cmd and Option editing keys above are copied from
iTerm2's "Natural Text Editing" key preset (`plists/PresetKeyMappings.plist` in
the iTerm2 source), and Cmd+K from its Clear Buffer menu item. One preset entry
is left out: it maps plain Forward Delete to `Ctrl+D`, which would end a Claude
Code or Codex session at an empty prompt, so Forward Delete keeps sending
`ESC [3~`.

## Option on macOS is not Meta everywhere

Setting xterm's `macOptionIsMeta` would turn every Option chord into Meta and
break layouts that type `@ [ ] { } | ~` with Option (German, French, ...). So
only the combos above are mapped, by physical key (`event.code`); all other
Option input still types its character. On a layout where those letters sit on
different physical keys (QWERTZ puts Y where Z is) the shortcut follows the
physical key, not the printed letter.

## Left to the browser

- Every other Cmd combo on macOS (Cmd+R, T, W, L, ...), and Ctrl+Shift combos
  such as Ctrl+Shift+T/N.
- Copy and paste: Cmd/Ctrl+C with a selection copies (without one, Ctrl+C is
  SIGINT), Cmd+V and Ctrl+Shift+V paste.
- IME composition is never rewritten.

## Cannot be captured

Chrome and Edge on Windows/Linux reserve Ctrl+W, Ctrl+T and Ctrl+N (and
Ctrl+Shift+W/T/N); a page never sees them, and nothing here can change that.

Workarounds:
- Install the Space as an app (Chrome: "Install" / "Create shortcut" with "Open
  as window"). In an app window Chrome lets pages receive Ctrl+W/T/N, and they
  are forwarded as above.
- Use alternates: Alt+Backspace (Option+Backspace on macOS) instead of Ctrl+W to
  delete the previous word, and the Down arrow instead of Ctrl+N for history.
  Ctrl+T has no alternate binding in a plain browser tab.
- On a phone, the on-screen key bar sends Esc, Tab, arrows, Enter and Ctrl+C.

Esc Esc works because each Esc is forwarded; browsers do not reserve it, except
that Esc leaves browser fullscreen first.
