import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import WebSocket from 'ws';
import { requestFixture } from './request-fixture.mjs';
import { REQUEST_HEADERS } from '../src/request-admission.js';

test('HTTP admission precedes body processing for every method/body and aliases', async () => {
  const f = await requestFixture();
  try {
    for (const [method, type, body] of [['POST', 'application/json', '{}'], ['PUT', 'text/plain', 'fixture'],
      ['PATCH', 'application/x-www-form-urlencoded', 'fixture=1'], ['DELETE', undefined, undefined],
      ['POST', 'application/octet-stream', 'fixture bytes'], ['POST', 'multipart/form-data; boundary=fixture', 'fixture']]) {
      const url = `${f.origin}/api/fixture`;
      const headers = type ? { 'content-type': type } : {};
      const denied = await fetch(url, { method, headers, body });
      assert.equal(denied.status, 403);
      const error = await denied.json();
      assert.equal(error.code, 'request-not-allowed');
      assert.match(error.error, /X-AM-Request: 1/);
      assert.equal(f.state.writes, f.state.bodies.length);
      const before = f.state.parsed;
      assert.equal((await fetch(url, { method, headers: { ...headers, ...REQUEST_HEADERS }, body })).status, 200);
      assert.equal(f.state.parsed, before + 1);
      assert.equal(f.state.bodies.at(-1), body || '');
    }
    assert.equal(f.state.writes, 6);
    assert.equal(f.state.parsed, 6, 'rejected bodies never reach capture/parser');
    for (const pathname of ['/api/remote/fixture/stream', '/API/REMOTE/fixture/MESSAGES/?agent=1', '/api/update/check']) {
      for (const method of ['GET', 'HEAD']) {
        assert.equal((await fetch(f.origin + pathname, { method })).status, 403);
        assert.equal(f.state.reads, 0);
      }
    }
    assert.equal((await fetch(`${f.origin}/api/remote/fixture/stream`, { headers: REQUEST_HEADERS })).status, 200);
    assert.equal(f.state.reads, 1);
    const before = f.state.parsed;
    const options = await fetch(`${f.origin}/api/fixture`, { method: 'OPTIONS', headers: {
      origin: 'https://unrelated.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-am-request',
    } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), null);
    assert.equal(f.state.parsed, before);
    for (const route of ['/api/health', '/api/trace/fixture', '/api/files/fixture/raw']) {
      assert.equal((await fetch(f.origin + route, { headers: { origin: 'null' } })).status, 200);
    }
    // A streaming sender need not supply (or finish) a body to get a refusal.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${f.origin}/api/sessions/fixture/attachments`, { method: 'POST', headers: {
        'content-type': 'application/octet-stream', 'content-length': '1000000',
      } }, (res) => { resolve(res.statusCode); res.resume(); req.destroy(); });
      req.on('error', reject); req.flushHeaders();
    });
    assert.equal(status, 403);
  } finally { await f.close(); }
});

test('upgrade refusals never attach/replay/control; a valid viewer remains usable', async () => {
  const f = await requestFixture();
  try {
    const url = f.origin.replace('http:', 'ws:') + '/ws?session=fixture';
    const valid = new WebSocket(url, { origin: f.origin });
    assert.equal(String((await once(valid, 'message'))[0]), 'fixture replay');
    for (const headers of [{}, { origin: 'null', ...REQUEST_HEADERS }, { origin: 'https://unrelated.example', ...REQUEST_HEADERS },
      { origin: f.origin, 'sec-fetch-mode': 'websocket', 'sec-fetch-dest': 'document' }]) {
      const bad = new WebSocket(url, { headers });
      const response = await new Promise((resolve, reject) => {
        bad.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); bad.terminate(); });
        bad.on('error', () => {});
        bad.on('open', () => reject(new Error('unexpected successful upgrade')));
        bad.on('message', () => reject(new Error('unexpected replay')));
      });
      assert.equal(response, 403);
    }
    assert.equal(f.state.upgrades, 1);
    assert.equal(f.state.controls, 0);
    valid.send('fixture control');
    assert.equal(String((await once(valid, 'message'))[0]), 'fixture acknowledgement');
    const native = new WebSocket(url, { headers: REQUEST_HEADERS });
    assert.equal(String((await once(native, 'message'))[0]), 'fixture replay');
    assert.equal(f.state.upgrades, 2);
  } finally { await f.close(); }
});

test('upgrade adapter accepts WebSocket metadata without allowing it on HTTP actions', async () => {
  const f = await requestFixture();
  try {
    const denied = await fetch(`${f.origin}/api/fixture`, { method: 'POST', headers: {
      ...REQUEST_HEADERS, origin: f.origin, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'websocket',
    } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).reason, 'fetch-metadata');
    assert.equal(f.state.parsed, 0);
    assert.equal(f.state.writes, 0);

    const url = f.origin.replace('http:', 'ws:') + '/ws?session=fixture';
    for (const dest of [undefined, 'empty', 'websocket']) {
      const headers = { 'sec-fetch-mode': 'websocket', 'sec-fetch-site': 'cross-site' };
      if (dest !== undefined) headers['sec-fetch-dest'] = dest;
      const ws = new WebSocket(url, { origin: f.origin, headers });
      assert.equal(String((await once(ws, 'message'))[0]), 'fixture replay');
    }
    assert.equal(f.state.upgrades, 3);
    assert.equal(f.state.controls, 0);
  } finally { await f.close(); }
});
