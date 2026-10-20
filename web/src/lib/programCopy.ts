// A program in a pane can ask for text to be copied (OSC 52). Browsers refuse a
// clipboard write that no user gesture started, so the pane shows what was
// asked for and lets the operator's own Cmd+C, or a click, do the write. These
// helpers are the parts of that which do not need a terminal.

// How long a program's copy stays on offer. It is only usable while the pane
// shows it, so this is how long the notice stays up when nobody acts on it.
export const PROGRAM_COPY_MS = 60_000;

// Characters that print as nothing, or reorder what is around them: bidi
// controls, zero-width marks, the BOM, line/paragraph separators, and every
// space other than the plain one.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * One line of the copied text, with every control or invisible character
 * written out (`\n`, `\x1b`, `\u{202e}`), so what the notice shows is what
 * would be pasted. A literal backslash is doubled to keep that unambiguous.
 */
export function clipboardPreview(text: string, max = 80): string {
  let out = '';
  for (const ch of text) {
    if (out.length >= max) return `${out.slice(0, max)}…`;
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (ch !== ' ' && INVISIBLE.test(ch)) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** "12 chars", "1,204 chars · 3 lines" — counted as the user would count them. */
export function clipboardSize(text: string): string {
  const chars = [...text].length;
  const lines = text.split('\n').length;
  return `${chars.toLocaleString('en-US')} char${chars === 1 ? '' : 's'}${lines > 1 ? ` · ${lines} lines` : ''}`;
}
