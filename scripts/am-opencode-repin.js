import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SAFE = /^[A-Za-z0-9_-]+$/;

function paneIdentity() {
  const amId = process.env.AM_ID;
  const runId = process.env.AM_RUN_ID;
  if (process.env.AM_CLI !== 'opencode' || !SAFE.test(amId || '') || !SAFE.test(runId || '')) return null;
  if (String(process.pid) !== process.env.AM_PANE_PID) return null;
  return { amId, runId };
}

function report(sessionID, cwd, source) {
  const identity = paneIdentity();
  if (!identity) return;
  const { amId, runId } = identity;
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

function syncInputRequired(pending) {
  const identity = paneIdentity();
  if (!identity) return;
  const { amId, runId } = identity;
  const dir = process.env.AM_INPUT_REQUIRED_DIR || path.join(os.tmpdir(), 'am-input-required');
  const file = path.join(dir, `${amId}.json`);
  const item = pending.values().next().value;
  if (!item) {
    try {
      const existing = JSON.parse(readFileSync(file, 'utf8'));
      if (existing?.runId === runId && existing?.source === 'opencode-event') unlinkSync(file);
    } catch { /* already absent or no longer ours */ }
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({
      amId,
      runId,
      cli: 'opencode',
      kind: item.kind,
      source: 'opencode-event',
      requestId: item.id,
      at: item.at,
    }));
    renameSync(tmp, file);
  } catch { /* an attention signal must never interfere with the TUI */ }
}

// OpenCode creates a new root session for /new (alias /clear). chat.message
// additionally follows an explicit switch to an existing session; runner.js
// verifies that id against the database and rejects child/subagent sessions.
export const AgentManagerRepin = async ({ directory }) => {
  // OpenCode's own TUI uses the same asked/replied event pairs. Keep every
  // queued request: resolving one must not hide another waiting behind it.
  const pending = new Map();

  const changed = () => syncInputRequired(pending);
  const drop = (id) => {
    if (!id || !pending.delete(id)) return;
    changed();
  };

  return ({
    event: async ({ event }) => {
      const props = event?.properties || {};
      if (event?.type === 'session.created') {
        const info = props.info;
        if (info?.id && !info.parentID) report(info.id, info.directory || directory, 'session.created');
        return;
      }
      if (event?.type === 'permission.asked' || event?.type === 'question.asked') {
        if (!props.id || pending.has(props.id)) return;
        pending.set(props.id, {
          id: props.id,
          sessionID: props.sessionID,
          kind: event.type === 'question.asked' ? 'question' : 'permission',
          tool: props.tool || null,
          at: Date.now(),
        });
        changed();
        return;
      }
      if (event?.type === 'permission.replied'
        || event?.type === 'question.replied'
        || event?.type === 'question.rejected') {
        drop(props.requestID);
        return;
      }
      // A Question tool can complete without question.replied. OpenCode's TUI
      // has this same recovery path; mirror it so the marker cannot stick.
      if (event?.type === 'message.part.updated') {
        const part = props.part;
        if (part?.type !== 'tool' || part.tool !== 'question'
          || (part.state?.status !== 'completed' && part.state?.status !== 'error')) return;
        let dirty = false;
        for (const [id, item] of pending) {
          if (item.kind !== 'question' || !item.tool) continue;
          if (item.tool.messageID === part.messageID && item.tool.callID === part.callID) {
            pending.delete(id);
            dirty = true;
          }
        }
        if (dirty) changed();
      }
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
};
