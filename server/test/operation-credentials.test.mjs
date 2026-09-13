// Credential filtering is a persistence property: assertions inspect the new
// JSONL bytes and decoded fields, while the fake handlers receive and return the
// original objects. Every credential below is synthetic.
//
// Run with: node test/operation-credentials.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-operation-credentials-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const {
  OPERATIONS_FILE, operationMiddleware, readOperations, summarizePayload,
} = await import('../src/operations.js');
const {
  AUDIT_CREDENTIAL_POLICY, REDACTED_CREDENTIAL, createCredentialFilter,
} = await import('../src/audit-credentials.js');

const TOKENS = {
  huggingface: `hf_${'H'.repeat(28)}`,
  anthropic: `sk-ant-api03-${'A'.repeat(36)}`,
  openai: `sk-proj-${'O'.repeat(44)}`,
  openrouter: `sk-or-v1-${'R'.repeat(44)}`,
  github: `ghp_${'G'.repeat(36)}`,
  githubFine: `github_pat_${'F'.repeat(36)}`,
  aws: `AKIA${'W'.repeat(16)}`,
  google: `AIza${'Q'.repeat(35)}`,
  googleAuth: `AQ.${'N'.repeat(32)}`,
  googleOauth: `ya29.${'Y'.repeat(32)}`,
  jwt: `eyJ${'J'.repeat(12)}.${'K'.repeat(12)}.${'L'.repeat(12)}`,
};
const ALL_TOKENS = Object.values(TOKENS);
const KNOWN_LONG = 'configured-value-with-symbols-!@#$';
const KNOWN_OVERLAP = 'value-with-symbols-!@#$';
const KNOWN_SHORT = 'tiny';
const PRIVATE_ONE = '-----BEGIN PRIVATE KEY-----\nalpha\nbeta\n-----END PRIVATE KEY-----';
const PRIVATE_TWO = '-----BEGIN OPENSSH PRIVATE KEY-----\ngamma\n-----END OPENSSH PRIVATE KEY-----';
const INCOMPLETE_KEY = '-----BEGIN PRIVATE KEY-----\nnot complete';
const CROSSED_KEYS = [
  '-----BEGIN PRIVATE KEY-----', 'crossed-alpha',
  '-----BEGIN RSA PRIVATE KEY-----', 'crossed-beta',
  '-----END PRIVATE KEY-----', 'crossed-gamma',
  '-----END RSA PRIVATE KEY-----',
].join('\n');
const legacy = `${JSON.stringify({
  version: 1, id: 'legacy-id', at: '2026-09-01T00:00:00.000Z', origin: null,
  method: 'POST', path: '/api/legacy', query: {}, request: { text: 'legacy bytes stay as written' },
  status: 200, ok: true, durationMs: 1, result: { ok: true },
})}\n`;
fs.writeFileSync(OPERATIONS_FILE, legacy, { mode: 0o600 });

class Response extends EventEmitter {
  statusCode = 200;
  body = undefined;
  jsonCalls = 0;
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.jsonCalls++; this.emit('finish'); return this; }
}

let knownValues = [KNOWN_LONG, KNOWN_OVERLAP, KNOWN_LONG, '', '   ', KNOWN_SHORT];
const originFixture = Object.freeze({ id: 'agent-1', type: 'agent', name: `agent ${TOKENS.anthropic}`, cli: 'codex' });
const targetFixture = Object.freeze({ id: 'target-1', name: `target ${TOKENS.openai}`, cli: 'claude' });
const middleware = operationMiddleware({
  resolveOrigin: () => originFixture,
  resolveTarget: () => targetFixture,
  getKnownCredentialValues: () => knownValues,
});
const invoke = ({ method = 'POST', reqPath = '/api/test', query = {}, body }, handler) => {
  const req = { method, path: reqPath, query: { from: 'agent-1', ...query }, headers: {}, body };
  const res = new Response();
  middleware(req, res, () => handler(req, res));
  return { req, res };
};
const diskLines = () => fs.readFileSync(OPERATIONS_FILE, 'utf8').split('\n').filter(Boolean);
const newest = () => JSON.parse(diskLines().at(-1));
const absentFrom = (text, values) => values.forEach((value) => assert.ok(!text.includes(value), `retained synthetic credential: ${value.slice(0, 12)}…`));
const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

