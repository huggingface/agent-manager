// libghostty's structured snapshot exposes the screen and cursor, but not the
// input modes a TUI enabled before a browser attached. Keep the small subset of
// terminal state that changes how xterm turns browser interaction into PTY
// bytes, so a canonical repaint can restore behavior as well as pixels.

const MOUSE_PROTOCOL_MODES = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODING_MODES = new Set([1005, 1006, 1015, 1016]);

export function createTerminalModeTracker() {
  let applicationCursorKeys = false;
  let mouseProtocol = 0;
  let mouseEncoding = 0;
  let sendFocus = false;
  let bracketedPaste = false;

  // 0 ground, 1 ESC, 2 CSI, 3 CSI ? parameters. State is retained across PTY
  // chunks because escape sequences are not guaranteed to arrive atomically.
  let parserState = 0;
  let parameters = '';

  const reset = () => {
    applicationCursorKeys = false;
    mouseProtocol = 0;
    mouseEncoding = 0;
    sendFocus = false;
    bracketedPaste = false;
  };

  const applyPrivateMode = (mode, enabled) => {
    if (mode === 1) applicationCursorKeys = enabled;
    else if (MOUSE_PROTOCOL_MODES.has(mode)) mouseProtocol = enabled ? mode : 0;
    else if (MOUSE_ENCODING_MODES.has(mode)) mouseEncoding = enabled ? mode : 0;
    else if (mode === 1004) sendFocus = enabled;
    else if (mode === 2004) bracketedPaste = enabled;
  };

  const finishPrivateMode = (enabled) => {
    for (const value of parameters.split(';')) {
      if (!/^\d+$/.test(value)) continue;
      applyPrivateMode(Number(value), enabled);
    }
    parameters = '';
  };

  const feed = (data) => {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
    for (const char of text) {
      if (parserState === 0) {
        if (char === '\x1b') parserState = 1;
        else if (char === '\x9b') parserState = 2;
        continue;
      }

      if (parserState === 1) {
        if (char === '[') parserState = 2;
        else if (char === 'c') { reset(); parserState = 0; }
        else parserState = char === '\x1b' ? 1 : 0;
        continue;
      }

      if (parserState === 2) {
        if (char === '?') { parameters = ''; parserState = 3; }
        else parserState = char === '\x1b' ? 1 : 0;
        continue;
      }

      if ((char >= '0' && char <= '9') || char === ';') {
        // A real mode list is tiny. Bound malformed output so it cannot grow a
        // retained parser string without limit.
        if (parameters.length < 128) parameters += char;
        else { parameters = ''; parserState = 0; }
      } else if (char === 'h' || char === 'l') {
        finishPrivateMode(char === 'h');
        parserState = 0;
      } else {
        parameters = '';
        parserState = char === '\x1b' ? 1 : 0;
      }
    }
  };

  const restoreAnsi = () => {
    let out = '';
    if (applicationCursorKeys) out += '\x1b[?1h';
    if (mouseProtocol) out += `\x1b[?${mouseProtocol}h`;
    if (mouseEncoding) out += `\x1b[?${mouseEncoding}h`;
    if (sendFocus) out += '\x1b[?1004h';
    if (bracketedPaste) out += '\x1b[?2004h';
    return out;
  };

  return { feed, reset, restoreAnsi };
}
