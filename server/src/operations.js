import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const OPERATIONS_FILE = path.join(DATA_DIR, 'operations.jsonl');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Reads worth auditing. A GET is normally none of this log's business — it
// changes nothing — but `wait` is the one read that IS an event between two
// agents: A blocked on B until B stopped working. Without it the log records
// work being handed out and nothing ever coming back, which is exactly half of
// "who called whom". Deliberately NOT here: `tail`, which every open pane polls
// constantly and which says nothing a resolved wait does not already say.
const LOGGED_READS = [/^\/api\/agents\/[^/]+\/wait$/];
const shouldLog = (req) => MUTATING.has(req.method)
  || (req.method === 'GET' && LOGGED_READS.some((re) => re.test(req.path)));
const MAX_TEXT = 500;
// Prompt text IS kept, on the operator's instruction: a log that can say who
// asked whom but never what they asked answers half the question. Only the
// routes that carry a prompt are unwrapped this way — a file write goes through
// the same summariser and its body stays a checksum, because "store the
// prompts" is not "store every byte that ever crossed the API".
const PROMPT_ROUTES = [
  /^\/api\/agents$/,                          // spawn: the body IS the seed prompt
  /^\/api\/sessions$/,                        // same, as a `prompt` field
  /^\/api\/agents\/[^/]+\/prompt$/,
  /^\/api\/sessions\/[^/]+\/input$/,
  /^\/api\/remote\/[^/]+\/messages$/,        // the same act, for a remote agent
];
const carriesPrompt = (req) => req && PROMPT_ROUTES.some((re) => re.test(req.path));
// A prompt is normally a screenful. This is not a cap on what an agent may send,
// only on what the audit file keeps verbatim: past it the text is cut and says
// so, while chars and sha256 still describe the whole thing.
const MAX_PROMPT = 64 * 1024;
const MAX_DEPTH = 5;
const SENSITIVE_KEY = /(authorization|credential|password|secret|subscription|token|endpoint|private.?key)/i;
const CONTENT_KEY = /(body|content|data|prompt|text)/i;

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function textSummary(value, keepText = false) {
  const summary = { present: value.length > 0, chars: value.length, sha256: digest(value) };
  // sha256 stays even with the text beside it: equal checksums are how you spot
  // the same prompt being sent again, which is what a schedule looks like.
  if (!keepText) return summary;
  return value.length > MAX_PROMPT
    ? { ...summary, text: value.slice(0, MAX_PROMPT), truncated: true }
    : { ...summary, text: value };
}

/**
 * Keep the parameters needed to reconstruct an operation without turning the
 * audit trail into a second store for prompts, file contents, or credentials.
 */
export function summarizePayload(value, key = '', depth = 0, keepText = false) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Buffer.isBuffer(value)) return { bytes: value.length, sha256: digest(value) };
  if (typeof value === 'string') {
    // A credential is never kept, prompt route or not.
    if (SENSITIVE_KEY.test(key)) return '[redacted]';
    if (CONTENT_KEY.test(key) || value.length > MAX_TEXT) return textSummary(value, keepText);
    return value;
  }
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => summarizePayload(v, key, depth + 1, keepText));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : summarizePayload(v, k, depth + 1, keepText);
    }
    return out;
  }
  return String(value);
}

