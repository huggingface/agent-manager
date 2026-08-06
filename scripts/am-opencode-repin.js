import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SAFE = /^[A-Za-z0-9_-]+$/;

async function report(sessionID, cwd, source) {
  const amId = process.env.AM_ID;
  const runId = process.env.AM_RUN_ID;
  if (process.env.AM_CLI !== 'opencode' || !SAFE.test(amId || '') || !SAFE.test(runId || '')) return;
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID || '') || typeof cwd !== 'string') return;
  const dir = process.env.AM_REPIN_DIR || path.join(os.tmpdir(), 'am-repin');
  const file = path.join(dir, `${amId}.opencode.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify({
      amId,
      runId,
      cli: 'opencode',
      payload: { session_id: sessionID, cwd, source },
    }));
    await rename(tmp, file);
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
    await report(info.id, info.directory || directory, 'session.created');
  },
  'chat.message': async ({ sessionID }) => {
    await report(sessionID, directory, 'chat.message');
  },
});