try {
  // Full supported matrix across ordinary strings, structured sensitive keys,
  // query/path and user-controlled origin/target/result metadata.
  const ordinary = `keep before ${ALL_TOKENS.join(' keep between ')} keep after; ${TOKENS.huggingface} repeated`;
  const embedded = String.raw`embedded {\"password\":\"opaque quoted value\"} and OPENAI_API_KEY='opaque shell value'`;
  const body = deepFreeze({
    prompt: `${ordinary}\n${PRIVATE_ONE}\nmiddle\n${PRIVATE_TWO}\n${CROSSED_KEYS}\n${INCOMPLETE_KEY}`,
    nested: [{ ordinary: `left ${KNOWN_LONG} right` }, true, 42, null],
    password: 'short field value',
    token: TOKENS.huggingface,
    note: TOKENS.huggingface,
    encoded: encodeURIComponent(KNOWN_LONG),
    tokenizer: 'ordinary tokenizer field',
    secretary: 'ordinary secretary field',
    secret_key: 'structural snake secret',
    SECRET_KEY: 'structural upper secret',
    secretKey: 'structural camel secret',
    subscriptionKey: 'structural subscription key',
    'Ocp-Apim-Subscription-Key': 'structural compound subscription key',
    passwordHash: 'structural password hash',
    endpointUrl: 'structural endpoint url',
    subscription_id: 'structural subscription id',
    embedded,
    [TOKENS.githubFine]: 'a credential can also be an object key',
  });
  const bodyBefore = structuredClone(body);
  const resultBody = deepFreeze({
    ok: false,
    error: `ordinary error before ${TOKENS.googleAuth} ordinary error after`,
    detail: 'Authorization: Bearer opaque-authorization-value. keep punctuation',
    inline: 'login_password=opaque-password-value! keep punctuation',
  });
  const resultBefore = structuredClone(resultBody);
  const { req, res } = invoke({
    reqPath: `/api/test/${TOKENS.huggingface}`,
    query: { note: `query ${TOKENS.github}`, access_token: 'short-query-secret' },
    body,
  }, (request, response) => {
    assert.deepEqual(request.body, bodyBefore, 'the handler receives the exact original request');
    response.status(422).json(resultBody);
  });
  assert.deepEqual(req.body, bodyBefore, 'auditing does not mutate the request after delivery');
  assert.deepEqual(res.body, resultBefore, 'the HTTP response remains byte-for-byte the domain response');
  assert.equal(originFixture.name, `agent ${TOKENS.anthropic}`, 'origin/session metadata is not mutated');
  assert.equal(targetFixture.name, `target ${TOKENS.openai}`, 'target/session metadata is not mutated');
  assert.equal(res.statusCode, 422);
  assert.equal(res.jsonCalls, 1);

  const firstRaw = diskLines().at(-1);
  const first = JSON.parse(firstRaw);
  absentFrom(firstRaw, [...ALL_TOKENS, KNOWN_LONG, 'short field value', 'short-query-secret',
    'opaque quoted value', 'opaque shell value', 'opaque-authorization-value', 'opaque-password-value',
    'alpha', 'beta', 'gamma', 'crossed-alpha', 'crossed-beta', 'crossed-gamma',
    'structural snake secret', 'structural upper secret', 'structural camel secret',
    'structural subscription key', 'structural compound subscription key',
    'structural password hash', 'structural endpoint url', 'structural subscription id']);
  assert.equal(first.version, 2);
  assert.deepEqual(first.audit, { credentialFilter: { policy: AUDIT_CREDENTIAL_POLICY, status: 'applied' } });
  assert.match(first.request.prompt.text, /^keep before /);
  assert.match(first.request.prompt.text, / keep after;/);
  assert.match(first.request.prompt.text, /middle/);
  assert.ok(first.request.prompt.text.includes(INCOMPLETE_KEY), 'an incomplete private-key block is retained as documented');
  assert.equal(first.request.password, REDACTED_CREDENTIAL);
  assert.equal(first.request.token, REDACTED_CREDENTIAL);
  assert.equal(first.request.note, REDACTED_CREDENTIAL);
  assert.equal(first.request.encoded, REDACTED_CREDENTIAL);
  assert.equal(first.request.tokenizer, 'ordinary tokenizer field');
  assert.equal(first.request.secretary, 'ordinary secretary field');
  for (const field of ['secret_key', 'SECRET_KEY', 'secretKey', 'subscriptionKey',
    'Ocp-Apim-Subscription-Key', 'passwordHash', 'endpointUrl', 'subscription_id']) {
    assert.equal(first.request[field], REDACTED_CREDENTIAL, `${field} keeps structural protection`);
  }
  assert.equal(first.request.nested[0].ordinary, 'left [redacted] right');
  assert.ok(Object.hasOwn(first.request, REDACTED_CREDENTIAL), 'credential material in a property name is filtered too');
  assert.equal(first.query.access_token, REDACTED_CREDENTIAL);
  assert.equal(first.query.note, 'query [redacted]');
  assert.equal(first.origin.name, 'agent [redacted]');
  assert.equal(first.target.name, 'target [redacted]');
  assert.equal(first.result.error, 'ordinary error before [redacted] ordinary error after');
  assert.equal(first.result.detail, 'Authorization: Bearer [redacted]. keep punctuation');
  assert.equal(first.result.inline, 'login_password=[redacted]! keep punctuation');

  const fileInput = `file head\n${TOKENS.anthropic}\nfile tail`;
  const fileCall = invoke({ reqPath: '/api/files/files-1/write', body: fileInput }, (request, response) => {
    assert.equal(request.body, fileInput, 'the file handler receives the original content');
    response.json({ ok: true, text: `response ${TOKENS.google} kept around` });
  });
  assert.equal(fileCall.res.body.text, `response ${TOKENS.google} kept around`);
  assert.equal(newest().request.text, 'file head\n[redacted]\nfile tail');
  assert.equal(newest().result.text.text, 'response [redacted] kept around');

  // Stored summaries describe the retained string, never the original secret-
  // bearing one. Two original credentials can therefore intentionally collapse
  // to the same retained payload/checksum.
  knownValues = ['first-exact-credential', 'second-exact-credential'];
  invoke({ body: 'same first-exact-credential body' }, (_req, response) => response.json({ ok: true }));
  const filteredA = newest();
  invoke({ body: 'same second-exact-credential body' }, (_req, response) => response.json({ ok: true }));
  const filteredB = newest();
  assert.equal(filteredA.request.text, 'same [redacted] body');
  assert.equal(filteredA.request.chars, filteredA.request.text.length);
  assert.equal(filteredA.request.sha256, crypto.createHash('sha256').update(filteredA.request.text).digest('hex'));
  assert.equal(filteredA.request.sha256, filteredB.request.sha256,
    'checksums compare retained payloads, not the distinct originals');

  // Configured values are fetched for each record: duplicates/overlaps are
  // deterministic, short/empty values do not erase prose, and rotation does
  // not keep an obsolete value in memory forever.
  knownValues = [KNOWN_LONG, KNOWN_OVERLAP, KNOWN_LONG, '', ' ', KNOWN_SHORT];
  invoke({ body: `a ${KNOWN_LONG} b ${KNOWN_OVERLAP} c ${KNOWN_SHORT}` }, (_req, response) => response.json({ ok: true }));
  assert.equal(newest().request.text, `a [redacted] b [redacted] c ${KNOWN_SHORT}`);
  knownValues = ['rotated-configured-value'];
  invoke({ body: { prompt: `old ${KNOWN_LONG}; new rotated-configured-value`, token: KNOWN_SHORT } },
    (_req, response) => response.json({ ok: true }));
  assert.equal(newest().request.prompt.text, `old ${KNOWN_LONG}; new [redacted]`);
  assert.equal(newest().request.token, REDACTED_CREDENTIAL,
    'a sensitive field remains protected even when its value is too short for prose matching');

  // Parsed JSON strings keep escapes/newlines/Unicode around the replacement.
  const escapedText = `quote \\" and slash \\\\ and snowman ☃\n${embedded}\n${PRIVATE_ONE}\nend`;
  invoke({ body: escapedText }, (_req, response) => response.json({ error: `failed with ${TOKENS.googleOauth}` }));
  const escaped = newest();
  assert.match(escaped.request.text, /^quote \\" and slash \\\\ and snowman ☃\n/);
  assert.match(escaped.request.text, /embedded \{\\"password\\":\\"\[redacted\]\\"\}/);
  assert.ok(!escaped.request.text.includes('alpha'));
  assert.match(escaped.request.text, /\[redacted\]\nend$/);

  // A Buffer remains a Buffer-shaped audit representation. Text and ASCII
  // inside opaque bytes are filtered before the retained bytes/hash/base64 are
  // derived; no base64-decoding guess is made for ordinary string fields.
  knownValues = ['buffer-configured-value'];
  const textBuffer = Buffer.from(`left ${TOKENS.openrouter} and buffer-configured-value right`, 'utf8');
  invoke({ body: textBuffer }, (request, response) => {
    assert.ok(request.body.equals(textBuffer));
    response.json({ ok: true });
  });
  const buffered = newest().request;
  const filteredBuffer = Buffer.from(buffered.base64, 'base64');
  assert.equal(filteredBuffer.toString('utf8'), 'left [redacted] and [redacted] right');
  assert.equal(buffered.bytes, filteredBuffer.length);
  assert.equal(buffered.sha256, crypto.createHash('sha256').update(filteredBuffer).digest('hex'));
  const mixedBytes = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(TOKENS.github), Buffer.from([0xfe])]);
  invoke({ body: mixedBytes }, (_req, response) => response.json({ ok: true }));
  const mixedStored = Buffer.from(newest().request.base64, 'base64');
  assert.ok(!mixedStored.includes(Buffer.from(TOKENS.github)), 'opaque bytes cannot hide recognizable ASCII behind base64');
  const harmlessBinary = Buffer.from([0xff, 0x00, 0x01, 0xfe]);
  invoke({ body: harmlessBinary }, (_req, response) => response.json({ ok: true }));
  assert.ok(Buffer.from(newest().request.base64, 'base64').equals(harmlessBinary));

  // Ordinary deep/large content remains intact. Near-matches are specifically
  // not a reason to erase URLs, IDs, code or incomplete key material.
  const deep = { leaf: 'ordinary' };
  for (let i = 0, cursor = deep; i < 35; i++) cursor = cursor.next = { level: i, text: `value-${i}` };
  invoke({ body: deep }, (_req, response) => response.json({ ok: true }));
  let cursor = newest().request;
  for (let i = 0; i < 35; i++) {
    assert.equal(cursor.next.level, i);
    assert.equal(cursor.next.text.text, `value-${i}`);
    cursor = cursor.next;
  }

  // Valid JSON can be much deeper than the JavaScript call stack. The audit
  // copy and its JSONL serialization must keep that full shape rather than let
  // the caller turn an attributable operation into a generic filter failure.
  const veryDeep = { level: 0 };
  let veryDeepInputCursor = veryDeep;
  for (let i = 1; i <= 5_000; i++) {
    veryDeepInputCursor.next = { level: i };
    veryDeepInputCursor = veryDeepInputCursor.next;
  }
  veryDeepInputCursor.prompt = `deep leaf ${TOKENS.huggingface}`;
  const beforeVeryDeep = diskLines().length;
  const veryDeepCall = invoke({ reqPath: '/api/agents/target-1/prompt', body: veryDeep }, (request, response) => {
    assert.equal(request.body, veryDeep, 'the deeply nested body reaches the handler unchanged');
    response.json({ ok: true });
  });
  assert.equal(veryDeepCall.res.jsonCalls, 1);
  assert.equal(diskLines().length, beforeVeryDeep + 1, 'deep traversal and serialization append exactly one record');
  const veryDeepRecord = newest();
  assert.equal(veryDeepRecord.audit.credentialFilter.status, 'applied');
  assert.equal(veryDeepRecord.origin.id, 'agent-1');
  assert.equal(veryDeepRecord.target.id, 'target-1');
  assert.equal(veryDeepRecord.method, 'POST');
  assert.equal(veryDeepRecord.path, '/api/agents/target-1/prompt');
  let veryDeepStoredCursor = veryDeepRecord.request;
  for (let i = 0; i <= 5_000; i++) {
    assert.equal(veryDeepStoredCursor.level, i, `deep level ${i} is retained`);
    if (i < 5_000) veryDeepStoredCursor = veryDeepStoredCursor.next;
  }
  assert.equal(veryDeepStoredCursor.prompt.text, 'deep leaf [redacted]');
  assert.equal(veryDeepInputCursor.prompt, `deep leaf ${TOKENS.huggingface}`,
    'deep credential filtering does not mutate the delivered body');

  const sharedBranch = { note: 'shared ordinary branch' };
  const cyclic = { first: sharedBranch, second: sharedBranch };
  cyclic.self = cyclic;
  invoke({ body: cyclic }, (request, response) => {
    assert.equal(request.body, cyclic);
    response.json({ ok: true });
  });
  assert.deepEqual(newest().request, {
    first: { note: 'shared ordinary branch' },
    second: { note: 'shared ordinary branch' },
    self: '[circular]',
  }, 'iterative traversal preserves shared branches and marks only actual cycles');

  const near = `https://example.test/sketch-${'x'.repeat(40)} hf_short eyJonly.two ${INCOMPLETE_KEY}`;
  invoke({ body: near }, (_req, response) => response.json({ ok: true }));
  assert.equal(newest().request.text, near);

  // Ambiguous bare labels occur constantly in code, data and prose. Preserve
  // them when an unquoted value has no high-confidence credential boundary;
  // compound labels, quoted embedded fields and env-style labels stay covered.
  const ordinaryAssignments = [
    'sorted(items, key=lambda x: x[1])',
    '<li key={item.id}>{item.name}</li>',
    '{"key": "north", "secret": false, "token": 42}',
    'key: value',
    'The password: is required for this example.',
  ].join('\n');
  assert.equal(createCredentialFilter([])(ordinaryAssignments), ordinaryAssignments);
  invoke({ reqPath: '/api/files/files-ordinary/write', body: ordinaryAssignments }, (_req, response) => response.json({ ok: true }));
  assert.equal(newest().request.text, ordinaryAssignments, 'ordinary assignments survive in persisted file content');
  const explicitAssignments = [
    'OPENAI_API_KEY=synthetic-explicit-value',
    'access_token=synthetic-access-value',
    'DB_PASSWORD=synthetic-db-value',
    String.raw`embedded {\"password\":\"synthetic quoted value\"}`,
  ].join('\n');
  const explicitFiltered = createCredentialFilter([])(explicitAssignments);
  for (const value of ['synthetic-explicit-value', 'synthetic-access-value',
    'synthetic-db-value', 'synthetic quoted value']) assert.ok(!explicitFiltered.includes(value));

  const idempotentFilter = createCredentialFilter([KNOWN_LONG]);
  const idempotentOnce = idempotentFilter(
    `${TOKENS.openai} ${KNOWN_LONG} Authorization: Bearer opaque. keep; password=opaque!`,
  );
  assert.equal(idempotentFilter(idempotentOnce), idempotentOnce,
    'filtering an already-filtered record is a no-op');

  // Finish/close races and abandoned clients remain exactly-once. A close has
  // no body to sanitize, but is still an accepted mutating operation.
  const beforeRace = diskLines().length;
  const raced = invoke({ body: 'ordinary race' }, (_req, response) => response.json({ ok: true }));
  raced.res.emit('close');
  assert.equal(diskLines().length, beforeRace + 1);
  const beforeClose = diskLines().length;
  const closed = invoke({ body: 'ordinary close' }, () => {});
  closed.res.emit('close');
  closed.res.emit('finish');
  assert.equal(diskLines().length, beforeClose + 1);

  // Sanitizer failure has no raw fallback. The next record can recover. Keep
  // append failure separate: retrying an append that may have partially landed
  // is how exactly-once logs become duplicates.
  const privateFailureText = `synthetic failure text ${TOKENS.huggingface}`;
  let failFilter = true;
  const safeRecords = [];
  const failureMiddleware = operationMiddleware({
    allowMissing: true,
    filterFactory: (values) => {
      if (failFilter) { failFilter = false; throw new Error(privateFailureText); }
      return createCredentialFilter(values);
    },
    appendRecord: (record) => safeRecords.push(record),
  });
  const failureInvoke = (bodyValue) => {
    const req = { method: 'POST', path: `/api/private/${privateFailureText}`, query: {}, headers: {}, body: bodyValue };
    const res = new Response();
    failureMiddleware(req, res, () => res.json({ ok: true, echo: bodyValue }));
    res.emit('close');
    return res;
  };
  const failedResponse = failureInvoke(privateFailureText);
  assert.equal(failedResponse.body.echo, privateFailureText);
  assert.equal(failedResponse.jsonCalls, 1);
  assert.equal(safeRecords.length, 1);
  assert.deepEqual(safeRecords[0].audit.credentialFilter, {
    policy: AUDIT_CREDENTIAL_POLICY, status: 'failed', reason: 'credential-filter-failed',
  });
  assert.equal(safeRecords[0].path, '/audit/credential-filter');
  assert.ok(!JSON.stringify(safeRecords[0]).includes(privateFailureText));
  failureInvoke('healthy later event');
  assert.equal(safeRecords.length, 2);
  assert.equal(safeRecords[1].request.text, 'healthy later event');

  let appendAttempts = 0;
  const appended = [];
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...args) => diagnostics.push(args.join(' '));
  try {
    const appendMiddleware = operationMiddleware({
      allowMissing: true,
      appendRecord: (record) => {
        appendAttempts++;
        if (appendAttempts === 1) throw new Error(privateFailureText);
        appended.push(record);
      },
    });
    const call = (value) => {
      const req = { method: 'POST', path: '/api/test', query: {}, headers: {}, body: value };
      const res = new Response();
      appendMiddleware(req, res, () => res.json({ ok: true, echo: value }));
      res.emit('close');
      return res;
    };
    const firstResponse = call(privateFailureText);
    assert.equal(firstResponse.body.echo, privateFailureText);
    assert.equal(firstResponse.jsonCalls, 1);
    assert.equal(appendAttempts, 1, 'an append failure is not retried after finish/close');
    call('later append succeeds');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].request.text, 'later append succeeds');
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(diagnostics, ['[operations.append] audit append failed']);
  assert.ok(!diagnostics.join(' ').includes(privateFailureText));

  // Prospective only: the exact legacy prefix remains on disk, and both v1/v2
  // records remain readable through the existing API reader.
  const finalBytes = fs.readFileSync(OPERATIONS_FILE, 'utf8');
  assert.ok(finalBytes.startsWith(legacy), 'new appends did not rewrite the legacy prefix');
  const versions = new Set(readOperations(1000).map((record) => record.version));
  assert.deepEqual(versions, new Set([1, 2]));

  // Representative cost, printed for the PR rather than hidden behind "pass".
  // The timer delay is the event-loop impact of this synchronous persistence
  // seam. Thresholds only catch pathological regressions; measurements matter.
  const large = `${'ordinary code https://example.test/path id_12345\n'.repeat(45_000)}${TOKENS.openai}`;
  const heapBefore = process.memoryUsage().heapUsed;
  const baselineAt = performance.now();
  const baseline = summarizePayload(large, 'body');
  const baselineMs = performance.now() - baselineAt;
  let timerDelayMs = 0;
  const scheduledAt = performance.now();
  const timer = new Promise((resolve) => setTimeout(() => { timerDelayMs = performance.now() - scheduledAt; resolve(); }, 0));
  const filteredAt = performance.now();
  const measured = summarizePayload(large, 'body', createCredentialFilter(['another-configured-value']));
  const filteredMs = performance.now() - filteredAt;
  await timer;
  knownValues = ['another-configured-value'];
  const appendAt = performance.now();
  invoke({ body: large }, (request, response) => {
    assert.equal(request.body, large);
    response.json({ ok: true });
  });
  const filterAndAppendMs = performance.now() - appendAt;
  const persistedLarge = newest();
  const heapDeltaMiB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  assert.equal(baseline.text.slice(0, -TOKENS.openai.length), measured.text.slice(0, -REDACTED_CREDENTIAL.length));
  assert.ok(!measured.text.includes(TOKENS.openai));
  assert.equal(persistedLarge.request.text, measured.text);
  assert.ok(filteredMs < 2_500 && timerDelayMs < 2_500 && filterAndAppendMs < 5_000,
    `unexpected matcher cost: filter ${filteredMs.toFixed(1)}ms, event-loop delay ${timerDelayMs.toFixed(1)}ms, append ${filterAndAppendMs.toFixed(1)}ms`);
  const adversarial = `${`sk-proj-short Authorizationish: Bearerish tokenization=${INCOMPLETE_KEY}\n`.repeat(24_000)}`;
  const adversarialAt = performance.now();
  const adversarialFiltered = createCredentialFilter([])(adversarial);
  const adversarialMs = performance.now() - adversarialAt;
  assert.equal(adversarialFiltered, adversarial, 'near-matches and incomplete markers are retained whole');
  assert.ok(adversarialMs < 2_500, `unexpected adversarial matcher cost: ${adversarialMs.toFixed(1)}ms`);
  const filterDashChain = (count) => {
    const input = Array.from({ length: count }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`).join('-');
    const startedAt = performance.now();
    const output = createCredentialFilter([])(input);
    return { input, output, ms: performance.now() - startedAt };
  };
  const dashChainSmall = filterDashChain(1_000);
  const dashChain = filterDashChain(4_000);
  assert.equal(dashChain.output, dashChain.input, 'a long dash-joined ordinary line is retained whole');
  assert.ok(dashChain.ms < 2_500 && dashChain.ms < (dashChainSmall.ms * 8) + 250,
    `unexpected dash-chain scaling: 1k ${dashChainSmall.ms.toFixed(1)}ms, 4k ${dashChain.ms.toFixed(1)}ms`);
  console.log(`operation-credentials performance: ${(large.length / 1024 / 1024).toFixed(2)} MiB representative; ${(adversarial.length / 1024 / 1024).toFixed(2)} MiB adversarial; baseline ${baselineMs.toFixed(1)}ms; filtered ${filteredMs.toFixed(1)}ms; adversarial ${adversarialMs.toFixed(1)}ms; dash-chain 1k ${dashChainSmall.ms.toFixed(1)}ms / 4k ${dashChain.ms.toFixed(1)}ms; event-loop delay ${timerDelayMs.toFixed(1)}ms; filter+append ${filterAndAppendMs.toFixed(1)}ms; heap delta ${heapDeltaMiB.toFixed(1)} MiB`);
  console.log('operation-credentials: newly persisted bytes filtered; domain values and legacy bytes preserved');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
