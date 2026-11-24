// Are the CLIs' local-state links still links?
//
// Some CLIs cannot be told where to keep their state, so entrypoint.sh links
// the path they use under HOME (on the bucket) to a directory on local disk,
// which scripts/agent-state.sh checkpoints: ~/.local/share/opencode, ~/.hermes,
// ~/.fx, and Antigravity's ~/.gemini/antigravity-cli and ~/.gemini/config.
//
// On 2026-11-20 both Antigravity links were real directories on the bucket
// again: agy wrote its SQLite onto hf-mount, whose fsync is not durable, and
// four conversations came back malformed. A link on the bucket does not stay
// put, so AM's agy no longer goes through it: it runs with HOME on local disk
// (agy-home.js). What is left here:
//
//   - the check, lstat only and cached, for /api/info and the banner: every
//     CLI's link, and the local $AGY_HOME/.gemini links agy now uses;
//   - a ONE-TIME migration at server start of a real ~/.gemini/antigravity-cli
//     or config on the bucket (written by an agy started some other way) into
//     the live tree: `agent-state.sh relink-antigravity`, asynchronous, and
//     only while no agy runs at all. Otherwise it is deferred to the next start
//     and the banner says so.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { agyHomeDir } from './agy-home.js';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { checkpointLogPath } from './checkpoint-health.js';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const CACHE_MS = 5000;
// A merge of a large tree off the bucket is slow (~27 ms a file). It runs in
// the background; nothing waits on it but the revive of panes at boot.
const REPAIR_TIMEOUT_MS = 600_000;

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
    // The ones agy actually uses: on local disk, under its own HOME.
    const agyHome = agyHomeDir(env);
    if (agyHome) {
      for (const n of ['antigravity-cli', 'config']) {
        out.push({ cli: 'antigravity', link: path.join(agyHome, '.gemini', n), target: path.join(env.ANTIGRAVITY_LIVE, n), local: true });
      }
    }
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
 * null when every link is as entrypoint.sh / agy-home.js made it. Otherwise
 * `{ broken: [{ cli, link, target, kind, onBucket }], repair, log }`, where
 * `repair` is the last bucket migration that did not end clean (`deferred`
 * while agy was running, or `failed`), or null.
 * Missing counts only for agy's own local links: a missing link on the bucket
 * is harmless until something writes there, and agy no longer does.
 */
export function readStateLinkHealth({ env = process.env, dataDir = DATA_DIR } = {}) {
  const broken = [];
  for (const l of expectedLinks(env)) {
    const kind = inspectLink(l);
    if (kind === 'ok' || (kind === 'missing' && !l.local)) continue;
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
let migrating = 0;
/** True while a migration may be writing into the live tree: no agy may start then. */
export function agyMigrationRunning() { return migrating > 0; }
/** Test seam: forget the last repair outcome and the cached health. */
export function _reset() { lastRepair = null; cache = { at: 0, value: null }; }

/**
 * The one-time migration: if ~/.gemini/antigravity-cli or config on the bucket
 * is a real directory, merge it into $ANTIGRAVITY_LIVE, move it aside and link
 * it again (agent-state.sh relink-antigravity). Asynchronous. Resolves to
 * 'ok' | 'repaired' | 'deferred' | 'failed'.
 */
export function migrateBucketAgyState({ env = process.env, reason = 'server start' } = {}) {
  const bucket = expectedLinks(env).filter((l) => l.cli === 'antigravity' && !l.local);
  if (!bucket.some((l) => ['dir', 'missing'].includes(inspectLink(l)))) {
    lastRepair = null;
    return Promise.resolve('ok');
  }
  const script = env.AGENT_STATE_SCRIPT || path.join(SCRIPTS_DIR, 'agent-state.sh');
  migrating += 1;
  return new Promise((resolve) => {
    execFile('sh', [script, 'relink-antigravity'], { env, encoding: 'utf8', timeout: REPAIR_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        migrating -= 1;
        const status = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        const said = `${stderr || ''}${stdout || ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
        cache = { at: 0, value: null };
        if (status === 0) {
          if (said) console.warn(`[state-links] ${reason}: ${said}`);
          lastRepair = null;
          return resolve(said ? 'repaired' : 'ok');
        }
        const outcome = status === 3 ? 'deferred' : 'failed';
        lastRepair = { outcome, at: Date.now(), reason, detail: said || (err && err.message) || `exit ${status}` };
        console.warn(`[state-links] ${reason}: Antigravity bucket migration ${outcome}: ${lastRepair.detail}`);
        resolve(outcome);
      });
  });
}
