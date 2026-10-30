#!/usr/bin/env node
// A composer that behaves like the Codex TUI where it matters for delivery
// (server/test/submit-confirm.test.mjs), as seen on codex-cli 0.162.1:
//   - a bracketed paste over 1000 chars collapses to `› [Pasted Content N
//     chars]`; a shorter one is shown as its text, over as many rows as it
//     takes, a blank row for each blank line, the cursor at its end;
//   - an Enter right after a long run of TYPED characters (over 1000, no
//     bracketed paste) is taken as a newline, not a submit;
//   - otherwise Enter submits, echoes the prompt into the conversation above
//     and draws a fresh composer.
// Faults are configurable per paste, read from $FAKE_DIR/mode as JSON:
//   swallow  — this many Enters after the paste do nothing;
//   paintMs  — the placeholder is drawn this late, and an Enter before it is
//              drawn is lost (a paste still being collapsed);
//   startMs  — "Waiting for startup" is shown this long after the paste, and
//              an Enter meanwhile does nothing (Codex before it is ready);
//   dialog   — the first Enter does not submit but draws a menu over the
//              composer; further Enters are recorded and ignored. "plain"
//              draws it with no `›` on any row, so the nearest marker above
//              the cursor is the last prompt echoed in the conversation.
//              "select" draws an unnumbered choice whose selected label is
//              the prompt itself — `› Continue` over `  Quit` — with the
//              cursor after it, just like a composer holding the prompt.
//              "steps" shows `Step 1 of 2` above the composer; the Enter
//              turns it into `Step 2 of 2` — a confirmation over the same
//              rows, the prompt still selected — and nothing else moves.
//   stepTail — text after the step counter, e.g. " (esc to interrupt)".
// Every Enter received is appended to $FAKE_DIR/enters, every submit to
// $FAKE_DIR/submitted (and, with the pane's AM_ID, to $FAKE_DIR/submitted-by).
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_DIR;
const log = (file, line) => fs.appendFileSync(path.join(dir, file), `${line}\n`);
const mode = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'mode'), 'utf8')); } catch { return {}; } };
let line = '';           // what is on the composer
let shown = true;        // whether it has been painted yet
let swallow = 0;
let startingUntil = 0;
let dialog = false, inDialog = false, stepTail = '';
let inPaste = false, pasted = '';
let typedRun = 0, lastTypedAt = 0;   // the current burst of typed characters
// The composer is redrawn whole, however many rows it wraps onto at this
// width: up to its first row, clear to the end of the screen, draw.
let drawnRows = 1;
const draw = () => {
  const content = `› ${shown ? line : ''}${Date.now() < startingUntil ? '   Waiting for startup  · esc cancel' : ''}`;
  const cols = process.stdout.columns || 80;
  const rows = content.split('\n').map((l, i) => (i ? `  ${l}` : l));
  if (dialog === 'steps') rows.unshift(`Step ${inDialog ? 2 : 1} of 2${stepTail}`);
  process.stdout.write(`\r${drawnRows > 1 ? `\x1b[${drawnRows - 1}A` : ''}\x1b[J${rows.join('\r\n')}`);
  drawnRows = rows.reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / cols)), 0);
};
process.stdin.setRawMode?.(true);
process.stdout.write('fake codex\r\n');
draw();
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  while (buf) {
    if (inPaste) {
      const end = buf.indexOf('\x1b[201~');
      if (end < 0) { pasted += buf; buf = ''; break; }
      pasted += buf.slice(0, end); buf = buf.slice(end + 6); inPaste = false;
      const m = mode();
      swallow = m.swallow || 0;
      dialog = m.dialog || false; stepTail = m.stepTail || '';
      if (m.startMs) { startingUntil = Date.now() + m.startMs; setTimeout(draw, m.startMs + 10); }
      line = pasted.length > 1000 ? `[Pasted Content ${pasted.length} chars]` : pasted;
      typedRun = 0;
      if (m.paintMs) { shown = false; setTimeout(() => { shown = true; draw(); }, m.paintMs); } else draw();
      continue;
    }
    if (buf.startsWith('\x1b[200~')) { inPaste = true; pasted = ''; buf = buf.slice(6); continue; }
    const ch = buf[0]; buf = buf.slice(1);
    if (ch === '\r') {
      log('enters', inDialog ? 'into-dialog' : line ? 'with-text' : 'empty');
      if (inDialog) continue;
      if (Date.now() < startingUntil) continue;
      if (!line) continue;
      if (typedRun > 1000) { typedRun = 0; line += '\n'; draw(); continue; }
      if (!shown || swallow > 0) { if (shown) swallow--; continue; }
      if (dialog) {
        inDialog = true;
        const up = `\r${drawnRows > 1 ? `\x1b[${drawnRows - 1}A` : ''}\x1b[J`;
        if (dialog === 'steps') { draw(); continue; }
        if (dialog === 'select') { process.stdout.write(`${up}› ${line}\r\n  Quit\x1b[A\r\x1b[${2 + line.length}C`); continue; }
        const pick = dialog === 'plain' ? ' ' : '›';
        process.stdout.write(`\r${drawnRows > 1 ? `\x1b[${drawnRows - 1}A` : ''}\x1b[J  Choose a directory\r\n${pick} 1. Use session directory\r\n  2. Use current directory`);
        continue;
      }
      log('submitted', JSON.stringify(line));
      log('submitted-by', JSON.stringify({ id: process.env.AM_ID || null, text: line }));
      const said = line.startsWith('[Pasted Content') ? pasted : line;
      process.stdout.write(`\r${drawnRows > 1 ? `\x1b[${drawnRows - 1}A` : ''}\x1b[J› ${said.replace(/\n/g, '\r\n  ')}\r\n• Worked for 0s\r\n`);
      line = ''; drawnRows = 1; draw();
    } else if (ch === '\x15') { line = ''; draw(); }
    else if (ch >= ' ') {
      // A prompt typed rather than pasted takes the same per-prompt faults.
      if (!line) { const m = mode(); swallow = m.swallow || 0; dialog = m.dialog || false; stepTail = m.stepTail || ''; }
      if (Date.now() - lastTypedAt > 50) typedRun = 0;
      typedRun++; lastTypedAt = Date.now();
      line += ch; draw();
    }
  }
});
