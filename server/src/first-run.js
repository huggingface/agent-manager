// Pre-answering the dialogs a new agent session would otherwise stop at.
//
// Everything here is measured against the installed CLIs rather than read off
// their docs; docs/first-run-dialogs.md records the runs. Three facts shape the
// design, and each one narrows what has to be written at runtime:
//
//   1. Claude Code 2.1.232 INHERITS folder trust from a parent. Trusting the
//      workspaces root once therefore covers every session under it, so nothing
//      has to be written when a session starts.
//   2. Codex 0.149.0 does NOT inherit, and it reads trust from config.toml
//      itself — a `-c` override does not reach the check. So its answer has to
//      be written, but it is APPENDED: a few bytes at the end, never a rewrite
//      of anybody else's, which is the difference that matters below.
//   3. Codex's blocking "Update available!" screen is driven by its own
//      `version.json` cache and is suppressed by that file's `dismissed_version`
//      — the same field its "Skip until next version" option writes.
//
// Why that matters: an earlier version of this file read all of `.claude.json`,
// changed one entry and renamed the result over the live file on every new
// session. Rename prevents a torn file; it is not a lock. A review reproduced a
// lost concurrent write deterministically, and the loss is silent because
// nothing ends up malformed. The rule now is: never rewrite CLI-owned state on
// the session path, and when boot has to write, write once and only if needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACES_DIR } from './config.js';

const homeDir = () => process.env.HOME || os.homedir();

export const claudeStateFile = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || homeDir(), '.claude.json');
export const codexConfigFile = () =>
  path.join(process.env.CODEX_HOME || path.join(homeDir(), '.codex'), 'config.toml');
export const codexVersionFile = () =>
  path.join(process.env.CODEX_HOME || path.join(homeDir(), '.codex'), 'version.json');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.am-tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read JSON, or null when it is absent or not an object we understand. */
function readObject(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Trust the workspaces ROOT for Claude, once.
 *
 * Claude inherits trust downwards, so this answers the folder question for
 * every session that will ever run under it — which is the whole reason this
 * can be a boot-time write rather than a per-session one. Called before the app
 * spawns anything, and it rewrites nothing when the root is already trusted, so
 * in practice it writes once in the life of a config.
 *
 * Returns 'already' | 'written' | 'skipped' so the caller can log honestly.
 */
export function trustWorkspacesRoot(dir = WORKSPACES_DIR) {
  const file = claudeStateFile();
  try {
    const cfg = readObject(file);
    if (cfg === null) { console.warn(`[first-run] ${file} is not an object; leaving it alone`); return 'skipped'; }
    if (cfg.projects !== undefined
      && (typeof cfg.projects !== 'object' || cfg.projects === null || Array.isArray(cfg.projects))) {
      console.warn(`[first-run] ${file} has a projects field that is not an object; leaving it alone`);
      return 'skipped';
    }
    const projects = cfg.projects || {};
    if (projects[dir] && projects[dir].hasTrustDialogAccepted === true) return 'already';
    cfg.projects = {
      ...projects,
      [dir]: { ...(typeof projects[dir] === 'object' && projects[dir] ? projects[dir] : {}), hasTrustDialogAccepted: true },
    };
    writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return 'written';
  } catch (e) {
    console.warn(`[first-run] could not trust ${dir} for claude: ${e && e.message}`);
    return 'skipped';
  }
}

/**
 * The bypass-permissions warning, whose default button is "No, exit" — a blind
 * Enter on it quits the session, so it can never be answered by typing. This
 * lives in settings.json, which the app already writes (the hooks installer),
 * so it is not CLI-owned state.
 */
export function ensureClaudeDialogDefaults() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return false;
  const file = path.join(dir, 'settings.json');
  try {
    const cfg = readObject(file);
    if (cfg === null) { console.warn(`[first-run] ${file} is not an object; leaving it alone`); return false; }
    if (cfg.skipDangerousModePermissionPrompt === true) return false;
    cfg.skipDangerousModePermissionPrompt = true;
    writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return true;
  } catch (e) {
    console.warn(`[first-run] could not write ${file}: ${e && e.message}`);
    return false;
  }
}

/** Numeric compare of dotted versions; non-numeric parts sort as 0. */
export function isNewer(candidate, current) {
  const part = (v) => String(v || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = part(candidate);
  const b = part(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/**
 * Codex's update screen blocks a session before it starts — on a launch with no
 * prompt, which is exactly how a session created without a task starts. Mark
 * the known version as dismissed so the screen does not open.
 *
 * This deliberately does NOT stop Codex checking. `latest_version` and
 * `last_checked_at` are left exactly as Codex wrote them, so the cache still
 * records what is available and `codex update` still works; the only thing
 * suppressed is the modal. The version found is logged, so "we are behind" is
 * something the operator can read rather than something we quietly swallowed.
 *
 * Writes at most one small file, and only when a newer version is present and
 * not already dismissed.
 */
export function dismissCodexUpdatePrompt(currentVersion) {
  const file = codexVersionFile();
  try {
    const cache = readObject(file);
    if (cache === null || !cache.latest_version) return false;
    if (!isNewer(cache.latest_version, currentVersion)) return false;
    if (cache.dismissed_version === cache.latest_version) return false;
    writeAtomic(file, `${JSON.stringify({ ...cache, dismissed_version: cache.latest_version })}\n`);
    console.log(`[first-run] codex ${cache.latest_version} is available (running ${currentVersion}); `
      + 'its update prompt is dismissed so it cannot block a session — run `codex update` or rebuild the image to take it');
    return true;
  } catch (e) {
    console.warn(`[first-run] could not read/write ${file}: ${e && e.message}`);
    return false;
  }
}


/**
 * TOML keys for the same path can be spelled several legal ways, and Codex's
 * own serializer only writes one of them. Decode every `[projects.KEY]` header
 * we can see so an existing entry is recognised however it was written —
 * appending a second table for a path that already has one produces a file
 * Codex cannot load ("declared twice").
 */
export function codexTrustedPaths(text) {
  const found = new Set();
  const header = /^[ \t]*\[projects\.(.+?)\][ \t]*$/gm;
  for (const [, rawKey] of text.matchAll(header)) {
    const key = rawKey.trim();
    if (key.startsWith("'") && key.endsWith("'") && key.length >= 2) {
      found.add(key.slice(1, -1));                      // literal string: no escapes
    } else if (key.startsWith('"') && key.endsWith('"') && key.length >= 2) {
      // basic string: undo the escapes Codex could have written
      found.add(key.slice(1, -1).replace(/\\(["\\])/g, '$1'));
    } else {
      found.add(key);                                   // bare key
    }
  }
  return found;
}

/**
 * Trust one workspace for Codex.
 *
 * APPEND-ONLY, and that is the whole point. The version of this file that a
 * review rejected read all of `.claude.json`, edited it, and renamed the result
 * over the live file — which silently discarded whatever the CLI had written in
 * between. An append never writes another process's bytes: at worst our own few
 * bytes are lost if Codex rewrites the file at the same instant, and the only
 * consequence of that is the dialog appearing once more.
 */
export function trustCodexWorkspace(dir) {
  if (!dir || !path.isAbsolute(dir)) return false;
  const file = codexConfigFile();
  try {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (codexTrustedPaths(text).has(dir)) return false;
    const key = dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text.length && !text.endsWith('\n') ? '\n' : ''}\n[projects."${key}"]\ntrust_level = "trusted"\n`);
    return true;
  } catch (e) {
    console.warn(`[first-run] could not trust ${dir} for codex: ${e && e.message}`);
    return false;
  }
}
