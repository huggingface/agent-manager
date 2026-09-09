import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-api-decoder-'));
const output = path.join(root, 'api.mjs');
await build({ entryPoints: ['src/api.ts'], outfile: output, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const api = await import(pathToFileURL(output));
const original = globalThis.fetch;
let calls = 0;
const respond = (body, status = 200, headers = { 'content-type': 'application/json' }) => {
  globalThis.fetch = async () => { calls++; return new Response(body, { status, headers }); };
};
const json = (body, status) => respond(JSON.stringify(body), status);
try {
  for (const status of [400, 403, 404, 409, 413, 429, 500, 502, 503, 504]) {
    json({ error: 'Useful refusal', code: 'fixture-refused', reason: 'fixture', tag: 'revision', retryAfter: 5, raw: 'must-not-retain' }, status);
    await assert.rejects(api.renameSession('one', 'draft'), (e) => e instanceof api.ApiError && e.status === status && e.code === 'fixture-refused' && e.message === 'Useful refusal' && e.data.tag === 'revision' && !('raw' in e.data));
  }
  json({ error: 'Legacy message' }, 400);
  await assert.rejects(api.createGroup('draft'), (e) => e.code === 'bad-request' && e.message === 'Legacy message');
  for (const body of ['', '<html>proxy diagnostics</html>', 'broken JSON {', JSON.stringify({ error: '<script>unsafe</script>' }), 'x'.repeat(70_000)]) {
    respond(body, 502);
    await assert.rejects(api.getTree(), (e) => e.status === 502 && !/proxy|script|diagnostics|SyntaxError/.test(e.message));
  }
  json({ error: 'No trace yet', code: 'no-trace', reason: 'new-session' }, 404);
  await assert.rejects(api.getTracePage('one'), (e) => e instanceof api.TraceUnavailable && e.status === 404 && e.data.reason === 'new-session');
  json({ error: 'Legacy no trace' }, 404);
  await assert.rejects(api.getTracePage('one'), (e) => e instanceof api.TraceUnavailable && e.code === 'no-trace');
  json({ error: 'API route not found', code: 'api-not-found' }, 404);
  await assert.rejects(api.getTracePage('one'), (e) => e instanceof api.ApiError && !(e instanceof api.TraceUnavailable));
  respond('<html>proxy not found</html>', 404);
  await assert.rejects(api.getTracePage('one'), (e) => e.status === 404 && !(e instanceof api.TraceUnavailable));
  json({ error: 'Server failed', code: 'internal-error' }, 500);
  await assert.rejects(api.getFileTracePage('one', 'fixture'), (e) => e.status === 500 && !(e instanceof api.TraceUnavailable));
  json({ error: 'Refused by redaction', code: 'redaction-blocked', hits: { fixture: 2 } }, 409);
  await assert.rejects(api.shareSession('one', { visibility: 'public' }), (e) => e instanceof api.RedactionBlocked && e.hits.fixture === 2 && e.status === 409);
  json({ error: 'changed on disk', code: 'file-changed', mtime: 123, tag: 'new' }, 409);
  await assert.rejects(api.writeFile('one', 'fixture', 'draft', 'old'), (e) => e.code === 'file-changed' && e.data.mtime === 123 && e.data.tag === 'new');
  json({ ok: false, reason: 'no-space' }); assert.deepEqual(await api.relaunchSpace(), { ok: false, reason: 'no-space' });
  respond(null, 204); assert.equal(await api.renameSession('one', 'draft'), undefined);
  respond('', 200); assert.equal(await api.renameSession('one', 'draft'), undefined);
  respond('{invalid', 200); await assert.rejects(api.getTree(), (e) => e.code === 'unreadable-response' && e.status === 200);
  respond('plain instructions', 200, { 'content-type': 'text/plain' }); assert.equal(await api.getRemotePrompt('one'), 'plain instructions');
  for (const [name, code] of [['AbortError', null], ['TimeoutError', 'timeout'], ['Error', 'network-error']]) {
    const originalError = new DOMException('synthetic private detail', name);
    globalThis.fetch = async () => { calls++; throw originalError; };
    const before = calls;
    await assert.rejects(api.renameSession('one', 'draft'), (e) => name === 'AbortError' ? e === originalError : e.code === code && !e.message.includes('private'));
    assert.equal(calls, before + 1, 'mutations are never replayed');
  }
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private stream data')); } }), { status: 503 });
  await assert.rejects(api.getTree(), (e) => e.code === 'network-error' && e.status === 503 && !e.message.includes('private'));
  let canceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(70_000)); }, cancel() { canceled = true; } }), { status: 502 });
  await assert.rejects(api.getTree(), (e) => e.status === 502);
  assert.equal(canceled, true, 'oversized failure bodies are canceled');
  let reads = 0;
  globalThis.fetch = async () => { const r = new Response('{"error":"once"}', { status: 400 }); const reader = r.body.getReader.bind(r.body); r.body.getReader = () => { reads++; return reader(); }; return r; };
  await assert.rejects(api.getTree(), /once/); assert.equal(reads, 1);
  console.log('API decoder: statuses, legacy/domain data, bounded single read, parsing and cancellation passed');
} finally { globalThis.fetch = original; fs.rmSync(root, { recursive: true, force: true }); }
