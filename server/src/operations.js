import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import {
  AUDIT_CREDENTIAL_POLICY, REDACTED_CREDENTIAL, createCredentialFilter, isSensitiveAuditKey,
} from './audit-credentials.js';

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
// The body is stored WHOLE, on the operator's instruction: "just store all the
// full api calls. why this arbitrary compression." So there is no allowlist of
// routes, no size cap, and nothing is replaced by a summary of itself. The one
// thing still withheld is a credential — that is not compression, it is not
// writing secrets into a file that lives on the bucket.
//
// Above this length a string is stored as {present, chars, sha256, text} rather
// than as a bare string. Nothing is lost either way: this only decides whether
// the checksum travels beside the value, and `chars` is what the log's compact
// list column reads.
const MAX_TEXT = 500;
// How far back a read will go looking for complete records. One enormous entry
// must not hide the log, and reading a whole year of it must not exhaust memory.
const MAX_TAIL = 256 * 1024 * 1024;
const CONTENT_KEY = /(body|content|data|prompt|text)/i;

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

// The value, plus the two things worth having beside it: sha256, because equal
// checksums are how a repeated prompt or a scheduled job shows up, and chars,
// because that is what the list column reads without touching the text.
function textSummary(value) {
  return { present: value.length > 0, chars: value.length, sha256: digest(value), text: value };
}

/**
 * The call as it was made, whole, with a checksum attached to anything long
 * enough to want one. Credentials are the single exception and are replaced by
 * `[redacted]` wherever the documented best-effort policy recognizes them. The
 * heap-backed traversal preserves valid JSON deeper than the JavaScript call
 * stack; `active` is only a cycle guard, not a capture-depth limit.
 */
export function summarizePayload(value, key = '', filterString = (text) => text) {
  const root = { value: undefined };
  const active = new WeakSet();
  const stack = [{ type: 'visit', value, key, parent: root, slot: 'value' }];

  while (stack.length) {
    const frame = stack.pop();
    if (frame.type === 'leave') {
      active.delete(frame.value);
      continue;
    }

    const { value: current, key: currentKey, parent, slot } = frame;
    if (currentKey && isSensitiveAuditKey(currentKey)) {
      parent[slot] = REDACTED_CREDENTIAL;
      continue;
    }
    if (current == null || typeof current === 'boolean' || typeof current === 'number') {
      parent[slot] = current;
      continue;
    }
    if (Buffer.isBuffer(current)) {
      // UTF-8 text gets normal string semantics. For an opaque Buffer, latin1
      // is a one-byte mapping that still catches ASCII credential material
      // without claiming to decode the binary format or inspect an archive.
      const utf8 = current.toString('utf8');
      const validUtf8 = Buffer.from(utf8, 'utf8').equals(current);
      const filtered = validUtf8
        ? Buffer.from(filterString(utf8), 'utf8')
        : Buffer.from(filterString(current.toString('latin1')), 'latin1');
      parent[slot] = { bytes: filtered.length, sha256: digest(filtered), base64: filtered.toString('base64') };
      continue;
    }
    if (typeof current === 'string') {
      const filtered = filterString(current);
      parent[slot] = CONTENT_KEY.test(currentKey) || current.length > MAX_TEXT
        ? textSummary(filtered)
        : filtered;
      continue;
    }
    if (typeof current !== 'object') {
      parent[slot] = filterString(String(current));
      continue;
    }
    if (active.has(current)) {
      parent[slot] = '[circular]';
      continue;
    }

    active.add(current);
    stack.push({ type: 'leave', value: current });
    if (Array.isArray(current)) {
      const out = new Array(current.length);
      parent[slot] = out;
      for (let i = current.length - 1; i >= 0; i--) {
        if (Object.hasOwn(current, i)) {
          stack.push({ type: 'visit', value: current[i], key: currentKey, parent: out, slot: i });
        }
      }
      continue;
    }

    const out = {};
    parent[slot] = out;
    const children = [];
    for (const [childKey, child] of Object.entries(current)) {
      let storedKey = filterString(childKey);
      for (let n = 2; Object.hasOwn(out, storedKey); n++) storedKey = `${filterString(childKey)}#${n}`;
      // Establish keys in source order before LIFO traversal processes values.
      out[storedKey] = undefined;
      children.push({ value: child, key: childKey, parent: out, slot: storedKey });
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ type: 'visit', ...children[i] });
  }

  return root.value;
}

