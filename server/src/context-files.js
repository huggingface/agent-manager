import fs from 'node:fs';
import path from 'node:path';

// Start-of-session context for every agent CLI, without relying on skills
// support. Claude Code walks up from its cwd and loads CLAUDE.md; Codex and
// opencode do the same with AGENTS.md (and fall back to their global config
// dirs when the workspace folder is not a git repository). Writing both files
// at the workspaces root therefore puts the agent-interop basics — the local
// HTTP API, the peer states, the etiquette — into every new session's context
// from its first turn, for every CLI, in every deployment.
//
// The full guide remains the `environment` skill (index.js#generateEnvSkill);
// these files are the short pointer that is guaranteed to be seen. They are
// app-owned and regenerated on boot: operator edits belong in the skill, not
// here, which the header of the generated file says out loud.

const CONTEXT = (port) => `# Agent Manager environment

*(App-owned file, rewritten by Agent Manager on every boot — do not edit.
It applies when running inside Agent Manager, i.e. when \`$AM_ID\` is set;
otherwise ignore it.)*

You are one terminal session inside **Agent Manager**. Other AI sessions may
run in sibling folders under this workspaces directory — you can see, watch,
and message them. The full guide is the \`environment\` skill distributed to
your skills directory; the essentials:

You are \`$AM_ID\` (display name \`$AM_NAME\`), talking to the manager on
\`localhost:\${AM_PORT:-${port}}\`.

\`\`\`sh
# Who is here (state, folder, last prompt/answer, trace path):
curl -s "http://localhost:\${AM_PORT:-${port}}/api/agents?from=$AM_ID" | jq .

# Watch a peer instead of polling it:
curl -s "http://localhost:\${AM_PORT:-${port}}/api/agents/$ID/tail?lines=120" | jq -r .text
curl -s "http://localhost:\${AM_PORT:-${port}}/api/agents/$ID/wait?timeout=120"   # blocks until it stops working

# Message a peer (body = the prompt):
curl -s -X POST "http://localhost:\${AM_PORT:-${port}}/api/agents/$ID/prompt?from=$AM_ID" \\
  -H 'content-type: text/plain' --data-binary 'your message'
\`\`\`

Rules that matter:

- States: \`working\` = leave it alone; \`waiting\` = safe to talk to;
  \`stopped\` = prompting wakes it (boots a CLI, costs money).
- Prompts you receive prefixed \`[message from <name>:]\` come from another
  agent, not from the operator.
- Use \`/wait\` rather than sleep-poll loops. Don't ping-pong with peers —
  send one clear, self-contained message.
- Stay in your own folder; never delete a sibling folder.
- Notify the operator (\`POST /api/notify\`) only when explicitly asked,
  exactly once per requested event.
`;

/**
 * Write AGENTS.md and CLAUDE.md at the workspaces root. Rewrites only when the
 * content changed, so FUSE-bucket writes stay rare and mtimes stay meaningful.
 */
export function writeWorkspaceContextFiles(workspacesDir, port) {
  const content = CONTEXT(port);
  const written = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(workspacesDir, name);
    try {
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch {}
      if (current !== content) {
        fs.writeFileSync(file, content);
        written.push(name);
      }
    } catch (e) {
      console.error('[context-files]', name, e && e.message);
    }
  }
  return written;
}
