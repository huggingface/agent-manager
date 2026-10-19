// The app's live event channel: one WebSocket (`/ws?events=1`) on which the
// server pushes a session's state the moment it changes and a pulse when its
// transcript grows. See server/src/live-events.js. Everything here is an
// accelerator: the polls stay, so a closed or refused socket only means the
// app is as slow as it was before, never wrong.
import type { InputRequired, SessionState } from '../types';
import { LOCKED_CLOSE_CODE } from './lockStatus';

export interface LiveState { state: SessionState; running: boolean; inputRequired: InputRequired | null }
export type LiveEvent =
  | ({ t: 'state'; id: string } & LiveState)
  | { t: 'states'; states: Record<string, LiveState> }
  // `watched`: from a watch on the file, rather than a turn ending.
  | { t: 'trace'; id: string; watched?: boolean };

const listeners = new Set<(event: LiveEvent) => void>();
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let wanted = false;
let open = false;

/** Whether pushes are arriving now, so a poll may relax to a backstop pace. */
export const liveConnected = () => open;

function connect() {
  if (!wanted || socket || typeof WebSocket === 'undefined') return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?events=1`);
  socket = ws;
  ws.onopen = () => { open = true; failures = 0; };
  ws.onmessage = (e) => {
    let event: LiveEvent;
    try { event = JSON.parse(String(e.data)); } catch { return; }
    for (const fn of listeners) fn(event);
  };
  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    open = false;
    // A locked server refuses until it reopens; the app's status poll
    // re-enables the channel then (setLiveEvents).
    if (e.code === LOCKED_CLOSE_CODE) { wanted = false; return; }
    if (!wanted) return;
    failures++;
    retry = setTimeout(() => { retry = null; connect(); }, Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
  };
}

/** Open (true) or close (false) the channel; the app follows its lock state. */
export function setLiveEvents(on: boolean) {
  wanted = on;
  if (on) { connect(); return; }
  if (retry) { clearTimeout(retry); retry = null; }
  const ws = socket; socket = null; open = false;
  try { ws?.close(); } catch { /* already closed */ }
}

export function onLiveEvent(fn: (event: LiveEvent) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
