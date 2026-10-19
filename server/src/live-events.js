// Live session events for browsers, over the existing WebSocket endpoint
// (`/ws?events=1`). The sidebar, Overview and reader used to learn that an
// agent started or stopped working, or wrote to its transcript, from their next
// poll — 2.5 to 8 seconds later. The server already knows the moment it
// happens (runner.onActivity), so it says so here:
//
//   {t:'state', id, state, running, inputRequired}   a session's state changed
//   {t:'trace', id}                                  its transcript grew
//
// On connect the client gets one {t:'states', states:{id: {...}}} snapshot.
// Polls stay as the backstop for everything else (names, groups, digests) and
// for any event this channel misses while reconnecting.
//
// Cost: state events are computed for one session at a time on a transition,
// never on a timer. Transcripts are watched with fs.watch (inotify) on the
// live CLI files — local disk, not the bucket — and only while a browser is
// connected, so nothing here polls the mount.
import fs from 'node:fs';

// A transcript is often appended several records in one burst; one pulse at
// the start and one at the end of the burst is what a reader needs.
const TRACE_PULSE_GAP_MS = Number(process.env.AM_TRACE_PULSE_GAP_MS || 150);
// Claude creates its transcript on the first prompt, so a pane that has just
// started working may not have one yet. Look again at this pace while it works.
const TRACE_RESOLVE_RETRY_MS = 1000;
const WATCHED_CLIS = new Set(['claude', 'codex', 'fx', 'openclaw']);

export function createLiveEvents({ list, get, stateOf, traceFileOf, onActivity }) {
  const clients = new Set();
  const last = new Map();      // id -> JSON of the last state broadcast
  const watches = new Map();   // id -> { file, watcher, lastPulse, timer, retry, resolving }

  const send = (ws, msg) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(msg); } catch {}
  };
  const broadcast = (obj) => {
    if (!clients.size) return;
    const msg = JSON.stringify(obj);
    for (const ws of clients) send(ws, msg);
  };

  function check(id) {
    const s = get(id);
    if (!s) { last.delete(id); return; }
    const now = stateOf(s);
    const key = JSON.stringify(now);
    if (last.get(id) === key) return;
    last.set(id, key);
    broadcast({ t: 'state', id, ...now });
  }

  function pulse(id) {
    const w = watches.get(id);
    if (!w) { broadcast({ t: 'trace', id }); return; }
    const since = Date.now() - w.lastPulse;
    const fire = () => { w.lastPulse = Date.now(); broadcast({ t: 'trace', id, watched: !!w.watcher }); };
    if (since >= TRACE_PULSE_GAP_MS && !w.timer) { fire(); return; }
    if (w.timer) return;
    w.timer = setTimeout(() => { w.timer = null; fire(); }, Math.max(0, TRACE_PULSE_GAP_MS - since));
    if (w.timer.unref) w.timer.unref();
  }

  function unwatch(id) {
    const w = watches.get(id);
    if (!w) return;
    try { w.watcher?.close(); } catch {}
    clearTimeout(w.timer); clearTimeout(w.retry);
    watches.delete(id);
  }

  // Find the session's transcript and watch it. Re-run when a turn starts, so a
  // /clear that moved the conversation to a new file is picked up.
  async function watch(id) {
    if (!clients.size) return;
    const s = get(id);
    if (!s || !WATCHED_CLIS.has(s.cli)) return;
    let w = watches.get(id);
    if (!w) { w = { file: null, watcher: null, lastPulse: 0, timer: null, retry: null, resolving: false }; watches.set(id, w); }
    if (w.resolving) return;
    w.resolving = true;
    let file = null;
    try { file = await traceFileOf(s); } catch { file = null; }
    w.resolving = false;
    if (watches.get(id) !== w) return;
    if (!file) {
      clearTimeout(w.retry);
      if (stateOf(s).state === 'working') {
        w.retry = setTimeout(() => { w.retry = null; void watch(id); }, TRACE_RESOLVE_RETRY_MS);
        if (w.retry.unref) w.retry.unref();
      }
      return;
    }
    if (file === w.file && w.watcher) return;
    try { w.watcher?.close(); } catch {}
    w.file = file; w.watcher = null;
    try {
      w.watcher = fs.watch(file, { persistent: false }, (type) => {
        pulse(id);
        // A replaced file ends this watch; find the new one.
        if (type === 'rename') { try { w.watcher?.close(); } catch {} w.watcher = null; void watch(id); }
      });
      w.watcher.on('error', () => { try { w.watcher?.close(); } catch {} w.watcher = null; });
      // The file may have been created or grown while we were looking for it.
      pulse(id);
    } catch {
      w.watcher = null; // unsupported here: readers fall back to their poll
    }
  }

  onActivity((id, cause) => {
    check(id);
    if (!clients.size) return;
    if (cause === 'working' || cause === 'start') void watch(id);
    else if (cause === 'quiet') {
      // The turn is over: one last read catches a final record that a missed
      // or unsupported watch would otherwise leave to the poll.
      pulse(id);
      if (!watches.get(id)?.watcher) void watch(id);
    } else if (cause === 'exit') { pulse(id); unwatch(id); }
  });

  function addClient(ws) {
    clients.add(ws);
    const states = {};
    for (const s of list()) {
      const now = stateOf(s);
      last.set(s.id, JSON.stringify(now));
      states[s.id] = now;
    }
    send(ws, JSON.stringify({ t: 'states', states }));
    for (const s of list()) if (stateOf(s).running) void watch(s.id);
    ws.on('close', () => {
      clients.delete(ws);
      if (!clients.size) for (const id of [...watches.keys()]) unwatch(id);
    });
  }

  return { addClient, check, clients };
}
