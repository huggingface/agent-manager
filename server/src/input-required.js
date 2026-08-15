import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const KINDS = new Set(['permission', 'question', 'confirmation']);
const MARKER_SOURCES = new Map([
  ['claude', new Set(['claude-notification'])],
  ['gemini', new Set(['gemini-notification'])],
  ['opencode', new Set(['opencode-event'])],
]);
const configuredMaxAge = Number(process.env.AM_INPUT_REQUIRED_MAX_AGE_MS);
const ONE_SHOT_MAX_AGE_MS = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
  ? configuredMaxAge : 30 * 60_000;

function markerDirectory() {
  return process.env.AM_INPUT_REQUIRED_DIR || path.join(os.tmpdir(), 'am-input-required');
}

function markerFile(id) {
  return SAFE_ID.test(id || '') ? path.join(markerDirectory(), `${id}.json`) : null;
}

function readMarker(id, runId, cli, now) {
  const file = markerFile(id);
  if (!file) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Number(value?.at);
    const source = typeof value?.source === 'string' ? value.source : '';
    if (value?.amId !== id || value?.runId !== runId || value?.cli !== cli
      || !KINDS.has(value?.kind) || !MARKER_SOURCES.get(cli)?.has(source)
      || !Number.isFinite(at) || at <= 0 || at > now + 60_000) return null;
    return {
      file,
      at,
      kind: value.kind,
      source,
      requestId: typeof value.requestId === 'string' ? value.requestId : '',
    };
  } catch { return null; }
}

function removeMatchingMarker(id, runId, cli, { oneShotOnly = false } = {}) {
  const marker = readMarker(id, runId, cli, Date.now());
  if (!marker || (oneShotOnly && marker.source === 'opencode-event')) return;
  try { fs.unlinkSync(marker.file); } catch {}
}

function publicState(current) {
  if (!current) return null;
  return {
    kind: current.kind,
    cli: current.cli,
    confidence: 'high',
    detectedAt: new Date(current.at).toISOString(),
  };
}

/**
 * Native interactive-dialog signals for one PTY launch.
 *
 * This intentionally has no screen-text or process-idle fallback. An agent can
 * print any prompt-looking text, and an event-loop TUI polls stdin while both
 * thinking and waiting. Only CLI lifecycle events enter this tracker.
 */
export function createInputRequiredTracker({ id, runId, cli, now = () => Date.now() }) {
  let current = null;
  let osc = '';

  const set = (kind, source, at, transport, token = '') => {
    current = { kind, source, at, transport, token, cli };
  };

  const get = () => {
    const time = now();
    const marker = readMarker(id, runId, cli, time);
    if (marker) {
      const paired = marker.source === 'opencode-event';
      if (!paired && time - marker.at > ONE_SHOT_MAX_AGE_MS) {
        removeMatchingMarker(id, runId, cli);
        if (current?.transport === 'marker') current = null;
      } else {
        const token = `${marker.source}:${marker.at}:${marker.requestId}:${marker.kind}`;
        if (current?.transport !== 'marker' || current.token !== token) {
          set(marker.kind, marker.source, marker.at, 'marker', token);
        }
      }
    } else if (current?.transport === 'marker') {
      current = null;
    }

    if (current?.transport === 'terminal' && time - current.at > ONE_SHOT_MAX_AGE_MS) current = null;
    return publicState(current);
  };

  const observeOutput = (chunk) => {
    if ((cli !== 'codex' && cli !== 'gemini') || !chunk) return;
    osc += String(chunk);
    // Codex emits these OSC 9 messages only after its TUI has installed the
    // corresponding approval/question view. Invocation-local config forces
    // the exact backend and enables only these two notification classes.
    const re = /\x1b\](9;|777;notify;)([^\x07\x1b]{1,2048})(?:\x07|\x1b\\)/g;
    let match;
    let consumed = 0;
    while ((match = re.exec(osc))) {
      consumed = re.lastIndex;
      const message = match[2];
      if (cli === 'codex') {
        if (message.startsWith('Plan mode prompt:')) {
          set('question', 'codex-notification', now(), 'terminal');
        } else if (message.startsWith('Approval requested:')
          || message.startsWith('Codex wants to edit ')
          || message.startsWith('Approval requested by ')) {
          set('permission', 'codex-notification', now(), 'terminal');
        }
      } else if (message.startsWith('Gemini CLI needs your attention')) {
        set(message.includes('Answer requested by agent') ? 'question' : 'confirmation',
          'gemini-notification', now(), 'terminal');
      } else if (message.startsWith('Gemini CLI session complete')) {
        removeMatchingMarker(id, runId, cli, { oneShotOnly: true });
        current = null;
      }
    }
    if (consumed) osc = osc.slice(consumed);
    if (osc.length > 4096) osc = osc.slice(-4096);
  };

  const observeInput = () => {
    // OpenCode has paired asked/replied events. Cursor movement in its menu is
    // still input but does not resolve the request, so only the paired event may
    // clear it. The other CLIs expose an exact open signal but no exact close;
    // any operator key clears them conservatively (a false negative is safer).
    const marker = readMarker(id, runId, cli, now());
    if (current?.source === 'opencode-event' || marker?.source === 'opencode-event') return;
    removeMatchingMarker(id, runId, cli, { oneShotOnly: true });
    current = null;
  };

  const close = () => {
    removeMatchingMarker(id, runId, cli);
    current = null;
    osc = '';
  };

  return { get, observeOutput, observeInput, close };
}
