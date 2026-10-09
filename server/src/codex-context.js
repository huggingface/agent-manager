import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './api-errors.js';
import { CodexBindings, CodexBindingError, endpointIdentity, validThreadId } from './codex-bindings.js';
import { observationConfig, ObservationClient } from './codex-shared.js';
import { DATA_DIR, WORKSPACES_DIR } from './config.js';

export const codexBindings = new CodexBindings(path.join(DATA_DIR, 'codex-bindings.json'));

// The endpoint identity is stable across a daemon restart, unlike its socket
// inode. No request can supply an endpoint; it comes from host configuration.
export function configuredEndpoint(config = observationConfig()) {
  if (!config) throw new ApiError(409, 'codex-not-configured', 'Configure the shared Codex endpoint first.');
  const home = fs.realpathSync(config.home);
  const socket = fs.realpathSync(config.socket);
  return { socket, home, id: endpointIdentity({ socket, home }) };
}
export function contextForThread(threadId, { sessions, bindings = codexBindings, endpoint = configuredEndpoint() }) {
  if (!validThreadId(threadId)) throw new ApiError(400, 'invalid-input', 'An exact Codex thread UUID is required.');
  const binding = bindings.resolve(endpoint.id, threadId);
  if (!binding) throw new ApiError(404, 'codex-unmapped', 'This Codex thread is not associated with an AM session.');
  const session = sessions.find((s) => s.id === binding.amSessionId);
  if (!session || session.cli !== 'codex' || session.sessionUuid !== binding.amSessionUuid
      || session.codexSessionId !== threadId) throw new ApiError(409, 'codex-binding-stale', 'The AM session no longer matches this binding.');
  const cwd = fs.realpathSync(path.join(WORKSPACES_DIR, session.path ?? session.id));
  if (cwd !== binding.cwd) throw new ApiError(409, 'codex-workspace-changed', 'The workspace no longer matches this binding.');
  return { amSessionId: session.id, name: session.name, threadId, endpointId: binding.endpointId,
    revision: binding.revision, workdir: cwd };
}

// This first slice completes attribution AFTER a manual handoff. It never
// resumes or closes anything. Only a thread already loaded on the configured
// server can be bound, and its old AM terminal must already be stopped.
export async function bindExistingThread({ sessionId, threadId, expectedRevision }, {
  getSession, sessions, isRunning, bindings = codexBindings,
  config = observationConfig(), connect = ObservationClient.connect, signal, beforeCommit = () => {},
}) {
  if (!validThreadId(threadId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ApiError(400, 'invalid-input', 'Pass threadId and an integer expectedRevision (0 for a first binding).');
  }
  const endpoint = configuredEndpoint(config);
  const initial = getSession(sessionId);
  if (!initial) throw new ApiError(404, 'not-found', 'AM session not found.');
  const stamp = JSON.stringify([initial.sessionUuid, initial.cli, initial.path, initial.codexSessionId]);
  const validateSession = () => {
    const s = getSession(sessionId);
    if (!s || JSON.stringify([s.sessionUuid, s.cli, s.path, s.codexSessionId]) !== stamp) {
      throw new ApiError(409, 'codex-session-changed', 'The AM session changed during verification.');
    }
    if (s.cli !== 'codex' || s.codexSessionId !== threadId) throw new ApiError(409, 'codex-pin-mismatch', 'The exact existing Codex pin must match.');
    if (isRunning(sessionId)) throw new ApiError(409, 'codex-terminal-running', 'Close this session’s old TUI gracefully before binding it.');
    if (s.pendingPrompt || s.pendingImagePaths?.length) throw new ApiError(409, 'codex-pending-input', 'Resolve the queued AM input before binding.');
    if (sessions().some((other) => other.id !== s.id && other.cli === 'codex' && other.codexSessionId === threadId)) {
      throw new ApiError(409, 'codex-pin-ambiguous', 'More than one AM session claims this thread.');
    }
    return s;
  };
  validateSession();
  let client;
  try {
    client = await connect(config, { signal });
    if (client.endpoint.socket !== endpoint.socket || client.endpoint.home !== endpoint.home) throw new ApiError(409, 'codex-endpoint-changed', 'The configured endpoint changed.');
    const result = await client.call('thread/read', { threadId, includeTurns: false });
    const thread = result?.thread;
    if (thread?.id !== threadId) throw new ApiError(409, 'codex-thread-mismatch', 'The server returned a different thread.');
    if (thread.status?.type !== 'idle') throw new ApiError(409, 'codex-handoff-required', 'The thread must already be loaded and idle on this server. No session was released.');
    const s = validateSession();
    const root = fs.realpathSync(WORKSPACES_DIR);
    const cwd = fs.realpathSync(path.join(WORKSPACES_DIR, s.path ?? s.id));
    if ((cwd !== root && !cwd.startsWith(root + path.sep)) || typeof thread.cwd !== 'string' || fs.realpathSync(thread.cwd) !== cwd) {
      throw new ApiError(409, 'codex-workspace-mismatch', 'The server and AM must use the same workspace.');
    }
    if (signal?.aborted || client.closed) throw new ApiError(409, 'codex-verification-lost', 'Connection lost before binding.');
    // Synchronous checks + durable write: no await between revalidation and commit.
    beforeCommit();
    return bindings.bind({ session: s, threadId, expectedRevision, cwd, endpointId: endpoint.id });
  } finally { client?.close(); }
}

export function contextError(error) {
  if (error instanceof ApiError) return error;
  const reason = error instanceof CodexBindingError ? error.code : 'verification-unavailable';
  const conflict = ['binding-conflict', 'bindings-busy'].includes(reason);
  return new ApiError(conflict ? 409 : 503, 'codex-context-unavailable', 'Codex context could not be verified or saved.', { reason });
}
