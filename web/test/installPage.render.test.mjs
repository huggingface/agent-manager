// The locked pages a visitor sees (Locked.tsx): the GitHub link on each, and
// on the public-space install guide the launch film above the two steps.
// Real component, server-rendered to markup; no browser needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Written next to the tests so the externals (react, react-dom) resolve from web/node_modules.
const dir = fs.mkdtempSync(path.join(web, 'test', '.install-page-'));
const out = path.join(dir, 'locked.mjs');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import Locked, { LAUNCH_FILM, REPO_URL } from './src/components/Locked';
    export const render = (props) => renderToStaticMarkup(createElement(Locked, props));
    export { LAUNCH_FILM, REPO_URL };
  ` },
  outfile: out, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' }, external: ['react', 'react-dom', 'react/*', 'react-dom/*'],
});
let render, LAUNCH_FILM, REPO_URL;
try { ({ render, LAUNCH_FILM, REPO_URL } = await import(pathToFileURL(out).href)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }

const FILM = 'https://huggingface.co/datasets/lvwerra/agent-manager-video/resolve/main';
assert.equal(REPO_URL, 'https://github.com/huggingface/agent-manager');
assert.deepEqual({ ...LAUNCH_FILM }, {
  src: `${FILM}/agent-manager-720.mp4`, hd: `${FILM}/agent-manager-1080.mp4`, poster: `${FILM}/poster.jpg`,
});

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k.toLowerCase(), v ?? '']));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => ({ at: m.index, ...attrs(m[0]) }));
const unescape = (s) => s.replaceAll('&amp;', '&');

// The GitHub link: on every locked page, next to the heading.
const pages = {
  'public-space': render({ spaceId: 'owner/space', reason: 'public-space' }),
  'public-bucket': render({ spaceId: 'owner/space', reason: 'public-bucket', bucket: 'owner/data' }),
  checking: render({ spaceId: 'owner/space', reason: 'checking', status: null }),
  'verification-unavailable': render({ spaceId: 'owner/space', reason: 'verification-unavailable', status: null }),
};
for (const [reason, html] of Object.entries(pages)) {
  const links = tags(html, 'a').filter((a) => a.href === REPO_URL);
  assert.equal(links.length, 1, `${reason}: one GitHub link`);
  const [gh] = links;
  assert.equal(gh['aria-label'], 'Agent Manager on GitHub', `${reason}: accessible label`);
  assert.equal(gh.target, '_blank', `${reason}: opens a new tab`);
  assert.equal(gh.rel, 'noreferrer', `${reason}: no referrer`);
  const h1 = html.indexOf('<h1>');
  assert.ok(h1 >= 0 && h1 < gh.at && html.slice(h1, gh.at).includes('</h1>'), `${reason}: the link sits right after the heading`);
  assert.ok(html.slice(gh.at, html.indexOf('</a>', gh.at)).includes('<svg'), `${reason}: the mark is inline SVG`);
  if (reason !== 'public-space') assert.equal(tags(html, 'video').length, 0, `${reason}: no film`);
}

// The film: public-space only, above step 1, user-started.
{
  const html = pages['public-space'];
  const videos = tags(html, 'video');
  assert.equal(videos.length, 1, 'one video');
  const [v] = videos;
  assert.equal(unescape(v.src), LAUNCH_FILM.src);
  assert.equal(unescape(v.poster), LAUNCH_FILM.poster);
  assert.ok('controls' in v, 'controls');
  assert.equal(v.preload, 'none', 'nothing downloads before play');
  assert.ok('playsinline' in v, 'plays inline on iOS');
  assert.ok(!('autoplay' in v), 'no autoplay');
  assert.ok(!('muted' in v) && !('loop' in v), 'not a muted background loop');
  assert.ok(v.at < html.indexOf('Duplicate this Space'), 'above the two steps');
  const hd = tags(html, 'a').find((a) => unescape(a.href) === LAUNCH_FILM.hd);
  assert.ok(hd, 'a 1080p link');
  assert.equal(hd.target, '_blank'); assert.equal(hd.rel, 'noreferrer');
  assert.match(html.slice(hd.at, html.indexOf('</a>', hd.at)), /Watch in 1080p ↗/);
}
console.log('install page: all checks passed');
