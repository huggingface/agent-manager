// Pre-answering the first-run dialogs a new agent session would otherwise sit
// in front of.
//
// Both Claude Code and Codex ask "do you trust this folder?" the first time
// they run in a directory, keyed on the ABSOLUTE path — a trusted parent does
// not cover its children, so every new session's workspace is a new question.
// A dialog is not merely annoying here: the manager and other agents launch
// sessions with the task as an argument and nobody is watching the pane.
//
// What that costs, measured rather than assumed (see docs/first-run-dialogs.md):
//   · the launch prompt itself SURVIVES — it is queued and runs once the dialog
//     is answered, for both CLIs;
//   · but a prompt sent WHILE the dialog is up is partly eaten: the dialog's
//     key handler consumes the leading characters and the trailing Enter
//     dismisses it, so "reply with exactly SECOND" arrived as
//     "with exactly SECOND";
//   · and a freshly booted CLI reports `idle`, so a coordinator waiting on the
//     session sees "finished" while the work has not started.
//
// `waitForInputReady` cannot save us: it waits for the screen to go quiet, and
// a dialog IS a quiet screen. So the answer is to have answered already.
//
// Everything here is idempotent, additive, and best-effort: a config we cannot
// read or write must never stop a session from starting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const homeDir = () => process.env.HOME || os.homedir();

/** Where Claude keeps the state file that holds per-project trust. */
export function claudeStateFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return path.join(dir || homeDir(), '.claude.json');
}

/** Where Codex keeps its config, which holds per-project trust. */
export function codexConfigFile() {
  const home = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
  return path.join(home, 'config.toml');
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.am-tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Record `dir` as trusted for Claude. The file is the CLI's own state, so we
 * only ADD the one key: everything else in it is the CLI's business.
 */
function trustClaude(dir) {
  const file = claudeStateFile();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;   // unreadable: leave it alone entirely
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return false;
  if (typeof cfg.projects !== 'object' || cfg.projects === null || Array.isArray(cfg.projects)) {
    if (cfg.projects !== undefined) return false;
    cfg.projects = {};
  }
  const entry = cfg.projects[dir];
  if (entry && entry.hasTrustDialogAccepted === true) return false;   // already answered
  cfg.projects[dir] = { ...(entry && typeof entry === 'object' ? entry : {}), hasTrustDialogAccepted: true };
  writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return true;
}

/**
 * Record `dir` as trusted for Codex. Appended as its own table: Codex writes
 * these itself in the same shape, and appending at the end of the file cannot
 * land inside somebody else's table.
 */
function trustCodex(dir) {
  const file = codexConfigFile();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // The exact table header Codex uses. A basic TOML string, so a quote or a
  // backslash in a folder name has to be escaped the same way.
  const key = `[projects."${dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  if (text.includes(key)) return false;
  const body = `${text.length && !text.endsWith('\n') ? '\n' : ''}\n${key}\ntrust_level = "trusted"\n`;
  writeAtomic(file, text + body);
  return true;
}

const TRUSTERS = { claude: trustClaude, codex: trustCodex };

/**
 * Answer the folder-trust question for `cli` in `dir` before the CLI is asked
 * it. Returns true when something was written.
 */
export function trustWorkspace(cli, dir) {
  const trust = TRUSTERS[cli];
  if (!trust || !dir || !path.isAbsolute(dir)) return false;
  try {
    return trust(dir);
  } catch (e) {
    // A session that starts with a dialog is worse than one that starts, so
    // this is a warning and never a throw.
    console.warn(`[first-run] could not pre-trust ${dir} for ${cli}: ${e && e.message}`);
    return false;
  }
}

/**
 * The one global dialog whose answer the repo should own rather than inherit.
 *
 * `skipDangerousModePermissionPrompt` suppresses the "running in Bypass
 * Permissions mode" warning, whose default button is *No, exit* — a blind Enter
 * on it kills the session. The live config has this key because somebody once
 * answered the dialog by hand; nothing guaranteed it, so a rebuilt config would
 * ask again. Written only when absent.
 *
 * Deliberately NOT touched here: anything that changes what an agent is allowed
 * to do (`permissions.defaultMode`, Codex's `approval_policy` / `sandbox_mode`),
 * and anything that stops the CLIs CHECKING for updates. Suppressing a question
 * we always answer the same way is not the same as granting a permission or
 * freezing a version.
 */
export function ensureClaudeDialogDefaults() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return false;
  const file = path.join(dir, 'settings.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') { console.warn(`[first-run] ${file} unreadable: ${e.message}`); return false; }
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return false;
  if (cfg.skipDangerousModePermissionPrompt === true) return false;
  cfg.skipDangerousModePermissionPrompt = true;
  try {
    writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return true;
  } catch (e) {
    console.warn(`[first-run] could not write ${file}: ${e && e.message}`);
    return false;
  }
}
