// Non-secret protocol marker, not an identity or credential. Browser preflights
// cannot obtain permission from unrelated origins. Native clients use the same
// header within the deployment's existing private access boundary.
export const REQUEST_HEADER = 'x-am-request';
export const REQUEST_VALUE = '1';

export function requestHeaders(init: HeadersInit | undefined, method: string): Headers {
  const headers = new Headers(init);
  headers.set(REQUEST_HEADER, REQUEST_VALUE);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) headers.set('x-am-origin', 'operator');
  return headers;
}
