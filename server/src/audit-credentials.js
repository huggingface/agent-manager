/**
 * Credential filtering for newly persisted API-operation records.
 *
 * This is deliberately narrower than a general secret scanner. It recognizes
 * documented provider prefixes, explicit credential labels, complete private
 * key blocks, and exact configured values supplied by the caller. Everything
 * else stays byte-for-byte useful in the private audit log.
 */
export const AUDIT_CREDENTIAL_POLICY = 'credentials-v1';
export const REDACTED_CREDENTIAL = '[redacted]';
export const MIN_KNOWN_CREDENTIAL_LENGTH = 8;
const SENSITIVE_EXACT = new Set([
  'authorization', 'credential', 'credentials', 'password', 'passwd', 'secret', 'secrets',
  'token', 'tokens', 'key', 'subscription', 'endpoint', 'privatekey', 'apikey', 'accesskey',
]);
const SENSITIVE_SUFFIXES = [
  'credential', 'password', 'passwd', 'secret', 'token', 'privatekey', 'apikey', 'accesskey', 'endpoint',
];

// Fixed-count, bounded recognizers. Keep this list aligned with
// docs/api-audit-log.md, including its source links and limitations.
const TOKEN_PATTERNS = [
  /\bhf_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{32,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bAQ\.[0-9A-Za-z_-]{20,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

// Quoted values include their delimiters so replacement keeps the surrounding
// syntax valid. The escaped forms cover JSON embedded inside an ordinary text
// field after the outer JSON body has already been parsed.
const VALUE = String.raw`(?:\\"(?:\\\\.|[^"\\\r\n])*\\"|\\'(?:\\\\.|[^'\\\r\n])*\\'|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\x60(?:\\.|[^\x60\\\r\n])*\x60|[^\s,;&'"\x60]+)`;
const AUTH_VALUE = String.raw`(?:\\"(?:\\\\.|[^"\\\r\n])*\\"|\\'(?:\\\\.|[^'\\\r\n])*\\'|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\x60(?:\\.|[^\x60\\\r\n])*\x60|(?:Bearer|Basic|Token)\s+[^\s,;&'"\x60]+|[^\s,;&'"\x60]+)`;
const CREDENTIAL_LABEL = String.raw`(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|credential|token|secret|key)`;
const AUTHORIZATION = new RegExp(
  String.raw`(\bauthorization\b(?:\\?["'])?\s*(?::|=)\s*)(${AUTH_VALUE})`,
  'gi',
);
const ASSIGNMENT = new RegExp(
  String.raw`(\b${CREDENTIAL_LABEL}\b(?:\\?["'])?\s*(?::|=)\s*)(${VALUE})`,
  'gi',
);

const PRIVATE_KEY_MARKER = /-----(BEGIN|END) ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/g;

// One pass over markers: unlike a lazy `BEGIN[\s\S]*?END` expression, repeated
// incomplete BEGIN lines cannot make this scan revisit an ever-growing tail.
function redactPrivateKeyBlocks(text) {
  const opens = new Map();
  const intervals = [];
  for (const match of text.matchAll(PRIVATE_KEY_MARKER)) {
    if (match[1] === 'BEGIN') {
      const stack = opens.get(match[2]) || [];
      stack.push(match.index);
      opens.set(match[2], stack);
      continue;
    }
    const stack = opens.get(match[2]);
    if (!stack?.length) continue;
    intervals.push({ start: stack.pop(), end: match.index + match[0].length });
    if (!stack.length) opens.delete(match[2]);
  }

  if (!intervals.length) return text;
  // Matches arrive in ascending END order. Merge from right to left, which is
  // linear even for nested/crossed fake markers and leaves no overlapping raw
  // sibling range behind.
  const mergedRightToLeft = [];
  for (let i = intervals.length - 1; i >= 0; i--) {
    const interval = intervals[i];
    const right = mergedRightToLeft.at(-1);
    if (right && interval.end >= right.start) {
      right.start = Math.min(right.start, interval.start);
      right.end = Math.max(right.end, interval.end);
    } else {
      mergedRightToLeft.push({ ...interval });
    }
  }
  const pieces = [];
  let copiedThrough = 0;
  for (let i = mergedRightToLeft.length - 1; i >= 0; i--) {
    const interval = mergedRightToLeft[i];
    pieces.push(text.slice(copiedThrough, interval.start), REDACTED_CREDENTIAL);
    copiedThrough = interval.end;
  }
  pieces.push(text.slice(copiedThrough));
  return pieces.join('');
}

function redactValue(value, keepAuthorizationScheme = false) {
  let open = '';
  let close = '';
  let inner = value;
  for (const quote of ['\\"', "\\'", '"', "'", '`']) {
    if (value.startsWith(quote) && value.endsWith(quote) && value.length >= quote.length * 2) {
      open = close = quote;
      inner = value.slice(quote.length, -quote.length);
      break;
    }
  }
  const existingScheme = keepAuthorizationScheme ? inner.match(/^(?:Bearer|Basic|Token)\s+/i)?.[0] || '' : '';
  const retained = inner.slice(existingScheme.length);
  if (retained === REDACTED_CREDENTIAL
      || (retained.startsWith(REDACTED_CREDENTIAL)
        && /^[.!?:)\]}]+$/.test(retained.slice(REDACTED_CREDENTIAL.length)))) return value;
  // An unquoted assignment in prose often ends at sentence punctuation. The
  // matcher has to admit dots for opaque/JWT-style values, so peel only a
  // trailing prose delimiter back off rather than erasing it with the value.
  let tail = '';
  if (!open) {
    const punctuation = inner.match(/[.!?:)\]}]+$/)?.[0] || '';
    if (punctuation) {
      tail = punctuation;
      inner = inner.slice(0, -punctuation.length);
    }
  }
  const scheme = keepAuthorizationScheme ? inner.match(/^(?:Bearer|Basic|Token)\s+/i)?.[0] || '' : '';
  if (inner.slice(scheme.length) === REDACTED_CREDENTIAL) return value;
  return `${open}${scheme}${REDACTED_CREDENTIAL}${tail}${close}`;
}

