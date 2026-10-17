// Shared by the offline configurator and the live transport. No process starts.
import {ApiError} from './api-errors.js';
export const EVENT_CLIS = new Set(['codex','claude','opencode','gemini','hermes','openclaw','fx','remote']);
export const eventFailure = (code, message = 'Session event delivery requires review.') => new ApiError(409,code,message);
export function localEventTarget(s) {
  if (!s || s.archivedAt || !s.sessionUuid || !EVENT_CLIS.has(s.cli) || s.cli === 'codex')
    throw eventFailure('event-target-unavailable');
  if (s.cli === 'remote' && !/^[A-Za-z0-9_-]{1,128}$/.test(s.remote?.name||'')) throw eventFailure('event-target-unavailable');
  return {sessionId:s.id,cli:s.cli,stamp:JSON.stringify([s.sessionUuid,s.cli,s.path??s.id,
    s.opencodeSessionId??null,s.fxSessionId??null,s.remote?.name??null])};
}
// Opt-in exact resume, deliberately separate from the interactive UI's launch
// policy. Never --continue, || fresh, onboarding, permissions or model changes.
export function exactEventResume(s) {
  if (!s.everStarted || s.pendingPrompt) throw eventFailure('event-resume-required');
  if (s.cli==='claude' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s.sessionUuid)) return `exec claude --resume '${s.sessionUuid}'`;
  if (s.cli==='opencode' && /^ses_[A-Za-z0-9]+$/.test(s.opencodeSessionId)) return `exec opencode --session '${s.opencodeSessionId}'`;
  if (s.cli==='fx' && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s.fxSessionId)) return `exec fx --resume '${s.fxSessionId}'`;
  throw eventFailure('event-resume-required');
}
