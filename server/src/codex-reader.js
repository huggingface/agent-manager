// Resolve only the durably bound conversation. Reading never loads a thread,
// subscribes to approvals, starts a TUI, or falls back to a neighbouring CWD.
import fs from 'node:fs/promises';
import path from 'node:path';
import { codexBindings, configuredEndpoint, contextForThread } from './codex-context.js';
import { observationConfig, ObservationClient } from './codex-shared.js';
import { ApiError } from './api-errors.js';

const unavailable = () => new ApiError(503, 'codex-reader-unavailable',
  'The shared Codex transcript could not be verified. Retry when its server is available.');

export async function sharedCodexRollout(session, {
  bindings = codexBindings, config, connect = ObservationClient.connect,
} = {}) {
  const binding = bindings.forSession(session.id);
  if (!binding && !session.codexSharedOnly) return undefined; // legacy resolver
  let client, file;
  try {
    if (!binding) throw unavailable();
    config ??= observationConfig();
    const endpoint = configuredEndpoint(config);
    const check = () => {
      const context = contextForThread(binding.threadId, { sessions: [session], bindings, endpoint });
      if (context.amSessionId !== session.id) throw unavailable();
      return context;
    };
    const context = check();
    client = await connect(config);
    if (client.endpoint.home !== endpoint.home || client.endpoint.socket !== endpoint.socket) throw unavailable();
    const { thread } = await client.call('thread/read', { threadId: binding.threadId, includeTurns: false });
    if (thread?.id !== binding.threadId || thread.parentThreadId
        || await fs.realpath(thread.cwd) !== context.workdir || typeof thread.path !== 'string') throw unavailable();
    const rollout = await fs.realpath(thread.path);
    // The daemon supplies the path. Still reject external paths/symlinks and
    // verify the bounded header before handing it to the existing paged reader.
    const relative = path.relative(endpoint.home, rollout);
    if (!relative.startsWith('sessions' + path.sep) && !relative.startsWith('archived_sessions' + path.sep)) throw unavailable();
    if (path.extname(rollout) !== '.jsonl') throw unavailable();
    file = await fs.open(rollout, 'r');
    if (!(await file.stat()).isFile()) throw unavailable();
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) throw unavailable();
    const header = JSON.parse(buffer.toString('utf8', 0, newline));
    const meta = header?.payload;
    if (header.type !== 'session_meta' || meta?.id !== binding.threadId
        || meta.thread_source === 'subagent' || meta.source?.subagent
        || await fs.realpath(meta.cwd) !== context.workdir) throw unavailable();
    check();
    if (client.closed) throw unavailable();
    return rollout;
  } catch { throw unavailable(); }
  finally { await file?.close(); client?.close(); }
}