function exactValues(values) {
  const unique = new Set();
  for (const candidate of Array.isArray(values) ? values : []) {
    if (typeof candidate !== 'string') continue;
    if (candidate.length < MIN_KNOWN_CREDENTIAL_LENGTH || candidate.trim().length < MIN_KNOWN_CREDENTIAL_LENGTH) continue;
    unique.add(candidate);
    // Query parsers decode this form, but paths and embedded URL text may not.
    // This is one exact derivative, not general recursive decoding.
    try {
      const encoded = encodeURIComponent(candidate);
      if (encoded !== candidate && encoded.length >= MIN_KNOWN_CREDENTIAL_LENGTH) unique.add(encoded);
    } catch { /* an invalid Unicode scalar still gets exact raw matching */ }
  }
  return [...unique].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Create one deterministic string filter for one audit record. */
export function createCredentialFilter(knownValues = []) {
  const exact = exactValues(knownValues);
  return (input) => {
    let out = redactPrivateKeyBlocks(String(input));
    // Longest first makes overlapping configured values deterministic.
    for (const value of exact) out = out.split(value).join(REDACTED_CREDENTIAL);
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED_CREDENTIAL);
    out = out.replace(AUTHORIZATION, (_whole, prefix, value) => `${prefix}${redactValue(value, true)}`);
    out = out.replace(ASSIGNMENT, (_whole, prefix, value) => `${prefix}${redactValue(value)}`);
    return out;
  };
}

/**
 * Structural credential labels. Normalize separators/case, then require an
 * exact label or credential suffix: `tokenizer` and `secretary` are ordinary
 * fields, while `access_token` and `clientSecret` are not.
 */
export function isSensitiveAuditKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_EXACT.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
