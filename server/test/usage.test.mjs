import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-usage-'));
const CALLS = path.join(TMP, 'calls.txt');
const BIN = path.join(TMP, 'ccusage');
const LOCAL = path.join(TMP, 'local');
const HERMES = path.join(LOCAL, 'hermes');
const OPENCLAW = path.join(LOCAL, 'openclaw');
fs.mkdirSync(HERMES, { recursive: true });
fs.mkdirSync(OPENCLAW, { recursive: true });
fs.writeFileSync(path.join(HERMES, 'state.db'), 'fixture');

const today = new Date().toISOString().slice(0, 10);
const payload = JSON.stringify({
  daily: [{ date: today, totalTokens: 12345, totalCost: 0.4567 }],
  totals: { totalTokens: 12345, totalCost: 0.4567 },
});
fs.writeFileSync(BIN, `#!/bin/sh\nprintf '%s\\t' "$HOME" >> ${JSON.stringify(CALLS)}\nprintf '%s\\t' "$@" >> ${JSON.stringify(CALLS)}\nprintf '\\n' >> ${JSON.stringify(CALLS)}\nprintf '%s' '${payload}'\n`);
fs.chmodSync(BIN, 0o755);
process.env.PATH = TMP;
process.env.AM_LOCAL = LOCAL;
process.env.OPENCLAW_STATE_DIR = OPENCLAW;

const { buildUsage } = await import('../src/usage.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

try {
  const opencode = (await buildUsage(false, 'opencode')).providers.opencode;
  const hermes = (await buildUsage(false, 'hermes')).providers.hermes;
  const openclaw = (await buildUsage(false, 'openclaw')).providers.openclaw;
  const calls = fs.readFileSync(CALLS, 'utf8').trim().split('\n').map((line) => line.split('\t').filter(Boolean));
  const call = (provider) => calls.find((row) => row[1] === provider) || [];
  const opencodeCall = call('opencode');
  const hermesCall = call('hermes');
  const openclawCall = call('openclaw');

  check('OpenCode uses its ccusage provider command', opencodeCall[2] === 'daily');
  check('Hermes uses its ccusage provider command', hermesCall[2] === 'daily');
  check('OpenClaw uses its ccusage provider command', openclawCall[2] === 'daily');
  check('the bounded/offline scan flags are retained for every provider',
    [opencodeCall, hermesCall, openclawCall].every((args) => args.includes('--offline') && args.includes('--single-thread') && args.includes('--since')));

  check('Hermes receives a HOME shim for its local SQLite state',
    hermesCall[0] !== process.env.HOME
      && fs.realpathSync(path.join(hermesCall[0], '.hermes')) === fs.realpathSync(HERMES), hermesCall[0]);
  const clawPath = openclawCall.indexOf('--open-claw-path');
  check('OpenClaw receives its explicit local state path', clawPath >= 0 && openclawCall[clawPath + 1] === OPENCLAW);

  for (const [name, got] of [['OpenCode', opencode], ['Hermes', hermes], ['OpenClaw', openclaw]]) {
    check(`${name} exposes today/week tokens`, got.tokensToday === 12345 && got.tokensWeek === 12345);
    check(`${name} exposes today/week estimated cost`, got.costToday === 0.4567 && got.costWeek === 0.4567);
    check(`${name} does not invent a subscription quota`, got.quota === null);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
