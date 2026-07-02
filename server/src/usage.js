import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// Cache stores the in-flight/settled PROMISE, so concurrent requests share one
// underlying ccusage run / file scan instead of piling up.
const cache = new Map(); // key -> { ts, val: Promise }
const TTL = 60_000;
function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < TTL) return c.val;
  const val = Promise.resolve().then(fn).catch(() => null);
  cache.set(key, { ts: Date.now(), val });
  return val;
}

// Normalize a reset timestamp to unix SECONDS. Providers disagree: some report
// epoch seconds, some epoch millis, Claude's statusline payload uses an ISO
// string. The frontend assumes seconds.
function toEpochSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

function dateOf(entry) {
  for (const k of ['date', 'period', 'day']) {
    if (typeof entry[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(entry[k])) return entry[k].slice(0, 10);
  }
  for (const v of Object.values(entry)) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  return null;
}

// Claude stores conversation transcripts under CLAUDE_CONFIG_DIR/projects, but
// depending on version they can also live in ~/.claude or ~/.config/claude. Give
// ccusage all candidates (it accepts a comma-separated CLAUDE_CONFIG_DIR and
// ignores ones that don't exist) so token/cost aggregation isn't silently empty.
function claudeEnv() {
  const home = process.env.HOME || '';
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')]
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i);
  return { ...process.env, CLAUDE_CONFIG_DIR: dirs.join(',') };
}

// Tokens + (estimated) cost for a provider, via `ccusage <provider> daily --json`.
function providerUsage(prov) {
  return cached(`u:${prov}`, async () => {
    const env = prov === 'claude' ? claudeEnv() : process.env;
    let out;
    try {
      ({ stdout: out } = await execFile('ccusage', [prov, 'daily', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env }));
    } catch { return null; }
    let data;
    try { data = JSON.parse(out); } catch { return null; }
    const arr = Array.isArray(data.daily) ? data.daily : [];
    const today = new Date().toISOString().slice(0, 10);
    const weekCut = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    let tT = 0, cT = 0, tW = 0, cW = 0;
    for (const e of arr) {
      const d = dateOf(e);
      if (!d) continue;
      const tok = e.totalTokens || 0;
      const cost = e.totalCost || 0;
      if (d === today) { tT += tok; cT += cost; }
      if (d >= weekCut) { tW += tok; cW += cost; }
    }
    return {
      tokensToday: tT, costToday: cT, tokensWeek: tW, costWeek: cW,
      totalCost: (data.totals && data.totals.totalCost) || 0,
    };
  });
}

function findRateLimits(obj) {
  let found = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.rate_limits && typeof o.rate_limits === 'object') found = o.rate_limits;
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(obj);
  return found;
}

// Codex persists a rate-limit snapshot into its session rollout files. Scan
// rollout files newest-first and return the latest snapshot we can find — NOT
// just the newest file's, because a freshly-started session's rollout has no
// rate_limits yet (it only appears after a request), which would otherwise make
// the quota look "gone" right after a restart until you run something.
async function codexRollouts() {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  const root = path.join(home, 'sessions');
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { files.push({ p, m: (await fsp.stat(p)).mtimeMs }); } catch {}
      }
    }
  };
  await walk(root, 0);
  return files.sort((a, b) => b.m - a.m);
}

function codexQuota() {
  return cached('codexq', async () => {
    const win = (w) => (w ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAt: toEpochSec(w.resets_at) } : null);
    for (const f of await codexRollouts()) {
      let rl = null;
      let lines;
      try { lines = (await fsp.readFile(f.p, 'utf8')).split('\n'); } catch { continue; }
      for (const ln of lines) {
        if (!ln) continue;
        let j; try { j = JSON.parse(ln); } catch { continue; }
        const r = findRateLimits(j);
        if (r) rl = r;
      }
      if (rl) return { fiveHour: win(rl.primary), weekly: win(rl.secondary) };
    }
    return null;
  });
}

// Claude quota is written by our statusline hook (see claude-statusline.mjs):
// it captures the rate_limits Claude reports, so it's as fresh as the last time
// a Claude session made a model call on the Space.
async function claudeQuota() {
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (!cfg) return null;
    const p = path.join(cfg, 'usage.json');
    const j = JSON.parse(await fsp.readFile(p, 'utf8'));
    const rl = j.rate_limits;
    if (!rl) return null;
    const w = (x) => (x ? { usedPercent: x.used_percentage ?? x.used_percent, resetsAt: toEpochSec(x.resets_at) } : null);
    return { fiveHour: w(rl.five_hour), weekly: w(rl.seven_day), opus: w(rl.seven_day_opus), updatedAt: j.ts || null };
  } catch { return null; }
}

// Diagnostics: where might Claude transcripts live, and does ccusage see them?
function countJsonl(dir, depth = 0) {
  if (depth > 5) return 0;
  let n = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countJsonl(p, depth + 1);
    else if (e.name.endsWith('.jsonl')) n++;
  }
  return n;
}

async function debugInfo() {
  const home = process.env.HOME || '';
  let ccusage = null;
  try { ccusage = (await execFile('ccusage', ['--version'], { encoding: 'utf8', timeout: 10_000 })).stdout.trim(); } catch (e) { ccusage = `MISSING (${e.code || e.message})`; }
  const claudeDirs = [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')]
    .filter(Boolean)
    .map((d) => {
      const proj = path.join(d, 'projects');
      return { dir: d, projectsExists: fs.existsSync(proj), jsonl: fs.existsSync(proj) ? countJsonl(proj) : 0 };
    });
  const raw = async (prov) => { const u = await providerUsage(prov); return u ? { tokensWeek: u.tokensWeek, costWeek: u.costWeek } : null; };
  return {
    env: { HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null, CODEX_HOME: process.env.CODEX_HOME || null },
    ccusage,
    claudeDirs,
    codexRolloutFiles: (await codexRollouts()).length,
    raw: { claude: await raw('claude'), codex: await raw('codex'), gemini: await raw('gemini') },
  };
}

export async function buildUsage(debug = false) {
  const [uClaude, uCodex, uGemini, qClaude, qCodex] = await Promise.all([
    providerUsage('claude'), providerUsage('codex'), providerUsage('gemini'),
    claudeQuota(), codexQuota(),
  ]);
  const out = {
    providers: {
      claude: { ...(uClaude || {}), quota: qClaude },
      codex: { ...(uCodex || {}), quota: qCodex },
      gemini: { ...(uGemini || {}), quota: null },
    },
    generatedAt: new Date().toISOString(),
  };
  if (debug) out._debug = await debugInfo();
  return out;
}
