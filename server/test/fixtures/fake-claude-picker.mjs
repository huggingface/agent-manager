#!/usr/bin/env node
// A stand-in for Claude Code's first screens and `/model` picker, drawn the way
// 2.1.312 draws them: folder-trust dialog, idle prompt, then a scrolling list
// of 14 models showing 10 at a time. Every key received is appended to
// $FAKE_PICKER_LOG so a test can assert which keys the probe sent (above all:
// never Enter or `s` while the picker is open).
//   FAKE_PICKER_TRUST=1  start on the trust dialog
//   FAKE_PICKER_LOGIN=1  start on a sign-in screen and never leave it
import fs from 'node:fs';

const log = (what) => { if (process.env.FAKE_PICKER_LOG) fs.appendFileSync(process.env.FAKE_PICKER_LOG, `${what}\n`); };
const MODELS = ['Default (recommended) ✔ Opus 5.5 · Most capable for complex work', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5.5',
  'Haiku 5.5', 'Opus 5', 'Sonnet 5', 'Opus 4.8', 'Opus 4.7', 'Sonnet 4.6', 'Haiku 4.5', 'Opus 4.1', 'Sonnet 4.5', 'Mythos 5.1'];
const WINDOW = 10;
let state = process.env.FAKE_PICKER_LOGIN ? 'login' : process.env.FAKE_PICKER_TRUST ? 'trust' : 'prompt';
let trustCursor = 0, input = '', cursor = 0, top = 0;
const draw = () => {
  let out = '\x1b[2J\x1b[H';
  if (state === 'login') out += ' Select login method:\r\n ❯ 1. Claude account with subscription\r\n   2. Anthropic Console account\r\n';
  else if (state === 'trust') {
    out += ' Do you trust the files in this folder?\r\n\r\n';
    ['No, exit', 'Yes, I trust this folder'].forEach((o, i) => { out += ` ${i === trustCursor ? '❯' : ' '} ${i + 1}. ${o}\r\n`; });
  } else if (state === 'picker') {
    out += ' Select model\r\n Your pick becomes the default for new sessions.\r\n\r\n';
    for (let i = top; i < Math.min(top + WINDOW, MODELS.length); i++) out += ` ${i === cursor ? '❯' : ' '} ${i + 1}. ${MODELS[i]}\r\n`;
    if (top + WINDOW < MODELS.length) out += `   ↓ … +${MODELS.length - top - WINDOW} models\r\n`;
    out += '\r\n Effort ◐ medium  ←/→ to adjust · Enter to confirm · Esc to exit\r\n';
  } else {
    out += ' ╭──────────────────────────────╮\r\n';
    out += ` │ > ${input.padEnd(27)}│\r\n`;
    out += ' ╰──────────────────────────────╯\r\n   ? for shortcuts\r\n';
  }
  process.stdout.write(out);
};
process.stdin.setRawMode?.(true);
process.stdin.on('data', (buf) => {
  const k = buf.toString();
  log(state === 'picker' ? `picker:${JSON.stringify(k)}` : `${state}:${JSON.stringify(k)}`);
  if (state === 'trust') {
    if (k === '\x1b[B') trustCursor = 1;
    else if (k === '\r') { if (trustCursor === 0) process.exit(1); state = 'prompt'; }
  } else if (state === 'prompt') {
    if (k === '\r') { if (input === '/model') { state = 'picker'; input = ''; } }
    else if (k === '\x1b') input = '';
    else if (!k.startsWith('\x1b')) input += k;
  } else if (state === 'picker') {
    if (k === '\x1b[B') { cursor = Math.min(cursor + 1, MODELS.length - 1); if (cursor >= top + WINDOW) top = cursor - WINDOW + 1; }
    else if (k === '\x1b') state = 'prompt';
    else if (k === '\r' || k === 's') { log('PICKED'); state = 'prompt'; }
  }
  draw();
});
draw();
