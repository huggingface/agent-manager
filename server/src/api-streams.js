// The remote protocol is unchanged: a connected line, heartbeats, then one
// JSON line. Every event/timer enters the same request-scoped failure path.
export function remoteStream(req, res, next, remote, name, since, wait) {
  let done = false;
  let heartbeat, timer;
  let release = () => {};
  const cleanup = () => {
    clearInterval(heartbeat); clearTimeout(timer);
    res.off('close', close); res.off('error', fail);
    release();
  };
  const close = () => { if (!done) { done = true; cleanup(); } };
  const fail = (error) => {
    if (done) return;
    done = true;
    cleanup();
    next(error instanceof Error ? error : new Error('stream failed'));
  };
  const guard = (fn) => (...args) => { if (!done) { try { fn(...args); } catch (error) { fail(error); } } };
  const finish = guard((payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    res.end(line);
    close();
  });
  res.once('close', close);
  res.once('error', fail);
  guard(() => {
    // Fallible read before headers: failures can still be a structured reply.
    const pending = remote.pendingFor(name, since);
    res.set({ 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    res.write(':connected\n');
    release = remote.registerStream(name, {
      since,
      deliver: guard((messages) => finish({ messages, seq: messages[messages.length - 1].seq })),
      stop: guard((reason) => finish({ stop: true, reason: reason || 'disconnected from the manager' })),
    });
    if (done) { release(); return; } // a registration can synchronously close
    heartbeat = setInterval(guard(() => res.write(':hb\n')), remote.HEARTBEAT_MS);
    timer = setTimeout(guard(() => finish({ messages: [], seq: remote.lastSeq(name) })), wait * 1000);
    if (pending.length) {
      remote.markDelivered(name, pending[pending.length - 1].seq);
      finish({ messages: pending, seq: pending[pending.length - 1].seq });
    }
  })();
}
