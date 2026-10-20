import type { Terminal } from '@xterm/xterm';

export interface TerminalScrollAnchor {
  bottom: boolean;
  row: number;
  samples: { offset: number; text: string }[];
}

// A canonical repaint replaces xterm's entire buffer. Its old scrollTop and
// markers are no longer meaningful; retain visible content and reading intent.
export function captureTerminalAnchor(term: Terminal): TerminalScrollAnchor {
  const buffer = term.buffer.active;
  const samples = [0, 1, 2].map(offset => ({ offset,
    text: buffer.getLine(buffer.viewportY + offset)?.translateToString(true) || '' }));
  return { bottom: buffer.viewportY >= buffer.baseY, row: buffer.viewportY, samples: samples.filter(s => s.text.trim()) };
}

export function restoreTerminalAnchor(term: Terminal, anchor: TerminalScrollAnchor) {
  if (anchor.bottom) { term.scrollToBottom(); return; }
  const buffer = term.buffer.active;
  let row = Math.min(anchor.row, buffer.baseY), best = 0, distance = Infinity;
  for (let y = 0; y <= buffer.baseY && anchor.samples.length; y++) {
    const score = anchor.samples.reduce((n, s) => n + Number(
      buffer.getLine(y + s.offset)?.translateToString(true) === s.text), 0);
    const d = Math.abs(y - anchor.row);
    if (score > best || (score && score === best && d < distance)) {
      row = y; best = score; distance = d;
    }
  }
  term.scrollToLine(row);
}
