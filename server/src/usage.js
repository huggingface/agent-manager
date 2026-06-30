import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const cache = new Map(); // key -> { ts, val }
const TTL = 60_000;
function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < TTL) return c.val;
  let val = null;
  try { val = fn(); } catch { val = null; }
  cache.set(key, { ts: Date.now(), val });
  return val;
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
  return cached(`u:${prov}`, () => {
    const env = prov === 'claude' ? claudeEnv() : process.env;
    let out;
    try {
      out = execFileSync('ccusage', [prov, 'daily', '--json'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], env });
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
function codexRollouts() {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  const root = path.join(home, 'sessions');
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { files.push({ p, m: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.m - a.m);
}

function codexQuota() {
  return cached('codexq', () => {
    const win = (w) => (w ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAt: w.resets_at } : null);
    for (const f of codexRollouts()) {
      let rl = null;
      let lines;
      try { lines = fs.readFileSync(f.p, 'utf8').split('\n'); } catch { continue; }
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

// Snapshot fallback: the statusline hook (claude-statusline.mjs) writes the last
// rate_limits Claude rendered. Only as fresh as the last Claude session.
function claudeSnapshotQuota() {
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (!cfg) return null;
    const p = path.join(cfg, 'usage.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rl = j.rate_limits;
    if (!rl) return null;
    const w = (x) => (x ? { usedPercent: x.used_percentage ?? x.used_percent, resetsAt: x.resets_at } : null);
    return { fiveHour: w(rl.five_hour), weekly: w(rl.seven_day), opus: w(rl.seven_day_opus), updatedAt: j.ts || null, source: 'snapshot' };
  } catch { return null; }
}

// Live quota from the same first-party account-usage endpoint Claude Code's
// `fetchUtilization` uses — no inference call, no token cost. Undocumented, so
// we treat any failure (expired/absent token, network, shape change) as "fall
// back to the statusline snapshot". Cached briefly so polling can't hammer it.
let liveCache = { ts: 0, val: null };
async function claudeLiveQuota() {
  if (Date.now() - liveCache.ts < 20_000) return liveCache.val;
  let val = null;
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    const cred = cfg && JSON.parse(fs.readFileSync(path.join(cfg, '.credentials.json'), 'utf8'));
    const token = cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
    if (token) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6_000);
      let r;
      try {
        r = await fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      if (r && r.ok) {
        const j = await r.json();
        const win = (x) => (x && typeof x.utilization === 'number'
          ? { usedPercent: x.utilization, resetsAt: x.resets_at ? Math.floor(Date.parse(x.resets_at) / 1000) : undefined }
          : null);
        const fiveHour = win(j.five_hour);
        const weekly = win(j.seven_day);
        if (fiveHour || weekly) {
          val = { fiveHour, weekly, opus: win(j.seven_day_opus), updatedAt: Date.now(), source: 'live' };
        }
      }
    }
  } catch { val = null; }
  liveCache = { ts: Date.now(), val };
  return val;
}

async function claudeQuota() {
  return (await claudeLiveQuota()) || claudeSnapshotQuota();
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

function debugInfo() {
  const home = process.env.HOME || '';
  let ccusage = null;
  try { ccusage = execFileSync('ccusage', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch (e) { ccusage = `MISSING (${e.code || e.message})`; }
  const claudeDirs = [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')]
    .filter(Boolean)
    .map((d) => {
      const proj = path.join(d, 'projects');
      return { dir: d, projectsExists: fs.existsSync(proj), jsonl: fs.existsSync(proj) ? countJsonl(proj) : 0 };
    });
  const raw = (prov) => { const u = providerUsage(prov); return u ? { tokensWeek: u.tokensWeek, costWeek: u.costWeek } : null; };
  return {
    env: { HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null, CODEX_HOME: process.env.CODEX_HOME || null },
    ccusage,
    claudeDirs,
    codexRolloutFiles: codexRollouts().length,
    raw: { claude: raw('claude'), codex: raw('codex'), gemini: raw('gemini') },
  };
}

export async function buildUsage(debug = false) {
  const out = {
    providers: {
      claude: { ...(providerUsage('claude') || {}), quota: await claudeQuota() },
      codex: { ...(providerUsage('codex') || {}), quota: codexQuota() },
      gemini: { ...(providerUsage('gemini') || {}), quota: null },
    },
    generatedAt: new Date().toISOString(),
  };
  if (debug) out._debug = debugInfo();
  return out;
}
