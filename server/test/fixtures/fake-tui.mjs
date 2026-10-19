// A stand-in for an agent TUI, run in a real PTY by live-latency.test.mjs as
// `claude --session-id <uuid>`. It draws what the state detector keys on and
// writes a Claude-format transcript where the server looks for one:
//
//   work <s>   spinner + "esc to interrupt" every 100 ms for <s> seconds; a
//              user record at once, an assistant record halfway, a final one
//              at the end, then a static prompt
//   pause <s>  the same, but the spinner stops redrawing for 1.2 s halfway
//              (a model that is slow to answer): still one turn, never idle
//
// Every moment the test measures from is appended to .fake-events.jsonl in the
// working directory, stamped with this process's clock (the same machine's).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.0.0 (Claude Code)'); process.exit(0); }
const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const id = at('--session-id') || at('--resume') || crypto.randomUUID();
const config = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const dir = path.join(config, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const trace = path.join(dir, `${id}.jsonl`);
const events = path.join(process.cwd(), '.fake-events.jsonl');

const mark = (ev, extra = {}) => fs.appendFileSync(events, `${JSON.stringify({ ev, t: Date.now(), ...extra })}\n`);
const record = (o) => fs.appendFileSync(trace, `${JSON.stringify({
  cwd: process.cwd(), sessionId: id, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), ...o })}\n`);
const say = (text) => {
  const mid = `m${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  record({ type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'text', text: `${text} ${mid}` }] } });
  return mid;
};
const out = (s) => process.stdout.write(s);
const prompt = () => out('\r\n\x1b[2K> ');
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

out('\x1b[2J\x1b[H fake agent\r\n');
prompt();
process.stdin.setRawMode?.(true);

let busy = false;
function turn(seconds, text, pause) {
  busy = true;
  mark('work-start');
  record({ type: 'user', message: { role: 'user', content: text } });
  out('\r\n');
  const t0 = Date.now();
  let frame = 0; let half = false; let paused = 0;
  const tick = () => {
    const elapsed = (Date.now() - t0) / 1000;
    if (!half && elapsed >= seconds / 2) {
      half = true;
      const m = say('halfway');
      out(`\r\x1b[2K● halfway ${m}\r\n`);
      mark('mid-text', { m });
      if (pause) {
        // The spinner line stays on screen, marker and all, but nothing moves.
        out(`\r\x1b[2K${SPIN[frame % SPIN.length]} Working… (esc to interrupt)`);
        mark('pause-start');
        paused = 1200;
        return setTimeout(() => { mark('pause-end'); tick(); }, paused);
      }
    }
    if (elapsed >= seconds + paused / 1000) {
      const m = say('done');
      out(`\r\x1b[2K● done ${m}\r\n`);
      prompt();
      busy = false;
      mark('work-end', { m });
      return undefined;
    }
    out(`\r\x1b[2K${SPIN[frame++ % SPIN.length]} Working… (${Math.floor(elapsed)}s · esc to interrupt)`);
    return setTimeout(tick, 100);
  };
  tick();
}

let line = '';
process.stdin.on('data', (d) => {
  for (const ch of d.toString()) {
    if (ch === '\r' || ch === '\n') {
      const m = /(work|pause)\s+([\d.]+)/.exec(line);
      const text = line; line = '';
      if (m && !busy) turn(Number(m[2]), text, m[1] === 'pause');
      else if (!busy) prompt();
    } else if (ch === '\x03') process.exit(0);
    else if (ch === '\x7f') { line = line.slice(0, -1); out('\b \b'); }
    else { line += ch; out(ch); }
  }
});
