// Request intent, not authentication. The private deployment/edge still owns
// access. Never derive trusted origins from request or forwarded headers.
export const REQUEST_HEADER = 'x-am-request';
export const REQUEST_VALUE = '1';
export const REQUEST_HEADERS = Object.freeze({ [REQUEST_HEADER]: REQUEST_VALUE });

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::[0-9]+)?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname || url.origin === 'null') return null;
    return url.origin;
  } catch { return null; }
}

function port(value, fallback) {
  const text = String(value ?? fallback);
  if (!/^[1-9]\d*$/.test(text) || Number(text) > 65535) throw new Error('Invalid request-policy port configuration');
  return text;
}

function originsSetting(value) {
  if (value === undefined) return [];
  const values = value.split(',').map((item) => normalizeOrigin(item.trim()));
  if (values.some((item) => !item)) throw new Error('AM_ALLOWED_ORIGINS must contain exact http(s) origins without paths');
  return values;
}

export function createRequestPolicy(env = process.env) {
  const backendPort = port(env.PORT, 7860);
  const loopbacks = ['localhost', '127.0.0.1', '[::1]'];
  const backendOrigins = loopbacks.map((host) => `http://${host}:${backendPort}`);
  const origins = new Set(originsSetting(env.AM_ALLOWED_ORIGINS));
  if (env.SPACE_HOST) {
    const spaceOrigin = normalizeOrigin(`https://${env.SPACE_HOST}`);
    if (!spaceOrigin) throw new Error('SPACE_HOST must be a host, optionally with a port');
    origins.add(spaceOrigin);
  } else if (env.SPACE_ID) {
    throw new Error('SPACE_HOST is required in a Space deployment');
  } else if (env.NODE_ENV !== 'production' && env.AM_ALLOWED_ORIGINS === undefined) {
    const vitePort = port(env.AM_DEV_PORT, 5173);
    for (const origin of [...backendOrigins, ...loopbacks.map((host) => `http://${host}:${vitePort}`)]) {
      origins.add(normalizeOrigin(origin));
    }
  }
  if (!origins.size) throw new Error('Configure AM_ALLOWED_ORIGINS for this production deployment');
  // The edge must preserve the configured public Host or use this exact local
  // upstream authority. Loopback target membership does NOT authorize callers.
  const hosts = new Set([...origins, ...backendOrigins].flatMap((origin) => {
    const url = new URL(origin);
    return [url.host, `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`];
  }));
  return { origins, hosts };
}

function singleHeader(req, name) {
  let count = 0;
  for (let i = 0; i < (req.rawHeaders?.length || 0); i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  const value = req.headers[name];
  return count > 1 || Array.isArray(value) ? { invalid: true } : { value };
}

function allowedHost(value, policy) {
  if (typeof value !== 'string') return false;
  const origin = normalizeOrigin(`http://${value}`);
  const parts = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(value);
  if (!origin || !parts) return false;
  const host = new URL(origin).hostname;
  const authority = parts[2] === undefined ? host : `${host}:${Number(parts[2])}`;
  return policy.hosts.has(authority);
}

// null means admitted; otherwise return only a bounded reason code. Do not log
// caller strings, query parameters, credentials or rejected request contents.
export function admissionFailure(req, policy, { websocket = false } = {}) {
  const names = ['host', 'origin', REQUEST_HEADER, 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];
  const headers = {};
  for (const name of names) {
    const header = singleHeader(req, name);
    if (header.invalid) return 'ambiguous-header';
    headers[name] = header.value;
  }
  if (!allowedHost(headers.host, policy)) return 'untrusted-target';
  const origin = headers.origin;
  if (origin !== undefined && !policy.origins.has(normalizeOrigin(origin))) return 'untrusted-origin';

  const site = headers['sec-fetch-site'];
  const mode = headers['sec-fetch-mode'];
  const dest = headers['sec-fetch-dest'];
  if (site !== undefined && !['same-origin', 'same-site', 'cross-site', 'none'].includes(site)) return 'fetch-metadata';
  if (mode !== undefined && !(websocket ? ['websocket'] : ['cors', 'same-origin']).includes(mode)) return 'fetch-metadata';
  if (dest !== undefined && dest !== 'empty') return 'fetch-metadata';
  if (headers['sec-fetch-user'] !== undefined) return 'fetch-metadata';
  // Exact app Origin wins over cross-site ancestor metadata. Without Origin,
  // native clients have no metadata; same-origin browser GET fetches may omit
  // Origin. Neither same-site nor cross-site evidence grants a native exception.
  if (origin === undefined && site !== undefined && site !== 'same-origin') return 'origin-required';
  if (!websocket || origin === undefined) {
    if (headers[REQUEST_HEADER] !== REQUEST_VALUE) return 'request-marker-required';
  }
  return null;
}

export function protectedRead(pathname) {
  // Express routes are case-insensitive and accept a trailing slash. Protect
  // HEAD too: Express falls back to GET handlers. Gate the whole messages route
  // so query-parser changes cannot turn a supposedly harmless read into contact.
  return /^\/api\/remote\/[^/]+\/(stream|messages)\/?$/i.test(pathname)
    || /^\/api\/(update\/check|backup\/status|share\/access)\/?$/i.test(pathname)
    || /^\/api\/sessions\/[^/]+\/share\/?$/i.test(pathname);
}

export function rejection(reason) {
  return {
    code: 'request-not-allowed', reason,
    error: 'Request not allowed. Reload the app to update its client. API scripts must send X-AM-Request: 1; check the configured app origin/host. Do not retry an uncertain action automatically.',
  };
}

export function requestAdmission(policy) {
  return (req, res, next) => {
    // No cross-origin API CORS grants. The Vite/custom proxy serves app and API
    // at one browser origin; a parent iframe does not need CORS privileges.
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (['GET', 'HEAD'].includes(req.method) && !protectedRead(req.path)) return next();
    const reason = admissionFailure(req, policy);
    if (reason) return res.status(403).set('Cache-Control', 'no-store').json(rejection(reason));
    next();
  };
}

export function terminalUpgrade(wss, policy) {
  return (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    // Match the old ws server's exact pathname behavior without parsing an
    // attacker-controlled authority as a trusted origin.
    if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
    const reason = admissionFailure(req, policy, { websocket: true });
    if (reason) {
      const body = JSON.stringify(rejection(reason));
      socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
}