function sanitizeMetadata(value, filterString, seen = new WeakSet()) {
  if (typeof value === 'string') return filterString(value);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return filterString(String(value));
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((v) => sanitizeMetadata(v, filterString, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    let storedKey = filterString(key);
    for (let n = 2; Object.hasOwn(out, storedKey); n++) storedKey = `${filterString(key)}#${n}`;
    out[storedKey] = isSensitiveAuditKey(key) ? REDACTED_CREDENTIAL : sanitizeMetadata(child, filterString, seen);
  }
  seen.delete(value);
  return out;
}

function stringifyAuditRecord(value) {
  // JSON.stringify itself overflows on input depths JSON.parse and Express
  // accept. Serialize the already-filtered representation with the same JSON
  // scalar/container rules, but keep the traversal stack on the heap.
  const chunks = [];
  const seen = new WeakSet();
  const stack = [{ type: 'value', value, arrayItem: false }];
  while (stack.length) {
    const frame = stack.pop();
    if (frame.type === 'raw') {
      chunks.push(frame.value);
      continue;
    }
    if (frame.type === 'leave') {
      seen.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (!current || typeof current !== 'object') {
      const encoded = JSON.stringify(current);
      chunks.push(encoded === undefined ? (frame.arrayItem ? 'null' : '') : encoded);
      continue;
    }
    if (seen.has(current)) throw new TypeError('circular audit representation');
    seen.add(current);

    if (Array.isArray(current)) {
      stack.push({ type: 'leave', value: current });
      stack.push({ type: 'raw', value: ']' });
      for (let i = current.length - 1; i >= 0; i--) {
        if (i < current.length - 1) stack.push({ type: 'raw', value: ',' });
        stack.push({ type: 'value', value: current[i], arrayItem: true });
      }
      stack.push({ type: 'raw', value: '[' });
      continue;
    }

    const entries = Object.entries(current).filter(([, child]) => child !== undefined);
    stack.push({ type: 'leave', value: current });
    stack.push({ type: 'raw', value: '}' });
    for (let i = entries.length - 1; i >= 0; i--) {
      const [childKey, child] = entries[i];
      if (i < entries.length - 1) stack.push({ type: 'raw', value: ',' });
      stack.push({ type: 'value', value: child, arrayItem: false });
      stack.push({ type: 'raw', value: `${JSON.stringify(childKey)}:` });
    }
    stack.push({ type: 'raw', value: '{' });
  }
  return chunks.join('');
}

function append(record) {
  fs.mkdirSync(path.dirname(OPERATIONS_FILE), { recursive: true });
  fs.appendFileSync(OPERATIONS_FILE, `${stringifyAuditRecord(record)}\n`, { mode: 0o600 });
}

const requestOrigin = (req) => String(
  req.query?.from
  || req.headers?.['x-am-origin']
  || (req.body && !Array.isArray(req.body) && typeof req.body === 'object' ? req.body.from : '')
  || '',
).trim();

const cleanQuery = (query, filterString) => {
  const out = { ...(query || {}) };
  delete out.from;
  return summarizePayload(out, 'query', filterString);
};

/**
 * Require an attributable origin for every state-changing API request and
 * append its outcome to a durable JSONL log.
 *
 * resolveOrigin(raw, req) returns {id,type,name?,cli?}, or null when the id is
 * unknown. It may derive an identity from a protocol route (remote agents do
 * this for backwards compatibility with already-running polling loops).
 */
export function operationMiddleware({
  resolveOrigin,
  resolveTarget,
  allowMissing = false,
  getKnownCredentialValues = () => [],
  filterFactory = createCredentialFilter,
  appendRecord = append,
} = {}) {
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
      let entry;
      try {
        const filterString = filterFactory(getKnownCredentialValues());
        entry = {
          version: 2,
          id: operationId,
          at: new Date(started).toISOString(),
          audit: { credentialFilter: { policy: AUDIT_CREDENTIAL_POLICY, status: 'applied' } },
          origin: sanitizeMetadata(origin, filterString),
          // Who it was done TO, snapshotted above. The id is in the path already,
          // but a name read back later is the name the session has NOW — renamed
          // or deleted, and the audit trail stops making sense.
          ...(target ? { target: sanitizeMetadata(target, filterString) } : {}),
          method: req.method,
          path: filterString(req.path),
          query: cleanQuery(req.query, filterString),
          request: summarizePayload(req.body, 'body', filterString),
          status: res.statusCode,
          ok: res.statusCode < 400,
          durationMs: Date.now() - started,
          result: summarizePayload(responseBody, 'result', filterString),
        };
      } catch {
        // No raw fallback. Even labels, paths and exception messages may be
        // attacker-controlled, so a filter failure records only fixed text and
        // identifiers generated inside this middleware.
        entry = {
          version: 2,
          id: operationId,
          at: new Date(started).toISOString(),
          audit: {
            credentialFilter: {
              policy: AUDIT_CREDENTIAL_POLICY,
              status: 'failed',
              reason: 'credential-filter-failed',
            },
          },
          origin: null,
          method: 'AUDIT',
          path: '/audit/credential-filter',
          query: {},
          status: 0,
          ok: false,
          durationMs: Date.now() - started,
        };
      }
      try {
        appendRecord(entry);
      } catch {
        // Auditing must never change a completed operation or attempt a second
        // response. Keep this diagnostic fixed: append errors can quote data.
        console.error('[operations.append] audit append failed');
      }
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
    // A bounded tail keeps this endpoint cheap after years of operations. But an
    // entry is now as big as the call it records — a file write can be eight
    // megabytes on one line — so a fixed window is not enough: it could contain
    // no COMPLETE line at all and the log would read as empty. Grow it until
    // there are enough whole records, or until the ceiling says stop.
    let rows = [];
    for (let window = 4 * 1024 * 1024; ; window *= 4) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      // the first line is almost certainly cut in half by the window
      if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
      rows = text.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      if (rows.length >= take || start === 0 || window >= MAX_TAIL) break;
    }
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
