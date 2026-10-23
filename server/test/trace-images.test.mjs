// Images in the reader, by reference. A conversation response names each image
// with a small ref ({type:'image', ref, mediaType, bytes, width, height}) and
// never carries its data; GET …/image/:ref serves the bytes, and only bytes
// that sit in the transcript that route resolves. Against the real route
// stack, over a throwaway DATA_DIR. Run with:  node test/trace-images.test.mjs
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-trace-images-'));
const DATA_DIR = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const PORT = String(await freePort());
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(DATA_DIR, { recursive: true });
const PROJECTS = path.join(HOME, '.claude', 'projects', 'am');
fs.mkdirSync(PROJECTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ---- fixture images: real headers, distinct filler, big enough to matter ----
const filler = (n, seed) => {
  const b = Buffer.alloc(n);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
};
const png = (w, h, seed) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, filler(150_000, seed)]);
};
const jpeg = (w, h, seed) => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, filler(120_000, seed)]);
};
const gif = (w, h, seed) => {
  const head = Buffer.from('GIF89a\0\0\0\0', 'latin1');
  head.writeUInt16LE(w, 6); head.writeUInt16LE(h, 8);
  return Buffer.concat([head, filler(40_000, seed)]);
};
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
const notImage = Buffer.from('#!/bin/sh\necho this is not an image\n'.repeat(50));

const IMG = {
  pasted: png(1920, 1080, 1),
  shotA: png(1280, 720, 2),
  shotB: jpeg(800, 600, 3),
  anim: gif(64, 32, 4),
  vector: svg,
  bogus: notImage,
  other: png(640, 480, 5),
  viewed: png(320, 200, 6),
};
const b64 = (k) => IMG[k].toString('base64');
const claudeImage = (k, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64(k) } });

// A Claude session whose transcript holds a pasted screenshot, a tool result
// carrying two screenshots, a GIF, an SVG and a non-image under an image type.
const workdir = (name) => path.join(DATA_DIR, 'workspaces', name);
const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const claudeTranscript = (cwd, lines) => lines.map((l, i) => JSON.stringify({ cwd, timestamp: at(i), ...l })).join('\n') + '\n';
const shotsLines = (cwd) => claudeTranscript(cwd, [
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'what is wrong with this page?' }, claudeImage('pasted')] } },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__browser__screenshot', input: { full: true } }] } },
  { type: 'user', toolUseResult: { type: 'image', file: { base64: b64('shotA') } },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [claudeImage('shotA'), claudeImage('shotB', 'image/jpeg'), { type: 'text', text: 'two captures' }] }] } },
  { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/w/a.gif' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [claudeImage('anim', 'image/gif')] }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'and these' }, claudeImage('vector', 'image/svg+xml'), claudeImage('bogus')] } },
  { type: 'assistant', message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'The header overlaps the nav.' }], stop_reason: 'end_turn' } },
]);

