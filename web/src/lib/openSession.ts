// Ask the app to open a session, from anywhere — the reader's dispatched-session
// icons use it from deep inside a conversation. App listens. Its own module so
// the app's entry chunk can import the name without importing the reader.
export const OPEN_SESSION_EVENT = 'am:open-session';
export const requestOpenSession = (id: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { id } }));
