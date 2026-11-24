// Are the CLIs' local-state links still links?
//
// Some CLIs cannot be told where to keep their state, so entrypoint.sh links
// the path they use under HOME (on the bucket) to a directory on local disk,
// which scripts/agent-state.sh checkpoints: ~/.local/share/opencode, ~/.hermes,
// ~/.fx, and Antigravity's ~/.gemini/antigravity-cli and ~/.gemini/config.
//
// On 2026-11-20 both Antigravity links were real directories on the bucket
// again, in a Space that had been up since 11-16 (the entrypoint only checks at
// boot). agy then wrote its SQLite databases straight onto hf-mount, whose
// fsync is not durable; the checkpoint and the conversation lookup never saw
// them, and four conversations came back 'database disk image is malformed'.
// Nothing said so for four days.
//
// So: the links are looked at here — lstat only, cached, cheap enough for
// /api/info — and reported while one is not the expected link. Antigravity's
// are repaired before every agy launch and at server start
// (`agent-state.sh relink-antigravity`), and never while agy runs: then the
// repair is deferred, and the warning stays until a later launch makes it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { checkpointLogPath } from './checkpoint-health.js';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const CACHE_MS = 5000;
// A merge of a large tree off the bucket is slow (~27 ms a file), but it
// happens once per breakage, and an agy launched before it ends would write to
// the bucket again.
const REPAIR_TIMEOUT_MS = 180_000;

/** The links entrypoint.sh makes, for the CLIs whose live directory is set. */
export function expectedLinks(env = process.env) {
  const home = env.HOME || '';
  if (!home) return [];
  const out = [];
  const add = (cli, rel, target) => { if (target) out.push({ cli, link: path.join(home, rel), target }); };
  add('opencode', '.local/share/opencode', env.OPENCODE_LIVE);
  add('hermes', '.hermes', env.HERMES_LIVE);
  add('fx', '.fx', env.FX_LIVE);
  if (env.ANTIGRAVITY_LIVE) {
    add('antigravity', '.gemini/antigravity-cli', path.join(env.ANTIGRAVITY_LIVE, 'antigravity-cli'));
    add('antigravity', '.gemini/config', path.join(env.ANTIGRAVITY_LIVE, 'config'));
  }
  return out;
}

/**
 * What is at `link`: 'ok' (a link to `target`), 'dir' (a real directory —
 * the CLI's state is wherever HOME is, the bucket on a Space), 'missing',
 * 'other-link' (a link somewhere else) or 'file'.
 */
export function inspectLink({ link, target }) {
  let st;
  try { st = fs.lstatSync(link); } catch { return 'missing'; }
  if (st.isSymbolicLink()) {
    let to;
    try { to = fs.readlinkSync(link); } catch { return 'other-link'; }
    return path.resolve(path.dirname(link), to) === path.resolve(target) ? 'ok' : 'other-link';
  }
  return st.isDirectory() ? 'dir' : 'file';
}

const under = (p, root) => !!root && (p === root || p.startsWith(`${root.replace(/\/+$/, '')}/`));

/**
 * null when every link is as entrypoint.sh made it. Otherwise
 * `{ broken: [{ cli, link, target, kind, onBucket }], repair, log }`, where
 * `repair` is the last Antigravity repair this process ran that did not end
 * clean (`deferred` while agy was running, or `failed`), or null.
 * A missing link counts only for Antigravity: the others are made at boot and
 * nothing at all there is harmless until the CLI runs.
 */
export function readStateLinkHealth({ env = process.env, dataDir = DATA_DIR } = {}) {
  const broken = [];
  for (const l of expectedLinks(env)) {
    const kind = inspectLink(l);
    if (kind === 'ok' || (kind === 'missing' && l.cli !== 'antigravity')) continue;
    broken.push({ ...l, kind, onBucket: under(l.link, dataDir) });
  }
  if (!broken.length) return null;
  return { broken, repair: lastRepair, log: checkpointLogPath() };
}

let cache = { at: 0, value: null };
export function stateLinkHealth() {
  const now = Date.now();
  if (now - cache.at > CACHE_MS) cache = { at: now, value: readStateLinkHealth() };
  return cache.value;
}

let lastRepair = null;
/** Test seam: forget the last repair outcome and the cached health. */
export function _reset() { lastRepair = null; cache = { at: 0, value: null }; }

/**
 * Make ~/.gemini/{antigravity-cli,config} links again if either is not one.
 * Synchronous on purpose: it runs right before agy is spawned, and a launch
 * that went ahead first would write to the bucket. Costs two lstat calls when
 * nothing is wrong. Returns 'ok' | 'repaired' | 'deferred' | 'failed'.
 */
export function ensureAntigravityLinks({ env = process.env, reason = 'launch', missingOnly = false } = {}) {
  const links = expectedLinks(env).filter((l) => l.cli === 'antigravity');
  const kinds = links.map(inspectLink);
  if (!links.length || kinds.every((k) => k === 'ok')) {
    lastRepair = null;
    return 'ok';
  }
  // A link pointing elsewhere is someone's deliberate choice: report, don't touch.
  if (kinds.every((k) => k === 'ok' || k === 'other-link')) return 'ok';
  if (missingOnly && !kinds.includes('missing')) return 'ok';
  const script = env.AGENT_STATE_SCRIPT || path.join(SCRIPTS_DIR, 'agent-state.sh');
  const r = spawnSync('sh', [script, 'relink-antigravity'], {
    env: missingOnly ? { ...env, AGENT_STATE_RELINK_MISSING_ONLY: '1' } : env,
    encoding: 'utf8', timeout: REPAIR_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  const said = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
  cache = { at: 0, value: null };
  if (r.status === 0) {
    console.warn(`[state-links] ${reason}: Antigravity state was not linked to local disk; repaired. ${said}`);
    lastRepair = null;
    return 'repaired';
  }
  // The watcher leaves a directory to the next launch: not a failure of its own.
  if (missingOnly && r.status === 3) return 'ok';
  const outcome = r.status === 3 ? 'deferred' : 'failed';
  lastRepair = { outcome, at: Date.now(), reason, detail: said || (r.error && r.error.message) || `exit ${r.status}` };
  console.warn(`[state-links] ${reason}: Antigravity link repair ${outcome}: ${lastRepair.detail}`);
  return outcome;
}

/**
 * hf-mount can drop a link under HOME on its own (see agent-state.sh
 * relink-antigravity), and agy's next start then makes a real directory on the
 * bucket in its place. Put a missing one back within WATCH_MS: two lstat calls
 * a tick, and making a link where nothing is moves no data, so it is safe while
 * agy runs. A real directory is left to the next launch.
 */
export const WATCH_MS = 30_000;
export function watchAntigravityLinks({ env = process.env, everyMs = WATCH_MS } = {}) {
  if (!expectedLinks(env).some((l) => l.cli === 'antigravity')) return null;
  const t = setInterval(() => {
    try { ensureAntigravityLinks({ env, reason: 'watch', missingOnly: true }); } catch (e) { console.error('[state-links]', e && e.message); }
  }, everyMs);
  t.unref?.();
  return t;
}