// A classic Codex rollout (in a workspace, opened through the Files pane) whose
// view_image answers with an input_image part.
const rollout = [
  { type: 'session_meta', payload: { id: '01a00000-0000-7000-8000-000000000001', cwd: '/w' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look at it' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'view_image', call_id: 'c1', arguments: '{"path":"/w/v.png"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1',
    output: [{ type: 'input_image', image_url: `data:image/png;base64,${b64('viewed')}`, detail: 'original' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Seen.' }] } },
].map((l, i) => JSON.stringify({ timestamp: at(i), ...l })).join('\n') + '\n';

const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
// For the locked run: the Space's own visibility check answers "public", which
// is what locks the manager. Nothing else in the process is stubbed.
const preload = path.join(TMP, 'public-space.mjs');
fs.writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify({ id: process.env.SPACE_ID, private: false, runtime: { volumes: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });\n`);
let logs = '';
let backend = null;
const start = async ({ locked = false } = {}) => {
  backend = spawn('node', [...(locked ? ['--import', preload] : []), 'src/index.js'], {
    cwd: ROOT,
    env: {
      ...BASE_ENV,
      PORT, DATA_DIR, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), CODEX_HOME: path.join(HOME, 'codex'),
      AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1',
      ...(locked ? { SPACE_ID: 'fixture/test', SPACE_HOST: 'fixture-test.hf.space' } : { SPACE_HOST: '' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => { logs += d; });
  backend.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 300; i += 1) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`server did not start:\n${logs.slice(-2000)}`);
};
const stop = async () => {
  if (!backend) return;
  const dead = new Promise((r) => backend.on('exit', r));
  backend.kill('SIGTERM');
  await Promise.race([dead, sleep(4_000)]);
  backend = null;
};
const post = (url, body) => fetch(`${API}${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const imagesOf = (page) => page.turns.flatMap((t) => t.blocks.filter((b) => b.type === 'image'));
const getBytes = async (url) => {
  const r = await fetch(`${API}${url}`);
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
};

try {
  await start();
  const shots = await (await post('/api/sessions', { cli: 'claude', name: 'shots', path: 'shots' })).json();
  const other = await (await post('/api/sessions', { cli: 'claude', name: 'other', path: 'other' })).json();
  fs.writeFileSync(path.join(PROJECTS, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), shotsLines(workdir('shots')));
  fs.writeFileSync(path.join(PROJECTS, 'aaaaaaaa-0000-4000-8000-000000000002.jsonl'), claudeTranscript(workdir('other'), [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'mine' }, claudeImage('other')] } },
  ]));

  // ---- the conversation carries refs, never data ----
  const allB64 = Object.keys(IMG).map(b64);
  for (const [mode, query] of [['window', 'tail=1&v=2'], ['index page', 'offset=0&limit=200']]) {
    const r = await fetch(`${API}/api/trace/${shots.id}?${query}`);
    const text = await r.text();
    const page = JSON.parse(text);
    const imgs = imagesOf(page);
    check(`${mode}: every image is a ref, with the route that serves it`, r.status === 200 && imgs.length === 6
      && imgs.every((b) => /^[0-9a-z]+\.[0-9a-f]{24}$/.test(b.ref) && b.src === `/api/trace/${shots.id}/image/${b.ref}`),
      JSON.stringify(imgs.map((b) => b.src)));
    check(`${mode}: no image data anywhere in the response`,
      !/base64/.test(text) && allB64.every((d) => !text.includes(d.slice(0, 64))) && text.length < 20_000,
      `${text.length} bytes`);
    if (mode === 'window') {
      const [pasted, a, b, anim] = imgs;
      check('size and type come with the ref, for a placeholder',
        pasted.width === 1920 && pasted.height === 1080 && pasted.mediaType === 'image/png' && pasted.bytes === IMG.pasted.length
          && b.width === 800 && b.height === 600 && b.mediaType === 'image/jpeg' && anim.width === 64 && anim.height === 32,
        JSON.stringify([pasted, b, anim]));
      // A tool's screenshots are image blocks after its result, not text in it.
      const blocks = page.turns.flatMap((t) => t.blocks);
      const res = blocks.find((x) => x.type === 'tool_result' && x.id === 'tu1');
      const i = blocks.indexOf(res);
      check('tool-result screenshots follow the result as images', res && res.text === 'two captures'
        && blocks[i + 1]?.ref === a.ref && blocks[i + 2]?.ref === b.ref, JSON.stringify(blocks.map((x) => x.type)));
    }
  }

  // ---- the endpoint returns exactly those bytes ----
  const page = await (await fetch(`${API}/api/trace/${shots.id}?tail=1&v=2`)).json();
  const [pasted, shotA, shotB, anim, vector, bogus] = imagesOf(page);
  const expect = [[pasted, 'pasted', 'image/png'], [shotA, 'shotA', 'image/png'], [shotB, 'shotB', 'image/jpeg'], [anim, 'anim', 'image/gif'], [vector, 'vector', 'image/svg+xml']];
  for (const [block, key, type] of expect) {
    const got = await getBytes(block.src);
    check(`${key}: exact bytes as ${type}`, got.status === 200 && got.body.equals(IMG[key]) && got.headers.get('content-type') === type,
      JSON.stringify({ status: got.status, type: got.headers.get('content-type'), bytes: got.body.length }));
  }
  const svgGot = await getBytes(`/api/trace/${shots.id}/image/${vector.ref}`);
  check('served inert: nosniff, a CSP sandbox, cached as immutable',
    svgGot.headers.get('x-content-type-options') === 'nosniff'
      && /^sandbox\b/.test(svgGot.headers.get('content-security-policy') || '')
      && !/allow-scripts/.test(svgGot.headers.get('content-security-policy') || '')
      && /immutable/.test(svgGot.headers.get('cache-control') || '') && /max-age=\d{6,}/.test(svgGot.headers.get('cache-control') || ''),
    JSON.stringify(Object.fromEntries(svgGot.headers)));
  const bogusGot = await getBytes(`/api/trace/${shots.id}/image/${bogus.ref}`);
  check('data that is not an image is not served, whatever type it claimed', bogusGot.status === 415, String(bogusGot.status));

  // ---- refusals ----
  const otherPage = await (await fetch(`${API}/api/trace/${other.id}?tail=1&v=2`)).json();
  const [otherRef] = imagesOf(otherPage).map((b) => b.ref);
  const ownOther = await getBytes(`/api/trace/${other.id}/image/${otherRef}`);
  check('the other session serves its own image', ownOther.status === 200 && ownOther.body.equals(IMG.other));
  const [off, hash] = pasted.ref.split('.');
  const refused = {
    'another session\'s ref': await getBytes(`/api/trace/${shots.id}/image/${otherRef}`),
    'an unknown hash': await getBytes(`/api/trace/${shots.id}/image/${off}.${'0'.repeat(24)}`),
    'an offset inside a record': await getBytes(`/api/trace/${shots.id}/image/${(parseInt(off, 36) + 7).toString(36)}.${hash}`),
    'an offset past the end': await getBytes(`/api/trace/${shots.id}/image/zzzzzz.${hash}`),
    'not a ref at all': await getBytes(`/api/trace/${shots.id}/image/..%2F..%2Fetc%2Fpasswd`),
    'an unknown session': await getBytes(`/api/trace/nope/image/${pasted.ref}`),
  };
  for (const [what, r] of Object.entries(refused)) {
    check(`refused: ${what}`, r.status === 404 && !allB64.some((d) => r.body.toString('latin1').includes(d.slice(0, 32))) && r.body.length < 1000,
      String(r.status));
  }

  // ---- a Files-pane trace: classic Codex view_image, served through its own route ----
  fs.writeFileSync(path.join(workdir('shots'), 'rollout.jsonl'), rollout);
  const fileTrace = await (await fetch(`${API}/api/files/${shots.id}/trace?path=rollout.jsonl&tail=1&v=2`)).json();
  const fileImgs = imagesOf(fileTrace);
  const viewedResult = fileTrace.turns.flatMap((t) => t.blocks).find((b) => b.type === 'tool_result' && b.id === 'c1');
  check('a classic view_image output is an image block, not base64 text',
    fileImgs.length === 1 && viewedResult && !/base64|data:image/.test(viewedResult.text) && fileImgs[0].width === 320,
    JSON.stringify({ fileImgs, text: viewedResult?.text?.slice(0, 80) }));
  check('a Files trace names its own image route', fileImgs[0]?.src === `/api/files/${shots.id}/trace/image/${fileImgs[0]?.ref}?path=rollout.jsonl`, fileImgs[0]?.src);
  const viewed = await getBytes(fileImgs[0].src);
  check('and the Files route serves it', viewed.status === 200 && viewed.body.equals(IMG.viewed) && viewed.headers.get('content-type') === 'image/png');
  const escaped = await getBytes(`/api/files/${shots.id}/trace/image/${otherRef}?path=${encodeURIComponent('../../../home/.claude/projects/am/aaaaaaaa-0000-4000-8000-000000000002.jsonl')}`);
  check('a path outside the workspace is refused', escaped.status === 404 && !escaped.body.equals(IMG.other), String(escaped.status));

  // ---- a trace pane over an imported bundle, and a Claude sub-agent ----
  const bundleDir = path.join(DATA_DIR, 'traces', 'user__shots');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'session.jsonl'), rollout);
  const pane = await (await post('/api/sessions', { cli: 'trace', name: 'Shared', path: '.' })).json();
  await fetch(`${API}/api/trace/${pane.id}/source`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bundle', ref: 'user__shots' }),
  });
  const [bundled] = imagesOf(await (await fetch(`${API}/api/trace/${pane.id}?tail=1&v=2`)).json());
  const fromBundle = bundled && await getBytes(bundled.src);
  check('a bundle pane serves the images its bundle holds', fromBundle?.status === 200 && fromBundle.body.equals(IMG.viewed));
  const fromBundleOther = await getBytes(`/api/trace/${pane.id}/image/${pasted.ref}`);
  check('and not the images of the session it is not', fromBundleOther.status === 404, String(fromBundleOther.status));

  const subDir = path.join(PROJECTS, 'aaaaaaaa-0000-4000-8000-000000000001', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'look' }));
  fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), claudeTranscript(workdir('shots'), [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'check the gif' }, claudeImage('anim', 'image/gif')] } },
  ]));
  // The roster lives beside a PINNED transcript, so pin it as a running pane would be.
  await stop();
  const sessionsFile = path.join(DATA_DIR, 'sessions.json');
  const stored = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  stored.find((entry) => entry.id === shots.id).sessionUuid = 'aaaaaaaa-0000-4000-8000-000000000001';
  fs.writeFileSync(sessionsFile, JSON.stringify(stored, null, 2));
  await start();
  const [subImg] = imagesOf(await (await fetch(`${API}/api/agents/${shots.id}/subagents/a1?tail=1&v=2`)).json());
  check('a sub-agent names its own image route', subImg?.src === `/api/agents/${shots.id}/subagents/a1/image/${subImg?.ref}`, subImg?.src);
  const fromSub = subImg && await getBytes(subImg.src);
  check('a sub-agent serves its own images', fromSub?.status === 200 && fromSub.body.equals(IMG.anim));
  const subOther = await getBytes(`/api/agents/${other.id}/subagents/a1/image/${subImg?.ref}`);
  check('and not through a session that is not its parent', subOther.status === 404, String(subOther.status));

  // ---- a locked manager serves none of it ----
  await stop();
  await start({ locked: true });
  const lockedGet = await fetch(`${API}/api/trace/${shots.id}/image/${pasted.ref}`);
  const lockedBody = await lockedGet.json().catch(() => ({}));
  check('a locked manager refuses the image route', lockedGet.status === 403 && lockedBody.code === 'locked',
    JSON.stringify({ status: lockedGet.status, code: lockedBody.code }));
} catch (e) {
  check('no exceptions', false, String(e && e.stack ? e.stack : e));
  console.log(`--- server log tail ---\n${logs.slice(-1500)}`);
} finally {
  await stop();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
