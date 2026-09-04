import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANAGED_CONTEXT_START = '<!-- BEGIN AGENT MANAGER CONTEXT -->';
export const MANAGED_CONTEXT_END = '<!-- END AGENT MANAGER CONTEXT -->';

const CONTEXT = (port) => `# Agent Manager environment

This session is running inside **Agent Manager**. Other AI sessions may run in
sibling folders, and you can see, watch, and message them through the local API.
This block applies only when \`$AM_ID\` is set; otherwise ignore it.

You are \`$AM_ID\` (display name \`$AM_NAME\`), talking to the manager on
\`localhost:\${AM_PORT:-${port}}\`.

\`\`\`sh
# Who is here (state, folder, last prompt/answer, trace path):
curl -sS --fail "http://localhost:\${AM_PORT:-${port}}/api/agents?from=$AM_ID" | jq .

# Watch a peer instead of polling it:
curl -sS --fail "http://localhost:\${AM_PORT:-${port}}/api/agents/$ID/tail?lines=120" | jq -r .text
curl -sS --fail "http://localhost:\${AM_PORT:-${port}}/api/agents/$ID/wait?timeout=120"

# Message a peer (body = the prompt):
curl -sS --fail -X POST "http://localhost:\${AM_PORT:-${port}}/api/agents/$ID/prompt?from=$AM_ID" \\
  -H 'content-type: text/plain' --data-binary 'your message'
\`\`\`

Rules that matter:

- States: \`working\` = leave it alone; \`waiting\` = safe to talk to;
  \`stopped\` = prompting wakes it (boots a CLI and costs money).
- Prompts prefixed \`[message from <name>:]\` come from another agent, not from
  the operator.
- Use \`/wait\` rather than sleep-poll loops. Do not ping-pong with peers: send
  one clear, self-contained message.
- Stay in your own folder; never delete a sibling folder.
- Notify the operator (\`POST /api/notify\`) only when explicitly asked, exactly
  once per requested event.`;

function managedContext(port) {
  return `${MANAGED_CONTEXT_START}\n${CONTEXT(port)}\n${MANAGED_CONTEXT_END}`;
}

/**
 * Insert or refresh Agent Manager's block without changing operator-owned text.
 * Ambiguous/malformed markers are refused rather than risking data loss.
 */
