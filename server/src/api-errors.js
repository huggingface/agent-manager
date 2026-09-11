import { randomUUID } from 'node:crypto';

export const statusCode = (status) => ({
  400: 'bad-request', 403: 'forbidden', 404: 'not-found', 409: 'conflict',
  413: 'payload-too-large', 415: 'unsupported-media-type', 429: 'rate-limited',
}[status] || (status >= 500 ? 'internal-error' : 'request-failed'));

// Only explicitly public failures may expose a domain message. An arbitrary
// Error.status/statusCode from a library is not permission to expose its text.
export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.statusCode = status;
    this.code = code;
    this.data = data;
  }
}

export const invalid = (field, message) => new ApiError(400, 'invalid-input', `${field}: ${message}`, {
  details: [{ field, message }],
});

// A 5xx message is always replaced below, but a route may deliberately name the
// relative file whose operation failed. Keep that diagnostic narrow: an
// absolute/container path, traversal, markup or control text is not public
// merely because an old local catch put it in a JSON field.
const publicFailurePath = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= 256
  && !/^(?:[/\\]|[a-z]:)/i.test(value)
  && !/[\\<>\u0000-\u001f]/.test(value)
  && value.split('/').every((part) => part && part !== '.' && part !== '..');

const public5xxDetails = (body) => {
  if (!Array.isArray(body?.details)) return undefined;
  const details = body.details.slice(0, 4)
    .filter((item) => item && typeof item === 'object'
      && item.field === 'path' && publicFailurePath(item.message))
    .map(({ field, message }) => ({ field, message }));
  return details.length ? details : undefined;
};

// Express 4 catches synchronous throws, but not returned promises. `next` is
// once-only even for a handler that forwards an error and subsequently rejects.
export function asyncHandler(handler) {
  return (req, res, next) => {
    let forwarded = false;
    const forward = (error) => {
      if (forwarded) return;
      forwarded = true;
      next(error);
    };
    const fail = (error) => forward(error instanceof Error ? error : new Error('request failed'));
    try { Promise.resolve(handler(req, res, forward)).catch(fail); }
    catch (error) { fail(error); }
  };
}

// An explicit registration facade, not a patch to Express. Parsers still run
// before validation; successful bodies/streams are never JSON-wrapped.
export function apiRoutes(app, validate) {
  return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (route, ...handlers) => {
    const action = handlers.pop();
    app[method](route, ...handlers.map(asyncHandler), asyncHandler((req, res, next) => {
      validate(req, route);
      next();
    }), asyncHandler(action));
  }]));
}

// Install after the audit middleware: its res.json wrapper must see the final
// safe envelope, not the arbitrary exception an old local catch handed us.
export function errorEnvelope(_req, res, next) {
  const json = res.json;
  res.json = function (body) {
    if (res.writableEnded || res.destroyed) return this;
    if (res.statusCode >= 400) {
      if (res.statusCode >= 500) {
        const details = public5xxDetails(body);
        body = { error: 'The request could not be completed. Please try again.', code: 'internal-error', requestId: randomUUID(),
          ...(details ? { details } : {}) };
      } else {
        body = { ...body, error: typeof body?.error === 'string' ? body.error : 'The request was refused.',
          code: typeof body?.code === 'string' ? body.code : statusCode(res.statusCode) };
      }
    }
    return json.call(this, body);
  };
  next();
}

export function apiNotFound(req, res, next) {
  if (req.path !== '/api' && !req.path.startsWith('/api/')) return next();
  res.status(404).json({ error: 'API route not found.', code: 'api-not-found' });
}

export function apiErrorHandler(error, req, res, next) {
  if (req.path !== '/api' && !req.path.startsWith('/api/')) return next(error);
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  // A download may have prepared headers without writing its first byte.
  for (const header of ['content-length', 'content-type', 'content-disposition', 'content-encoding']) res.removeHeader(header);
  let failure = error;
  if (!(failure instanceof ApiError)) {
    const parser = {
      'entity.parse.failed': [400, 'invalid-json', 'Request body must be valid JSON.'],
      'entity.too.large': [413, 'payload-too-large', 'Request body is too large.'],
      'encoding.unsupported': [415, 'unsupported-media-type', 'Request encoding is not supported.'],
      'charset.unsupported': [415, 'unsupported-media-type', 'Request charset is not supported.'],
      'request.size.invalid': [400, 'bad-request', 'Request body size is invalid.'],
      'request.aborted': [400, 'request-aborted', 'Request body was interrupted.'],
    }[error?.type];
    failure = parser ? new ApiError(...parser)
      : error instanceof URIError ? new ApiError(400, 'invalid-path', 'Request path is malformed.')
      : new ApiError(500, 'internal-error', 'The request could not be completed. Please try again.');
  }
  const data = {};
  for (const key of ['details', 'reason', 'hits', 'mtime', 'tag', 'currentTag', 'retryAfter']) {
    if (failure.data[key] !== undefined) data[key] = failure.data[key];
  }
  res.status(failure.statusCode).json({ ...data, error: failure.message, code: failure.code });
}

// Attach before piping. Errors before bytes become JSON; errors after bytes
// terminate the stream. Disconnects release the source without a second reply.
export function pipeResponse(source, req, res, next) {
  let failed = false;
  const close = () => source.destroy();
  const cleanup = () => res.off('close', close);
  source.on('error', (error) => { if (!failed) { failed = true; cleanup(); source.destroy(); next(error); } });
  source.once('end', cleanup);
  res.once('close', close);
  source.pipe(res);
}
