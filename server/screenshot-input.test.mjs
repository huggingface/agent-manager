#!/usr/bin/env node
/**
 * Attachment-input integration checks in a real browser:
 *   - stored bytes, response MIME, and preview headers come from detection;
 *   - a stopped terminal never reports a false insertion success;
 *   - an uploaded-but-uninserted screenshot can be retried without reupload;
 *   - attachment chips cannot mutate an in-flight send;
 *   - one clipboard image stays one chip across browser DataTransfer views;
 *   - document files stay inert downloads and can be sent beside images;
 *   - both rendered reader and Overview composers send structured attachments;
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
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';

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
const pdf = Buffer.from('%PDF-1.7\nopaque pdf data');
const docx = Buffer.from('PK\x03\x04opaque office data');

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

// A test server must not publish skills — the same strip migration.test.mjs,
// resize.test.mjs and mobile.test.mjs do, for the same reason: `SPACE_ID` is set
// when this runs inside the Space itself, and generateEnvSkill() then fans this
// checkout's environment skill into every live agent's skills dir, over the
// copies the running backend wrote. Those dirs come from $HOME, NOT from
// DATA_DIR, so a throwaway DATA_DIR does not contain the damage.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;

const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: {
    ...BASE_ENV,
    PORT: '7896', DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    AM_ALLOW_MISSING_ORIGIN: '1',
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
      && preview.headers.get('content-disposition')?.startsWith('inline;')
      && preview.headers.get('x-content-type-options') === 'nosniff'
      && preview.headers.get('content-security-policy') === 'sandbox');

  const documentUpload = await fetch(`${API}/api/sessions/${id}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('brief.pdf') },
    body: pdf,
  });
  const document = await documentUpload.json();
  const documentDownload = await fetch(`${API}${document.previewUrl}`);
  check('PDF uploads are preserved as inert downloadable files',
    documentUpload.status === 201
      && document.kind === 'file'
      && document.name === 'brief.pdf'
      && document.mime === 'application/pdf'
      && documentDownload.headers.get('content-disposition')?.startsWith('attachment;')
      && documentDownload.headers.get('x-content-type-options') === 'nosniff'
      && documentDownload.headers.get('content-security-policy') === 'sandbox',
    JSON.stringify({ status: documentUpload.status, kind: document.kind, name: document.name }));

  const svgUpload = await fetch(`${API}/api/sessions/${id}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'image/svg+xml', 'x-file-name': encodeURIComponent('diagram.svg') },
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>'),
  });
  const svg = await svgUpload.json();
  const svgDownload = await fetch(`${API}${svg.previewUrl}`);
  check('browser-active SVG is accepted only as a forced-download file',
    svgUpload.status === 201
      && svg.kind === 'file'
      && svgDownload.headers.get('content-type') === 'image/svg+xml'
      && svgDownload.headers.get('content-disposition')?.startsWith('attachment;')
      && svgDownload.headers.get('content-security-policy') === 'sandbox');

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

  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(API, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar .row[title^="screenshot-e2e"]').first().click();
  await page.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible' });
  await page.locator('.pane-head .ph-image').waitFor({ state: 'visible' });
  await waitFor(() => page.locator('.pane-head .ph-image').isEnabled());
  check('terminal file picker accepts documents and other regular files',
    await page.locator('.pane-head .ph-image').getAttribute('aria-label') === 'Attach files'
      && await page.locator('.pane-head .image-file-input').getAttribute('accept') === null);

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
  check('retry inserts the already-uploaded file after restart',
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
  await watcher.locator('.pane-head .ph-image').waitFor({ state: 'visible' });
  await waitFor(() => watcher.locator('.pane-head .ph-image').isDisabled());
  check('a shared-terminal watcher cannot inject into the controller composer',
    await watcher.locator('.pane-head .ph-image').isDisabled()
      && (await watcher.locator('.pane-head .ph-image').getAttribute('title'))?.includes('take control'));
  await watcher.close();

  // Reader mode is an overlay above the mounted terminal. Its own composer must
  // own files while visible: inserting into the hidden xterm would leave an
  // invisible half-written prompt, and the reply button would know nothing
  // about the upload. A small synthetic trace makes the reader available for
  // this terminal fixture without depending on a real provider transcript.
  const traceAt = Date.now();
  const traceTurns = [
    { role: 'user', ts: traceAt - 1000, blocks: [{ type: 'text', text: 'fixture prompt' }] },
    { role: 'assistant', kind: 'final', ts: traceAt, blocks: [{ type: 'text', text: 'fixture answer' }] },
  ];
  await page.route(`**/api/trace/${id}*`, async (route) => {
    const common = {
      harness: 'test-repaint', harnessLabel: 'Repaint fixture', sessionId: id,
      title: 'screenshot-e2e', model: 'fixture', cwd: '.', firstTs: traceAt - 1000,
      lastTs: traceAt, usage: null, note: null, total: traceTurns.length,
      truncated: false, userTurns: [0],
    };
    if (new URL(route.request().url()).searchParams.has('summary')) {
      await route.fulfill({ json: common });
      return;
    }
    await route.fulfill({ json: {
      ...common, turns: traceTurns, offset: 0, limit: traceTurns.length,
      window: { mode: 'index', start: 0, end: traceTurns.length, atStart: true, atEnd: true },
    } });
  });
  await page.locator('.modebar button', { hasText: 'reader' }).click();
  const readerPicker = page.locator('.pane-reader .image-file-input');
  await readerPicker.waitFor({ state: 'attached' });
  check('reader owns the visible attachment picker instead of the hidden terminal',
    await page.locator('.pane-reader .image-pick').isVisible()
      && await page.locator('.pane-head .ph-image').count() === 0);
  await readerPicker.setInputFiles({ name: 'reader.png', mimeType: 'image/png', buffer: png });
  await page.locator('.pane-reader .image-chip').waitFor({ state: 'visible' });
  let readerInput;
  let sawReaderInput;
  const readerInputReached = new Promise((resolve) => { sawReaderInput = resolve; });
  await page.route(`**/api/sessions/${id}/input`, async (route) => {
    readerInput = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
    sawReaderInput();
  }, { times: 1 });
  await page.locator('.pane-reader .ov-send').click();
  await Promise.race([
    readerInputReached,
    sleep(10_000).then(() => { throw new Error('reader input did not send'); }),
  ]);
  check('reader sends an image-only structured turn',
    readerInput?.text === '' && readerInput?.attachmentIds?.length === 1,
    JSON.stringify(readerInput));

  // Overview tiles open a conversation window. It uses the same structured
  // delivery contract even though no terminal pane is mounted in that view.
  await page.locator('.sidebar .ov-row').click();
  await page.locator('.ovt-tile').filter({
    has: page.locator('.ovt-name', { hasText: /^screenshot-e2e$/ }),
  }).click();
  const overviewPicker = page.locator('.ovw-win .image-file-input');
  await overviewPicker.waitFor({ state: 'attached' });
  await overviewPicker.setInputFiles({ name: 'overview.png', mimeType: 'image/png', buffer: png });
  await page.locator('.ovw-win .image-chip').waitFor({ state: 'visible' });
  let overviewInput;
  let sawOverviewInput;
  const overviewInputReached = new Promise((resolve) => { sawOverviewInput = resolve; });
  await page.route(`**/api/sessions/${id}/input`, async (route) => {
    overviewInput = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
    sawOverviewInput();
  }, { times: 1 });
  await page.locator('.ovw-win .ov-send').click();
  await Promise.race([
    overviewInputReached,
    sleep(10_000).then(() => { throw new Error('overview input did not send'); }),
  ]);
  check('Overview sends an image-only structured turn',
    overviewInput?.text === '' && overviewInput?.attachmentIds?.length === 1,
    JSON.stringify(overviewInput));
  await page.locator('.ovw-win .ov-x').click();

  // Keep the creation dialog focused on the prompt. Pasting still works, and
  // pasted chips remain removable, but choosing files belongs in live views.
  await page.locator('.bolt-btn').click();
  check('creation dialog omits the redundant file picker',
    await page.locator('.quick .image-pick').count() === 0
      && await page.locator('.quick .image-file-input').count() === 0);
  await page.locator('.quick-cli[title="Repaint fixture"]').click();

  // Hold the second upload. Once the first
  // chip says uploaded, every attachment mutation must remain disabled until
  // the single logical send transaction finishes.
  await page.locator('.quick-prompt').fill('inspect both files');
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
      && await page.locator('.quick-prompt').inputValue() === 'inspect both files');
  await page.locator('.quick-prompt').evaluate((element, bytes) => {
    const raw = atob(bytes);
    const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], 'requirements.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: transfer,
    }));
  }, docx.toString('base64'));
  check('DOCX paste creates a generic file chip beside the image',
    await page.locator('.quick .image-chip').count() === 2
      && await page.locator('.quick .image-chip-placeholder', { hasText: 'DOCX' }).count() === 1);
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