function append(record) {
  try {
    fs.mkdirSync(path.dirname(OPERATIONS_FILE), { recursive: true });
    fs.appendFileSync(OPERATIONS_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (e) {
    // Auditing must never turn a successfully completed user operation into an
    // HTTP failure. Make storage trouble loud in the server log instead.
    console.error('[operations.append]', e && e.message);
  }
}

const requestOrigin = (req) => String(
  req.query?.from
  || req.headers?.['x-am-origin']
  || (req.body && !Array.isArray(req.body) && typeof req.body === 'object' ? req.body.from : '')
  || '',
).trim();

const cleanQuery = (query) => {
  const out = { ...(query || {}) };
  delete out.from;
  return summarizePayload(out, 'query');
};

/**
 * Require an attributable origin for every state-changing API request and
 * append its outcome to a durable JSONL log.
 *
 * resolveOrigin(raw, req) returns {id,type,name?,cli?}, or null when the id is
 * unknown. It may derive an identity from a protocol route (remote agents do
 * this for backwards compatibility with already-running polling loops).
 */
export function operationMiddleware({ resolveOrigin, resolveTarget, allowMissing = false } = {}) {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/') || !shouldLog(req)) return next();

    const raw = requestOrigin(req);
    let origin = resolveOrigin ? resolveOrigin(raw, req) : (raw ? { id: raw, type: 'unknown' } : null);
    if (!origin && allowMissing) origin = { id: 'test', type: 'test' };
    // A logged READ is never refused for want of an origin. `wait` is documented
    // as read-only and every watch loop running right now calls it without
    // `?from=`; rejecting those would break them the moment this ships. An
    // unattributed wait still records that someone finished waiting on B.
    if (!origin && MUTATING.has(req.method)) {
      return res.status(400).json({
        error: raw
          ? `unknown origin '${raw}'`
          : 'from required — mutating calls must pass ?from=<origin id> (agents use $AM_ID)',
      });
    }

    if (origin) req.operationOrigin = origin;
    // BEFORE next(), not at response time: the handler for a delete removes the
    // session from the store and only then answers, so resolving this later
    // recorded `{id}` for a session whose name and cli had just been thrown
    // away — the one operation where the roster can never fill them back in.
    // A request-time snapshot also gives a rename the name it had when the call
    // arrived, which is the state the entry is describing.
    const target = resolveTarget ? resolveTarget(req) : null;
    const started = Date.now();
    const operationId = crypto.randomUUID();
    let responseBody;
    let recorded = false;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };
    const record = () => {
      if (recorded) return;
      recorded = true;
      // A wait is a polling loop: only the call that RESOLVED is an event. The
      // ones that timed out say "still working", which the log already implies,
      // and logging them would multiply the entries by however long the job ran.
      // Same for a wait the caller abandoned (no body) or one whose target had
      // already gone: nothing came back, so there is nothing to draw.
      if (!MUTATING.has(req.method) && !(responseBody && responseBody.matched === true)) return;
      append({
        version: 1,
        id: operationId,
        at: new Date(started).toISOString(),
        origin,
        // Who it was done TO, snapshotted above. The id is in the path already,
        // but a name read back later is the name the session has NOW — renamed
        // or deleted, and the audit trail stops making sense.
        ...(target ? { target } : {}),
        method: req.method,
        path: req.path,
        query: cleanQuery(req.query),
        request: summarizePayload(req.body, 'body', 0, carriesPrompt(req)),
        status: res.statusCode,
        ok: res.statusCode < 400,
        durationMs: Date.now() - started,
        result: summarizePayload(responseBody, 'result'),
      });
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  };
}

export function readOperations(limit = 200, before = null) {
  const take = Math.max(1, Math.min(1000, Number(limit) || 200));
  let fd;
  try {
    fd = fs.openSync(OPERATIONS_FILE, 'r');
    const size = fs.fstatSync(fd).size;
    // A bounded tail keeps this endpoint cheap even after years of operations.
    // Four MiB comfortably holds the maximum 1,000 compact records in normal use.
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const rows = text.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    // Sort, do not merely reverse. A record is appended when its response
    // finishes, but `at` is when the request STARTED — and a `wait` can block
    // for five minutes, so it lands in the file after calls that began later and
    // finished sooner. Reversing append order therefore returned rows out of
    // chronological order, which put an old wait above newer calls in the log
    // and, because the map derives its x from rank, could run its time axis
    // backwards. Ties keep newest-appended first, which is what reversing did.
    return rows
      .filter((row) => !before || row.at < before)
      .reverse()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, take);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
