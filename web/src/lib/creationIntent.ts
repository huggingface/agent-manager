// Retain only a content fingerprint and UUID, never the prompt, until the
// server acknowledges creation. A reload or retry keeps the same identity.
export async function withCreationIntent<T>(payload: unknown, send: (requestId: string) => Promise<T>): Promise<T> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const digest = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const key = `am-codex-create:${digest}`;
  const acquire = () => {
    const previous = localStorage.getItem(key);
    if(previous && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(previous))throw new Error('The saved creation identifier is invalid. Review the existing task before creating another.');
    const id = previous || crypto.randomUUID();
    localStorage.setItem(key,id);
    if(localStorage.getItem(key)!==id)throw new Error('Could not save the creation identifier. No request was sent.');
    return id;
  };
  // Hold the lock only while allocating, so concurrent retries reach the server
  // with the same ID rather than queueing a second creation after success.
  const id = navigator.locks ? await navigator.locks.request(key,acquire) : acquire();
  const result = await send(id);
  // A storage cleanup failure must not turn a successful creation into failure.
  try { if(localStorage.getItem(key)===id)localStorage.removeItem(key); } catch { /* Retaining the ID is safe. */ }
  return result;
}
