import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestPolicy, admissionFailure, normalizeOrigin, protectedRead, REQUEST_HEADERS } from '../src/request-admission.js';

const policy = createRequestPolicy({ SPACE_HOST: 'app.example', NODE_ENV: 'production' });
const check = (headers = {}, options = {}, config = policy) => admissionFailure({
  headers: { host: 'app.example', ...REQUEST_HEADERS, ...headers },
}, config, options);

test('exact origins, ports and malformed representations', () => {
  for (const origin of ['https://app.example', 'https://APP.example:443']) assert.equal(check({ origin }), null);
  for (const origin of ['http://app.example', 'https://app.example:444', 'https://other.example', 'https://sub.app.example',
    'null', '', 'https://app.example:', 'https://*.app.example', 'https://app.example/', 'https://app.example/path', 'https://app.example?x',
    'https://app.example#x', 'https://user@app.example', 'https://@app.example', 'https://%61pp.example',
    'https://app.example https://other.example', 'https://app.example, https://app.example']) {
    assert.equal(check({ origin }), 'untrusted-origin', origin);
  }
  assert.equal(normalizeOrigin('http://localhost:80'), 'http://localhost');
  assert.equal(normalizeOrigin('http://[::1]:7860'), 'http://[::1]:7860');
  assert.equal(check({ origin: ['https://app.example', 'https://app.example'] }), 'ambiguous-header');
  assert.equal(admissionFailure({ headers: { host: 'app.example', origin: 'https://app.example', ...REQUEST_HEADERS },
    rawHeaders: ['Origin', 'https://app.example', 'origin', 'https://app.example'] }, policy), 'ambiguous-header');
});

test('explicit local and production config; target identity ignores forwarding', () => {
  const local = createRequestPolicy({ PORT: '8123', AM_DEV_PORT: '5199' });
  for (const origin of ['http://localhost:8123', 'http://127.0.0.1:5199', 'http://[::1]:5199']) {
    assert.equal(check({ host: 'localhost:8123', origin }, {}, local), null);
  }
  assert.equal(check({ host: 'localhost:8123', origin: 'http://localhost:5173' }, {}, local), 'untrusted-origin');
  assert.equal(check({ origin: 'http://localhost:7860' }), 'untrusted-origin');
  assert.equal(check({ host: 'app.example:443' }), null);
  assert.equal(check({ host: 'app.example:80' }), 'untrusted-target');
  assert.equal(check({ host: 'unknown.example', 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' }), 'untrusted-target');
  assert.equal(check({ origin: 'https://unknown.example', forwarded: 'host=unknown.example' }), 'untrusted-origin');
  assert.equal(check({ host: '127.0.0.1:7860', 'x-am-request': undefined }), 'request-marker-required');
  const custom = createRequestPolicy({ NODE_ENV: 'production', AM_ALLOWED_ORIGINS: 'https://proxy.example:8443' });
  assert.equal(check({ host: 'proxy.example:8443', origin: 'https://proxy.example:8443' }, {}, custom), null);
  assert.equal(check({ host: '127.0.0.1:7860', origin: 'https://proxy.example:8443' }, {}, custom), null);
  for (const env of [{ NODE_ENV: 'production' }, { SPACE_ID: 'fixture/app' }, { SPACE_HOST: 'bad/path' },
    { AM_ALLOWED_ORIGINS: '*' }, { AM_ALLOWED_ORIGINS: '' }, { AM_ALLOWED_ORIGINS: 'https://app.example,' },
    { PORT: '0' }, { AM_DEV_PORT: '70000' }]) assert.throws(() => createRequestPolicy(env));
});

test('intent, native clients and Fetch Metadata are independent of attribution/auth-looking headers', () => {
  assert.equal(check(), null);
  for (const headers of [{}, { authorization: 'Bearer fixture' }, { 'x-am-origin': 'operator' }]) {
    assert.equal(check({ ...headers, 'x-am-request': undefined }), 'request-marker-required');
  }
  assert.equal(check({ 'x-am-request': '1, 1' }), 'request-marker-required');
  assert.equal(check({ origin: 'null', authorization: 'Bearer fixture' }), 'untrusted-origin');
  assert.equal(check({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), null);
  for (const site of ['same-site', 'cross-site', 'none']) {
    assert.equal(check({ 'sec-fetch-site': site }), 'origin-required');
  }
  // App requests inside a cross-origin ancestor must stay usable.
  assert.equal(check({ origin: 'https://app.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), null);
  for (const headers of [{ 'sec-fetch-site': 'future' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'document' }, { 'sec-fetch-user': '?1' }]) assert.equal(check(headers), 'fetch-metadata');
});

test('terminal browser and native handshakes use the same origin policy', () => {
  const ws = { websocket: true };
  assert.equal(check({ origin: 'https://app.example', 'x-am-request': undefined, 'sec-fetch-mode': 'websocket', 'sec-fetch-site': 'cross-site' }, ws), null);
  assert.equal(check({}, ws), null);
  assert.equal(check({ 'x-am-request': undefined }, ws), 'request-marker-required');
  assert.equal(check({ origin: 'null' }, ws), 'untrusted-origin');
  assert.equal(check({ origin: 'https://app.example:444' }, ws), 'untrusted-origin');
  assert.equal(check({ 'sec-fetch-site': 'cross-site' }, ws), 'origin-required');
});

test('contact/delivery and external-operation reads include route aliases', () => {
  for (const route of ['/api/remote/fixture/stream', '/api/remote/fixture/messages', '/API/REMOTE/fixture/MESSAGES/',
    '/api/update/check', '/api/backup/status', '/api/share/access', '/api/sessions/fixture/share/']) assert.ok(protectedRead(route), route);
  for (const route of ['/api/health', '/api/info', '/api/trace/fixture', '/api/files/fixture/raw',
    '/api/sessions/fixture/remote', '/api/remote/fixture/ping']) assert.equal(protectedRead(route), false, route);
});
