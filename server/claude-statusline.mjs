// Claude Code statusline hook. Claude pipes a JSON blob on stdin that includes
// the official `rate_limits` object (Pro/Max, after the first API response).
// We persist it for the Usage page and print a compact status line.
import fs from 'node:fs';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(input); } catch {}
  const rl = j.rate_limits;
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (rl && cfg) {
    try {
      fs.writeFileSync(path.join(cfg, 'usage.json'), JSON.stringify({ rate_limits: rl, cost: j.cost || null, ts: Date.now() }));
    } catch {}
  }
  const model = (j.model && (j.model.display_name || j.model.id)) || '';
  const h = rl && rl.five_hour && rl.five_hour.used_percentage;
  const w = rl && rl.seven_day && rl.seven_day.used_percentage;
  const bits = [model];
  if (typeof h === 'number') bits.push(`5h ${Math.round(h)}%`);
  if (typeof w === 'number') bits.push(`wk ${Math.round(w)}%`);
  process.stdout.write(bits.filter(Boolean).join(' · '));
});