export function mergeManagedContext(current, port) {
  const start = current.indexOf(MANAGED_CONTEXT_START);
  const end = current.indexOf(MANAGED_CONTEXT_END);
  const lastStart = current.lastIndexOf(MANAGED_CONTEXT_START);
  const lastEnd = current.lastIndexOf(MANAGED_CONTEXT_END);
  const hasAnyMarker = start !== -1 || end !== -1;

  if (hasAnyMarker
      && (start === -1 || end === -1 || start > end
        || start !== lastStart || end !== lastEnd)) {
    throw new Error('refusing to modify a context file with malformed Agent Manager markers');
  }

  const block = managedContext(port);
  if (start !== -1) {
    return current.slice(0, start)
      + block
      + current.slice(end + MANAGED_CONTEXT_END.length);
  }

  const separator = !current ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${block}\n`;
}

const canonical = (value) => {
  let existing = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try { existing = fs.realpathSync(existing); } catch {}
  return path.join(existing, ...tail);
};

const inside = (candidate, root) => {
  const rel = path.relative(canonical(root), canonical(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const expandHome = (value, home) => {
  if (value === '~') return home;
  if (value.startsWith(`~${path.sep}`)) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(home, value);
};

/**
 * OpenClaw has no global instruction file outside its workspace. Its standard
 * Agent Manager workspace is private app state, so it is safe to manage there.
 * A custom workspace outside the dedicated OpenClaw home may be a user Git
 * repository; skip it rather than dirtying that repository.
 */
function openClawTarget(env, home) {
  const clawHome = env.OPENCLAW_HOME || home;
  const state = env.OPENCLAW_STATE_DIR || path.join(clawHome, '.openclaw');
  const configFile = path.join(state, 'openclaw.json');
  let workspace = path.join(state, 'workspace');

  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const agents = config?.agents || {};
    const entries = Array.isArray(agents.list) ? agents.list
      : Array.isArray(agents.entries) ? agents.entries : [];
    const selected = entries.find((entry) => entry?.default === true)
      || entries.find((entry) => entry?.id === 'main');
    const configured = selected?.workspace || agents.defaults?.workspace;
    if (typeof configured === 'string' && configured.trim()) {
      const value = configured.trim();
      if (value.includes('$') || (value.startsWith('~') && value !== '~' && !value.startsWith(`~${path.sep}`))) {
        return {
          target: null,
          skipped: { cli: 'openclaw', reason: 'custom workspace path cannot be resolved safely' },
        };
      }
      workspace = expandHome(value, clawHome);
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return {
        target: null,
        skipped: { cli: 'openclaw', reason: `cannot safely parse ${configFile}` },
      };
    }
  }

  if (![clawHome, state].some((root) => inside(workspace, root))) {
    return {
      target: null,
      skipped: { cli: 'openclaw', reason: 'custom workspace is outside the manager-owned OpenClaw home' },
    };
  }
  // OpenClaw commonly encourages users to version its workspace. Once it is a
  // repository, leave it entirely operator-owned; an existing managed block
  // remains usable because AM_PORT overrides its baked-in fallback at runtime.
  if (fs.existsSync(path.join(workspace, '.git'))) {
    return {
      target: null,
      skipped: { cli: 'openclaw', reason: 'workspace is a Git repository' },
    };
  }
  return { target: { cli: 'openclaw', file: path.join(workspace, 'AGENTS.md') }, skipped: null };
}

/**
 * Resolve only global/user instruction files. The Docker/Space entrypoint opts
 * in because it owns isolated CLI homes. Direct Node/systemd installs must set
 * AM_MANAGE_GLOBAL_CONTEXT=1 explicitly before we touch the operator's user
 * configuration; an ordinary local development server is therefore a no-op.
 */
export function globalContextTargets(env = process.env) {
  if (env.AM_MANAGE_GLOBAL_CONTEXT !== '1') return { targets: [], skipped: [] };
  const home = env.HOME || os.homedir();
  const targets = [];
  const skipped = [];
  targets.push({
    cli: 'claude',
    file: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'CLAUDE.md'),
  });
  targets.push({
    cli: 'codex',
    file: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md'),
  });
  targets.push({
    cli: 'gemini',
    file: path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'GEMINI.md'),
  });
  const openCode = env.OPENCODE_CONFIG_DIR
    || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  targets.push({ cli: 'opencode', file: path.join(openCode, 'AGENTS.md') });
  // USER.md is a global frozen prompt snapshot. Unlike SOUL.md, creating it
  // does not replace Hermes's built-in identity on a first-ever launch.
  targets.push({
    cli: 'hermes',
    file: path.join(env.HERMES_LIVE || path.join(home, '.hermes'), 'memories', 'USER.md'),
  });
  const claw = openClawTarget(env, home);
  if (claw.target) targets.push(claw.target);
  if (claw.skipped) skipped.push(claw.skipped);
  return { targets, skipped };
}

/** Write/refresh global context without touching any session/project folder. */
export function writeGlobalContextFiles(env = process.env, port) {
  const { targets, skipped } = globalContextTargets(env);
  const written = [];
  for (const { cli, file } of targets) {
    try {
      let current = '';
      try { current = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
      const next = mergeManagedContext(current, port);
      if (next === current) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
      written.push(file);
    } catch (e) {
      skipped.push({ cli, reason: e && e.message ? e.message : String(e) });
      console.error('[context-files]', file, e && e.message);
    }
  }
  for (const item of skipped) console.warn('[context-files]', item.cli, item.reason);
  return { written, skipped };
}
