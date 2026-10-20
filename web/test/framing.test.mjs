// The in-app framing check (lib/framing.ts): which embeddings may render the
// app. Pure logic against fake window chains; the browser suite
// (framing.browser.test.mjs) drives real engines.
// Run:  node test/framing.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'framing-')), 'framing.mjs');
await build({ entryPoints: [path.join(HERE, '../src/lib/framing.ts')], outfile: out, format: 'esm', bundle: false, logLevel: 'error' });
const { ancestorOrigins, defaultTrusted, frameVerdict, HUB_ORIGIN } = await import(pathToFileURL(out).href);
const appUrlOut = path.join(path.dirname(out), 'appUrl.mjs');
await build({ entryPoints: [path.join(HERE, '../src/lib/appUrl.ts')], outfile: appUrlOut, format: 'esm', bundle: false, logLevel: 'error' });
const { appRootUrl } = await import(pathToFileURL(appUrlOut).href);

const APP = 'https://owner-space.hf.space';
const crossOrigin = () => { throw new DOMException('Blocked a frame', 'SecurityError'); };
// A window whose location is readable only when `readable` (same-origin to us).
function win(origin, { parent, listed, readable = true, opaque = false } = {}) {
  const url = new URL(origin);
  const location = readable
    ? { origin, hostname: url.hostname, href: `${origin}/`, ...(listed ? { ancestorOrigins: { length: listed.length, item: (i) => listed[i] ?? null } } : {}) }
    : { get origin() { return crossOrigin(); }, get hostname() { return crossOrigin(); } };
  const w = { location, origin: opaque ? 'null' : origin };
  w.self = w;
  w.parent = parent || w;
  w.top = parent ? parent.top : w;
  return w;
}
const chain = (...origins) => {
  // origins: outermost first; the last one is "us". `readable` from our side.
  let w;
  for (const [i, o] of origins.entries()) {
    const ours = i === origins.length - 1;
    w = win(o.origin, { parent: w, readable: ours || o.origin === origins.at(-1).origin, listed: ours ? o.listed : undefined, opaque: ours && o.opaque });
  }
  return w;
};

// Top-level: always the app.
{
  const w = win(APP);
  assert.deepEqual(ancestorOrigins({ win: w }), []);
  assert.equal(frameVerdict({ win: w }, defaultTrusted(w)), 'top');
}
// Defaults: the Hub is trusted for *.hf.space only.
assert.deepEqual(defaultTrusted(win(APP)), [APP, HUB_ORIGIN]);
assert.deepEqual(defaultTrusted(win('http://127.0.0.1:7860')), ['http://127.0.0.1:7860']);
assert.deepEqual(defaultTrusted(win('https://hf.space.evil.example')), ['https://hf.space.evil.example']);

const verdict = (w, trusted = defaultTrusted(w)) => frameVerdict({ win: w }, trusted);

// Engines that list ancestors (Chromium, WebKit, current Firefox).
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP, listed: [HUB_ORIGIN] })), 'trusted', 'the Hub Space page');
assert.equal(verdict(chain({ origin: APP }, { origin: APP, listed: [APP] })), 'trusted', 'the app framing itself');
assert.equal(verdict(chain({ origin: 'https://evil.example' }, { origin: APP, listed: ['https://evil.example'] })), 'untrusted');
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: 'https://evil-x.hf.space' }, { origin: APP, listed: ['https://evil-x.hf.space', HUB_ORIGIN] })),
  'untrusted', 'every ancestor counts: an attacker Space inside the Hub page');
assert.equal(verdict(chain({ origin: 'https://evil.example' }, { origin: HUB_ORIGIN }, { origin: APP, listed: [HUB_ORIGIN, 'https://evil.example'] })),
  'untrusted', 'a trusted parent inside an untrusted top');
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP, listed: ['null'] })), 'untrusted', 'a masked ancestor is unidentified');
assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP, listed: [HUB_ORIGIN], opaque: true })), 'untrusted',
  'a sandboxed (opaque-origin) frame never renders, even on the Hub');
assert.equal(verdict(chain({ origin: 'https://portal.example' }, { origin: APP, listed: ['https://portal.example'] }),
  [APP, HUB_ORIGIN, 'https://portal.example']), 'trusted', 'server-configured extra origin');
assert.equal(verdict(chain({ origin: 'https://huggingface.co.evil.example' }, { origin: APP, listed: ['https://huggingface.co.evil.example'] })), 'untrusted');

// Engines without ancestorOrigins: only same-origin ancestors can be verified.
// Any cross-origin ancestor fails closed, whatever document.referrer says (it
// names whoever navigated the frame, not its parent) — the Hub embed included.
{
  for (const referrer of ['', 'https://huggingface.co/', 'https://evil.example/', `${APP}/`]) {
    const evil = chain({ origin: 'https://evil.example' }, { origin: APP });
    // Offered the way an earlier version read it (env.referrer); it must not count.
    const env = { win: evil, referrer };
    assert.equal(ancestorOrigins(env), null, `foreign parent, referrer ${JSON.stringify(referrer)}: unverified`);
    assert.equal(frameVerdict(env, defaultTrusted(evil)), 'untrusted', `foreign parent, referrer ${JSON.stringify(referrer)}: fails closed`);
    assert.equal(frameVerdict(env, [APP, HUB_ORIGIN, 'https://evil.example']), 'untrusted',
      'even an allowed origin cannot be verified without ancestorOrigins');
  }
  assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: APP })), 'untrusted',
    'the Hub embed fails closed here too (the fallback button opens the app in its own tab)');
  assert.equal(verdict(chain({ origin: HUB_ORIGIN }, { origin: 'https://evil-x.hf.space' }, { origin: APP })), 'untrusted');
  const self = chain({ origin: APP }, { origin: APP });
  assert.deepEqual(ancestorOrigins({ win: self }), [APP]);
  assert.equal(verdict(self), 'trusted', 'same-origin parents are read directly');
  const selfInEvil = chain({ origin: 'https://evil.example' }, { origin: APP }, { origin: APP });
  assert.equal(verdict(selfInEvil), 'untrusted', 'a same-origin parent inside a foreign top');
}

// A throwing window.top (paranoid engines) is treated as framed.
{
  const w = win(APP);
  Object.defineProperty(w, 'top', { get: crossOrigin });
  assert.equal(verdict(w), 'untrusted');
}

// The fallback's link: the app root, nothing from the framed address.
for (const href of [`${APP}/?__sign=secret&x=1#h`, `${APP}/deep/path?vvdebug=1&token=abc&__sign=s#file=a.md`,
  `${APP}/?a=1&a=2&%F0%9F=x&redirect=https://evil.example`, `${APP}//evil.example/x?y`]) {
  const url = new URL(href);
  globalThis.location = { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, href: url.href };
  assert.equal(appRootUrl(), `${APP}/`, `fallback link from ${href}`);
}
delete globalThis.location;
console.log('framing: all checks passed');
