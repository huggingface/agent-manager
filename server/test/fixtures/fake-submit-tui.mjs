#!/usr/bin/env node
// A composer that behaves like the Codex TUI where it matters for delivery
// (server/test/submit-confirm.test.mjs): a bracketed paste collapses to
// `› [Pasted Content N chars]`, Enter submits it, echoes it into the
// conversation above and draws a fresh composer. Faults are configurable per
// paste, read from $FAKE_DIR/mode as JSON:
//   swallow  — this many Enters after the paste do nothing;
//   paintMs  — the placeholder is drawn this late, and an Enter before it is
//              drawn is lost (a paste still being collapsed);
//   startMs  — "Waiting for startup" is shown this long after the paste, and
//              an Enter meanwhile does nothing (Codex before it is ready);
//   dialog   — the first Enter does not submit but draws a menu over the
//              composer; further Enters are recorded and ignored.
// Every Enter received is appended to $FAKE_DIR/enters, every submit to
// $FAKE_DIR/submitted.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_DIR;
const log = (file, line) => fs.appendFileSync(path.join(dir, file), `${line}\n`);
const mode = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'mode'), 'utf8')); } catch { return {}; } };
let line = '';           // what is on the composer
let shown = true;        // whether it has been painted yet
let swallow = 0;
let startingUntil = 0;
let dialog = false, inDialog = false;
let inPaste = false, pasted = '';
const draw = () => process.stdout.write(`\r\x1b[2K› ${shown ? line : ''}${Date.now() < startingUntil ? '   Waiting for startup  · esc cancel' : ''}`);
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
      dialog = !!m.dialog;
      if (m.startMs) { startingUntil = Date.now() + m.startMs; setTimeout(draw, m.startMs + 10); }
      line = `[Pasted Content ${pasted.length} chars]`;
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
      if (!shown || swallow > 0) { if (shown) swallow--; continue; }
      if (dialog) { inDialog = true; process.stdout.write('\r\x1b[2K  Choose a directory\r\n› 1. Use session directory\r\n  2. Use current directory'); continue; }
      log('submitted', line);
      process.stdout.write(`\r\x1b[2K› ${pasted.replace(/\n/g, '\r\n  ')}\r\n• Worked for 0s\r\n`);
      line = ''; draw();
    } else if (ch === '\x15') { line = ''; draw(); }
    else if (ch >= ' ') { line += ch; draw(); }
  }
});
