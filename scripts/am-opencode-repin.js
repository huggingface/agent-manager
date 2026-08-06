import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SAFE = /^[A-Za-z0-9_-]+$/;

function report(sessionID, cwd, source) {
  const amId = process.env.AM_ID;
  const runId = process.env.AM_RUN_ID;
  if (process.env.AM_CLI !== 'opencode' || !SAFE.test(amId || '') || !SAFE.test(runId || '')) return;
  // The global plugin is also loaded by nested OpenCode processes. Only the
  // process that replaced the PTY's login shell owns this pane.
  if (String(process.pid) !== process.env.AM_PANE_PID) return;
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID || '') || typeof cwd !== 'string') return;
  const dir = process.env.AM_REPIN_DIR || path.join(os.tmpdir(), 'am-repin');
  const file = path.join(dir, `${amId}.opencode.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // OpenCode dispatches generic event hooks without awaiting their Promise.
    // Keep this tiny local write synchronous so /clear followed immediately by
    // quit cannot terminate the process between mkdir/write/rename.
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({
      amId,
      runId,
      cli: 'opencode',
      pluginPid: process.pid,
      payload: { session_id: sessionID, cwd, source },
    }));
    renameSync(tmp, file);
  } catch { /* telemetry must never interfere with the user's prompt */ }
}

// OpenCode creates a new root session for /new (alias /clear). chat.message
// additionally follows an explicit switch to an existing session; runner.js
// verifies that id against the database and rejects child/subagent sessions.
export const AgentManagerRepin = async ({ directory }) => ({
  event: async ({ event }) => {
    if (event?.type !== 'session.created') return;
    const info = event.properties?.info;
    if (!info?.id || info.parentID) return;
    report(info.id, info.directory || directory, 'session.created');
  },
  'chat.message': async ({ sessionID }) => {
    report(sessionID, directory, 'chat.message');
  },
  // Tool shells must not pass the pane's private attribution markers to an
  // agent launched inside them. Empty values override OpenCode's process.env
  // merge and make the nested plugin a no-op.
  'shell.env': async (_input, output) => {
    output.env.AM_ID = '';
    output.env.AM_RUN_ID = '';
    output.env.AM_CLI = '';
    output.env.AM_PANE_PID = '';
  },
});
