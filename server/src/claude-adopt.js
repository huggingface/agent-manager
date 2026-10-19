// Adopt an existing Claude Code conversation as an AM session. Nothing starts:
// the session is recorded as already started, so opening it runs the runner's
// existing `claude --resume <uuid>` branch instead of a fresh `--session-id`.
//
// Claude keys transcripts by working directory
// (<config>/projects/<cwd with every non-alphanumeric as '-'>/<uuid>.jsonl) and
// `--resume <uuid>` only finds the conversation from that same directory, so the
// adopted session's folder must be the one the conversation was recorded in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export const projectDirName = (workdir) => path.resolve(workdir).replace(/[^a-zA-Z0-9]/g, '-');

// Every projects/<dir>/<uuid>.jsonl (a conversation moved between folders can
// leave more than one). Unreadable directories count as absent.
export function findTranscripts(uuid, configDir = claudeConfigDir()) {
  const projects = path.join(configDir, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  return dirs.map((d) => path.join(projects, d.name, `${uuid}.jsonl`)).filter((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
}

// Returns { transcript } or { status, code, error }. `sessions` is every AM
// session, archived ones included: an archived session can be restored and
// would then resume the same conversation as the adopted one.
export function checkAdoption({ uuid, cli, prompt, workdir, sessions, configDir = claudeConfigDir() }) {
  const fail = (status, code, error) => ({ status, code, error });
  if (cli !== 'claude') return fail(400, 'adopt-cli', 'only a Claude conversation can be adopted (cli=claude)');
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return fail(400, 'adopt-uuid', 'adoptSessionUuid must be a lowercase Claude session UUID');
  if (typeof prompt === 'string' && prompt.trim()) return fail(400, 'adopt-prompt', 'an adopted session starts nothing — send no prompt; message it after opening it');
  const owner = sessions.find((s) => s.sessionUuid === uuid);
  if (owner) return fail(409, 'adopt-in-use', `conversation ${uuid} already belongs to AM session '${owner.id}'`);
  const found = findTranscripts(uuid, configDir);
  if (!found.length) return fail(404, 'adopt-no-transcript', `no transcript ${uuid}.jsonl under ${path.join(configDir, 'projects')}`);
  // Claude records process.cwd(), which may be the folder's real path.
  const names = new Set([projectDirName(workdir)]);
  try { names.add(projectDirName(fs.realpathSync(workdir))); } catch {}
  const transcript = found.find((file) => names.has(path.basename(path.dirname(file))));
  if (!transcript) {
    return fail(400, 'adopt-wrong-folder', `conversation ${uuid} was recorded in ${path.basename(path.dirname(found[0]))}, not in this folder — pass the path the conversation ran in`);
  }
  return { transcript };
}

export const ADOPT_NOTE = 'Exit the original Claude process for this conversation before opening the session here: two processes must never resume the same conversation.';
