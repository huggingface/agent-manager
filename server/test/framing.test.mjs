// Framing policy: every response says who may embed the app (CSP
// frame-ancestors), in a Space and out of one, and the override parses safely.
// Actual production route stack against isolated state; no network, no agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { frameAncestorOrigins, frameAncestorsDirective, mergeFrameAncestors } from '../src/framing.js';
import { REQUEST_HEADERS } from '../src/request-admission.js';
import { framingServers } from './fixtures/framing-server.mjs';

test('frame-ancestors origins: Hub only in a Space, extras validated', () => {
  assert.deepEqual(frameAncestorOrigins({}), []);
  assert.deepEqual(frameAncestorOrigins({ SPACE_ID: 'o/s', SPACE_HOST: 'o-s.hf.space' }), ['https://huggingface.co']);
  assert.equal(frameAncestorsDirective([]), "frame-ancestors 'self'");
  assert.equal(frameAncestorsDirective(['https://huggingface.co']), "frame-ancestors 'self' https://huggingface.co");
  assert.deepEqual(frameAncestorOrigins({ AM_FRAME_ANCESTORS: ' https://Portal.Example , http://localhost:8080 ' }),
    ['https://portal.example', 'http://localhost:8080']);
  assert.deepEqual(frameAncestorOrigins({ SPACE_ID: 'o/s', AM_FRAME_ANCESTORS: 'https://huggingface.co,https://a.example:443' }),
    ['https://huggingface.co', 'https://a.example'], 'duplicates collapse, default ports normalise');
  assert.deepEqual(frameAncestorOrigins({ AM_FRAME_ANCESTORS: '' }), []);
  assert.deepEqual(frameAncestorOrigins({ AM_FRAME_ANCESTORS: '   ' }), []);
  for (const bad of ['*', "'self'", "'none'", 'https://*.example', 'https://a.example/path', 'https://a.example/',
    'https://a.example; script-src *', 'https://a.example https://b.example', 'javascript:alert(1)', 'data:',
    'ftp://a.example', 'a.example', 'https://user@a.example', 'https://a.example?x', 'https://a.example#x',
    'https://a.example,', ',https://a.example', 'https://a.example\nframe-ancestors *', 'null']) {
    assert.throws(() => frameAncestorOrigins({ AM_FRAME_ANCESTORS: bad }), /AM_FRAME_ANCESTORS/, JSON.stringify(bad));
  }
});

test('merging keeps an existing policy and never duplicates the directive', () => {
  const d = "frame-ancestors 'self'";
  assert.equal(mergeFrameAncestors(undefined, d), d);
  assert.equal(mergeFrameAncestors('', d), d);
  assert.equal(mergeFrameAncestors('sandbox', d), `sandbox; ${d}`);
  assert.equal(mergeFrameAncestors("default-src 'none'; ", d), `default-src 'none'; ${d}`);
  assert.equal(mergeFrameAncestors("sandbox; frame-ancestors 'none'", d), "sandbox; frame-ancestors 'none'");
  assert.equal(mergeFrameAncestors("FRAME-ANCESTORS 'none'", d), "FRAME-ANCESTORS 'none'");
  assert.equal(mergeFrameAncestors("default-src x-frame-ancestors", d), `default-src x-frame-ancestors; ${d}`);
  assert.deepEqual(mergeFrameAncestors(['sandbox', "img-src 'self'"], d), [`sandbox; ${d}`, "img-src 'self'"]);
});

// ---------- the real server ----------
const fixture = await framingServers();
const publicDir = fixture.publicDir;
fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>fixture SPA</title>');
fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'console.log("fixture")');
const startServer = fixture.start;

const csp = (r) => r.headers.get('content-security-policy');
// The directive this response enforces, read the way a browser does: the
// first frame-ancestors in the policy wins.
const ancestorsOf = (r) => {
  const d = (csp(r) || '').split(/[;,]/).map((s) => s.trim()).find((s) => /^frame-ancestors\s/i.test(s));
  return d ? d.split(/\s+/).slice(1) : null;
};

