// Explicit native protocol client for isolated integration fixtures. This adds
// intent only: attribution still belongs to each test and the real guard runs.
import WebSocket from 'ws';
import { REQUEST_HEADERS } from '../src/request-admission.js';

export function nativeFetch(input, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(REQUEST_HEADERS)) headers.set(name, value);
  return globalThis.fetch(input, { ...init, headers });
}

export class NativeWebSocket extends WebSocket {
  constructor(url, options = {}) {
    super(url, { ...options, headers: { ...REQUEST_HEADERS, ...options.headers } });
  }
}
