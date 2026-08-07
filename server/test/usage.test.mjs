import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-usage-'));
const ARGS = path.join(TMP, 'args.txt');
const BIN = path.join(TMP, 'ccusage');
const today = new Date().toISOString().slice(0, 10);
const payload = JSON.stringify({
  daily: [{ date: today, totalTokens: 12345, totalCost: 0.4567 }],
  totals: { totalTokens: 12345, totalCost: 0.4567 },
});
fs.writeFileSync(BIN, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(ARGS)}\nprintf '%s' '${payload}'\n`);
fs.chmodSync(BIN, 0o755);
process.env.PATH = TMP;

const { buildUsage } = await import('../src/usage.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

try {
  const out = await buildUsage(false, 'opencode');
  const got = out.providers.opencode;
  const args = fs.readFileSync(ARGS, 'utf8').trim().split('\n');

  check('OpenCode is a selectable usage provider', Object.keys(out.providers).join(',') === 'opencode');
  check('ccusage receives the OpenCode provider command', args[0] === 'opencode' && args[1] === 'daily', args.slice(0, 2).join(' '));
  check('the bounded/offline scan flags are retained', args.includes('--offline') && args.includes('--single-thread') && args.includes('--since'));
  check('today tokens are exposed', got.tokensToday === 12345, String(got.tokensToday));
  check('weekly tokens are exposed', got.tokensWeek === 12345, String(got.tokensWeek));
  check('today cost is exposed', got.costToday === 0.4567, String(got.costToday));
  check('weekly cost is exposed', got.costWeek === 0.4567, String(got.costWeek));
  check('aggregate cost is exposed', got.totalCost === 0.4567, String(got.totalCost));
  check('OpenCode does not invent a subscription quota', got.quota === null);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
