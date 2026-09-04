import type { Terminal, ILink, ILinkHandler } from '@xterm/xterm';
import { activateFileLink, fileRequest, looksLikeFile } from './fileLinks';

export function terminalLinkHandler(session: string): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate: (event, text) => openTerminalLink(event, text, session),
  };
}

export function openTerminalLink(event: MouseEvent, text: string, session: string) {
  if (event.defaultPrevented) return;
  const request = fileRequest(text, { session });
  if (request) return activateFileLink(event, request);
  // OSC 8 can contain arbitrary protocols; only web links open externally.
  if (!/^https?:\/\//i.test(text)) return;
  const anchor = document.createElement('a');
  anchor.href = text; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}

export function installTerminalFileLinks(term: Terminal, session: string) {
  return term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buffer = term.buffer.active;
      let first = lineNumber - 1, last = first;
      // Join soft wraps, with a bound so a giant output line stays cheap to hover.
      while (first > 0 && last - first < 8 && buffer.getLine(first)?.isWrapped) first--;
      while (last - first < 8 && buffer.getLine(last + 1)?.isWrapped) last++;
      let text = '';
      const positions: { x: number; y: number }[] = [];
      for (let y = first; y <= last; y++) {
        const row = buffer.getLine(y);
        if (!row) break;
        for (let x = 0; x < row.length; x++) {
          const cell = row.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let i = 0; i < chars.length; i++) positions.push({ x: x + 1, y: y + 1 });
          text += chars;
        }
      }
      const links: ILink[] = [];
      for (const match of text.matchAll(/[^\s<>"'`()\[\]{}]+/g)) {
        const value = match[0].replace(/[.,;:]+$/, '');
        if (!looksLikeFile(value)) continue;
        const request = fileRequest(value, { session }, false);
        const start = positions[match.index!], end = positions[match.index! + value.length - 1];
        if (!request || !start || !end || lineNumber < start.y || lineNumber > end.y) continue;
        links.push({ text: value, range: { start, end }, activate: (event) => activateFileLink(event, request) });
      }
      callback(links);
    },
  });
}
