#!/usr/bin/env node
/**
 * Screenshot-input integration checks in a real browser:
 *   - stored bytes, response MIME, and preview headers come from detection;
 *   - a stopped terminal never reports a false insertion success;
 *   - an uploaded-but-uninserted screenshot can be retried without reupload;
 *   - attachment chips cannot mutate an in-flight send;
 *   - one clipboard image stays one chip across browser DataTransfer views;
 *   - the creation dialog has no redundant file picker.
 *
 * Set SCREENSHOT_PUBLIC_DIR to a prebuilt web/dist to skip the build.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-screenshot-ui-'));
const PUBLIC_DIR = process.env.SCREENSHOT_PUBLIC_DIR || path.join(DATA_DIR, 'public');
const API = 'http://127.0.0.1:7896';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const png = Buffer.alloc(45);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(13, 8); Buffer.from('IHDR').copy(png, 12);
png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
Buffer.from('IEND').copy(png, 37);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const waitFor = async (fn, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch {}
    await sleep(100);
  }
  return false;
};
const apiJson = async (url, init) => {
  const response = await fetch(`${API}${url}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
};

if (!process.env.SCREENSHOT_PUBLIC_DIR) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], {
    cwd: path.join(ROOT, 'web'), encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`web build failed:\n${build.stdout}\n${build.stderr}`);
}

const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: {
    ...process.env,
    PORT: '7896', DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    AM_TEST_REPAINT_CMD: 'bash --noprofile --norc',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
backend.stdout.on('data', (data) => { logs += data; });
backend.stderr.on('data', (data) => { logs += data; });

let browser;
try {
  if (!await waitFor(() => fetch(`${API}/api/health`).then((response) => response.ok).catch(() => false), 60_000)) {
    throw new Error(`server did not start:\n${logs.slice(-2000)}`);
  }
  await fetch(`${API}/api/welcome/seen`, { method: 'POST' });

  const created = await apiJson('/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'test-repaint', name: 'screenshot-e2e', path: '.' }),
  });
  const id = created.body.id;
  if (!id) throw new Error(`session creation failed: ${JSON.stringify(created.body)}`);

  // The browser's declared type is deliberately non-canonical. The response
  // and raw preview must reflect the PNG bytes, not that metadata.
  const upload = await fetch(`${API}/api/sessions/${id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: png,
  });
  const stored = await upload.json();
  check('upload MIME is detected from bytes', upload.status === 201 && stored.mime === 'image/png',
    JSON.stringify({ status: upload.status, mime: stored.mime }));
  const preview = await fetch(`${API}${stored.previewUrl}`);
  check('preview uses private, sandboxed response headers',
    preview.headers.get('content-type') === 'image/png'
      && preview.headers.get('cache-control') === 'no-store'
      && preview.headers.get('x-content-type-options') === 'nosniff'
      && preview.headers.get('content-security-policy') === 'sandbox');

  const missingId = `att_${'0'.repeat(24)}`;
  const mixedSend = await apiJson(`/api/sessions/${id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'must not send partially', attachmentIds: [stored.id, missingId] }),
  });
  const sessionsAfterReject = await (await fetch(`${API}/api/sessions`)).json();
  check('structured send rejects atomically before starting the agent',
    mixedSend.response.status === 404
      && sessionsAfterReject.find((session) => session.id === id)?.running === false,
    JSON.stringify({ status: mixedSend.response.status, error: mixedSend.body.error }));

  const remoteCreated = await apiJson('/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'remote', name: 'remote-screenshot-e2e', path: '.' }),
  });
  const remoteUpload = await fetch(`${API}/api/sessions/${remoteCreated.body.id}/attachments`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
  });
  const remoteUploadBody = await remoteUpload.json();
  check('remote uploads are rejected with an actionable reason',
    remoteUpload.status === 400 && remoteUploadBody.error.includes('cannot read files stored on this Space'));

  const bakedChromium = '/opt/pw-browsers/chromium-1208/chrome-linux64/chrome';
  const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (fs.existsSync(bakedChromium) ? bakedChromium : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(API, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar .row[title^="screenshot-e2e"]').first().click();
  await page.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible' });
  await page.locator('.pane-head .ph-image').waitFor({ state: 'visible' });
  await waitFor(() => page.locator('.pane-head .ph-image').isEnabled());

  // Let the upload finish, stop the process, and only then expose the response
  // to the UI. The following insert request must fail authoritatively.
  let disconnectedAttachmentId;
  await page.route(`**/api/sessions/${id}/attachments`, async (route) => {
    const response = await route.fetch();
    disconnectedAttachmentId = (await response.json()).id;
    await fetch(`${API}/api/sessions/${id}/stop`, { method: 'POST' });
    await route.fulfill({ response });
  }, { times: 1 });
  await page.locator('.pane-head .image-file-input').setInputFiles({
    name: 'disconnect.png', mimeType: 'image/png', buffer: png,
  });
  const retryStatus = page.locator('.term-image-status.has-action');
  await retryStatus.waitFor({ state: 'visible' });
  const failedText = await retryStatus.textContent();
  check('a stopped terminal reports saved-but-not-inserted, never success',
    !!failedText?.includes('saved but not inserted') && !failedText.includes('press Enter'),
    JSON.stringify({ failedText }));
  await page.locator('.term-exit').waitFor({ state: 'visible' });
  check('terminal attachment picker is unavailable while stopped',
    await page.locator('.pane-head .ph-image').isDisabled());

  await page.locator('.term-exit .tx-btn').click();
  await waitFor(() => page.locator('.pane-head .ph-image').isEnabled(), 20_000);
  const retry = retryStatus.locator('button');
  await retry.click();
  await page.locator('.term-image-status.success').waitFor({ state: 'visible' });
  const successText = await page.locator('.term-image-status.success').textContent();
  check('retry inserts the already-uploaded screenshot after restart',
    !!successText?.includes('inserted') && successText.includes('press Enter'),
    JSON.stringify({ successText }));
  const terminalTail = await (await fetch(`${API}/api/agents/${id}/tail?lines=80`)).json();
  check('terminal retry reaches the PTY without submitting the prompt',
    terminalTail.text.includes('Screenshot:') && !terminalTail.text.includes('command not found'));
  const repeatedInsert = await apiJson(`/api/sessions/${id}/attachments/insert`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attachmentIds: [disconnectedAttachmentId] }),
  });
  const tailAfterRepeat = await (await fetch(`${API}/api/agents/${id}/tail?lines=80`)).json();
  const insertedCount = (value) => (value.match(/Screenshot:/g) || []).length;
  check('retry is idempotent if the successful HTTP response was lost',
    repeatedInsert.body.repeated === true
      && insertedCount(tailAfterRepeat.text) === insertedCount(terminalTail.text));

  const watcher = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await watcher.goto(API, { waitUntil: 'domcontentloaded' });
  await watcher.locator('.sidebar .row[title^="screenshot-e2e"]').first().click();
  await watcher.locator('.ph-role', { hasText: 'watching' }).waitFor({ state: 'visible' });
  check('a shared-terminal watcher cannot inject into the controller composer',
    await watcher.locator('.pane-head .ph-image').isDisabled()
      && (await watcher.locator('.pane-head .ph-image').getAttribute('title'))?.includes('take control'));
  await watcher.close();

  // Keep the creation dialog focused on the prompt. Pasting still works, and
  // pasted chips remain removable, but choosing files belongs in live views.
  await page.locator('.bolt-btn').click();
  check('creation dialog omits the redundant image picker',
    await page.locator('.quick .image-pick').count() === 0
      && await page.locator('.quick .image-file-input').count() === 0);
  await page.locator('.quick-cli[title="Repaint fixture"]').click();

  // Hold the second upload. Once the first
  // chip says uploaded, every attachment mutation must remain disabled until
  // the single logical send transaction finishes.
  await page.locator('.quick-prompt').fill('inspect both screenshots');
  await page.locator('.quick-prompt').evaluate((element, bytes) => {
    const raw = atob(bytes);
    const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    // WebKit can expose one clipboard image as distinct File instances through
    // items and files, including different timestamps. `files` must win rather
    // than merging both browser views.
    const itemFile = new File([data], 'first.jpg', { type: 'image/jpg', lastModified: 1 });
    const listedFile = new File([data], 'first.jpg', { type: 'image/jpg', lastModified: 2 });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      items: [{ kind: 'file', type: 'image/jpg', getAsFile: () => itemFile }],
      files: [listedFile],
    } });
    element.dispatchEvent(event);
  }, png.toString('base64'));
  check('clipboard image paste uses the canonical file list once and preserves prompt text',
    await page.locator('.quick .image-chip').count() === 1
      && await page.locator('.quick-prompt').inputValue() === 'inspect both screenshots');
  await page.locator('.quick-prompt').evaluate((element, bytes) => {
    const raw = atob(bytes);
    const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], 'second.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: transfer,
    }));
  }, png.toString('base64'));
  let releaseSecond;
  let sawSecond;
  const secondReached = new Promise((resolve) => { sawSecond = resolve; });
  const secondHold = new Promise((resolve) => { releaseSecond = resolve; });
  let uploadCount = 0;
  await page.route('**/api/sessions/*/attachments', async (route) => {
    uploadCount += 1;
    if (uploadCount === 2) {
      sawSecond();
      await secondHold;
    }
    await route.continue();
  });
  await page.locator('.quick-prompt').press('Enter');
  await Promise.race([
    secondReached,
    sleep(20_000).then(() => { throw new Error('second upload did not start'); }),
  ]);
  const removeButtons = page.locator('.quick .image-chip > button');
  check('attachment removal stays locked for the full send transaction',
    await removeButtons.nth(0).isDisabled()
      && await removeButtons.nth(1).isDisabled());
  releaseSecond();
  await page.locator('.controls').waitFor({ state: 'hidden', timeout: 30_000 });
} finally {
  try { await browser?.close(); } catch {}
  backend.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