async function everyResponseCarries(srv, expected) {
  const seen = [];
  const check = async (label, url, init = {}) => {
    const r = await fetch(srv.base + url, { ...init, signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    assert.deepEqual(ancestorsOf(r), expected, `${label} (${r.status}) carries frame-ancestors: ${csp(r)}`);
    assert.equal(r.headers.get('x-frame-options'), null, `${label}: no X-Frame-Options`);
    assert.ok(!/,/.test(csp(r) || ''), `${label}: one CSP header, not two`);
    seen.push([label, r.status, csp(r)]);
    return r;
  };
  const marker = { ...REQUEST_HEADERS, 'x-am-origin': 'operator' };
  assert.equal((await check('HTML index', '/')).status, 200);
  assert.equal((await check('HTML index by name', '/index.html')).status, 200);
  assert.match((await check('SPA fallback', '/sessions/anything')).headers.get('content-type'), /html/);
  assert.equal((await check('static asset', '/assets/app.js')).status, 200);
  assert.equal((await check('static directory redirect', '/assets', { redirect: 'manual' })).status, 301);
  assert.equal((await check('HEAD of page', '/', { method: 'HEAD' })).status, 200);
  assert.equal((await check('API JSON', '/api/health')).status, 200);
  assert.equal((await check('API info', '/api/info')).status, 200);
  assert.equal((await check('API 404', '/api/no-such-route')).status, 404);
  assert.equal((await check('non-API 404', '/no-such-page', { method: 'POST', headers: marker })).status, 404);
  assert.equal((await check('admission refusal', '/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await check('bad JSON', '/api/groups', { method: 'POST', headers: { ...marker, 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await check('malformed path', '/api/files/%E0%A4%A/raw')).status, 400);
  assert.equal((await check('OPTIONS preflight', '/api/groups', { method: 'OPTIONS' })).status, 204);
  // A 500 from the real error path.
  const rev = (await (await fetch(srv.base + '/api/config', { headers: marker })).json()).rev;
  fs.writeFileSync(path.join(srv.dataDir, 'reject-write'), 'x');
  const failed = await check('500 error', `/api/config${rev ? `?base=${encodeURIComponent(rev)}` : ''}`,
    { method: 'PUT', headers: { ...marker, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(failed.status, 500);
  fs.unlinkSync(path.join(srv.dataDir, 'reject-write'));
  // A route with its own CSP keeps it and gains the directive.
  const session = await (await fetch(srv.base + '/api/sessions', { method: 'POST', headers: { ...marker, 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'files', path: '.', name: 'fixture' }) })).json();
  fs.writeFileSync(path.join(srv.dataDir, 'workspaces', 'page.html'), '<p>agent-written page</p>');
  const raw = await check('sandboxed file preview', `/api/files/${session.id}/raw?path=page.html`);
  assert.equal(raw.status, 200);
  assert.match(csp(raw), /^sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors /);
  assert.equal((await check('missing raw file', `/api/files/${session.id}/raw?path=nope.html`)).status, 404);
  return seen;
}

test('every response carries frame-ancestors, off a Space', async () => {
  const srv = await startServer('local', {});
  try {
    await everyResponseCarries(srv, ["'self'"]);
    assert.equal(csp(await fetch(srv.base + '/')), "frame-ancestors 'self'", 'no fetch directive on the page');
    const info = await (await fetch(srv.base + '/api/info')).json();
    assert.deepEqual(info.frameAncestors, []);
  } finally { await srv.stop(); }
});

test('every response carries frame-ancestors, in a Space (Hub allowed)', async () => {
  const srv = await startServer('space', { SPACE_ID: 'fixture/test', SPACE_HOST: 'fixture-test.hf.space' });
  try {
    await everyResponseCarries(srv, ["'self'", 'https://huggingface.co']);
    // The page's policy is frame-ancestors and nothing else: no fetch directive
    // (default-src, media-src, img-src) limits where the install page's film and
    // poster load from (huggingface.co, redirecting to its CDN).
    assert.equal(csp(await fetch(srv.base + '/')), "frame-ancestors 'self' https://huggingface.co");
    const info = await (await fetch(srv.base + '/api/info')).json();
    assert.deepEqual(info.frameAncestors, ['https://huggingface.co']);
  } finally { await srv.stop(); }
});

test('AM_FRAME_ANCESTORS adds origins; invalid values stop startup', async () => {
  const srv = await startServer('extra', { SPACE_ID: 'fixture/test', SPACE_HOST: 'fixture-test.hf.space',
    AM_FRAME_ANCESTORS: 'https://portal.example,http://localhost:9999' });
  try {
    const r = await fetch(srv.base + '/');
    assert.deepEqual(ancestorsOf(r), ["'self'", 'https://huggingface.co', 'https://portal.example', 'http://localhost:9999']);
  } finally { await srv.stop(); }
  const bad = await startServer('bad', { AM_FRAME_ANCESTORS: "* 'unsafe-inline'" }).catch((e) => e);
  assert.ok(bad instanceof Error, 'a server with an invalid AM_FRAME_ANCESTORS must not come up');
  assert.match(bad.message, /AM_FRAME_ANCESTORS must contain exact http\(s\) origins/);
});

test.after(() => fixture.cleanup());
