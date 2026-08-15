#!/usr/bin/env node
/**
 * Attachment-input integration checks in a real browser:
 *   - stored bytes, response MIME, and preview headers come from detection;
 *   - a stopped terminal never reports a false insertion success;
 *   - an uploaded-but-uninserted screenshot can be retried without reupload;
 *   - attachment chips cannot mutate an in-flight send;
 *   - one clipboard image stays one chip across browser DataTransfer views;
 *   - document files stay inert downloads and can be sent beside images;
 *   - attachment-time uploads expose progress and actionable transport errors;
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
const PORT = process.env.SCREENSHOT_PORT || '7896';
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const png = Buffer.alloc(45);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(13, 8); Buffer.from('IHDR').copy(png, 12);
png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
Buffer.from('IEND').copy(png, 37);
const progressPng = Buffer.alloc(2 * 1024 * 1024);
png.subarray(0, png.length - 12).copy(progressPng);
png.subarray(png.length - 12).copy(progressPng, progressPng.length - 12);
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
    PORT, DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
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
  const retryStatus = page.locator('.term-image-status.has-action').filter({
    has: page.getByRole('button', { name: 'retry' }),
  });
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
  const retry = retryStatus.getByRole('button', { name: 'retry' });
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
  await waitFor(async () => (await watcher.locator('.pane-head .ph-image').getAttribute('title'))?.includes('take control'));
  const watcherPickerDisabled = await watcher.locator('.pane-head .ph-image').isDisabled();
  const watcherPickerTitle = await watcher.locator('.pane-head .ph-image').getAttribute('title');
  check('a shared-terminal watcher cannot inject into the controller composer',
    watcherPickerDisabled && !!watcherPickerTitle?.includes('take control'),
    JSON.stringify({ watcherPickerDisabled, watcherPickerTitle }));
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
  // The pane header owns ONE paperclip in both views now (2026-08-18): in the
  // reader it opens the composer's own picker, which is the input used below, so
  // the files still land in the draft. The composer no longer draws its own.
  check('one paperclip, in the header, wired to the reader composer',
    await page.locator('.pane-head .ph-image').isVisible()
      && await page.locator('.pane-reader .image-pick').count() === 0
      && await page.locator('.pane-reader .image-file-input').count() === 1);

  // Keep the request outside the server until the operator cancels it. The
  // composer must become usable immediately; it cannot be held hostage by a
  // slow transfer that the operator no longer wants to send.
  let releaseCanceledUpload;
  let sawCanceledUpload;
  const canceledUploadReached = new Promise((resolve) => { sawCanceledUpload = resolve; });
  const canceledUploadHold = new Promise((resolve) => { releaseCanceledUpload = resolve; });
  await page.route(`**/api/sessions/${id}/attachments`, async (route) => {
    sawCanceledUpload();
    await canceledUploadHold;
    await route.continue().catch(() => {});
  }, { times: 1 });
  await readerPicker.setInputFiles({
    name: 'cancel-me.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512 * 1024),
  });
  await Promise.race([
    canceledUploadReached,
    sleep(10_000).then(() => { throw new Error('cancel fixture upload did not start'); }),
  ]);
  const canceledChip = page.locator('.pane-reader .image-chip', { hasText: 'cancel-me.bin' });
  const cancelUpload = canceledChip.getByRole('button', { name: 'Cancel upload cancel-me.bin' });
  await cancelUpload.waitFor({ state: 'visible' });
  const cancelWasEnabled = await cancelUpload.isEnabled();
  await cancelUpload.click();
  releaseCanceledUpload();
  await canceledChip.waitFor({ state: 'detached' });
  const readerReply = page.locator('.pane-reader .ov-live textarea');
  await readerReply.fill('send without the canceled upload');
  check('an in-flight upload can be canceled and no longer blocks Send',
    cancelWasEnabled && await page.locator('.pane-reader .ov-send').isVisible());
  await readerReply.fill('');

  // The failure that motivated immediate uploads: once the HTTP connection is
  // cut, fetch used to surface only "Failed to fetch" after Send. The XHR
  // transport must classify it at attachment time and keep a retry beside it.
  await page.route(`**/api/sessions/${id}/attachments`, (route) => route.abort('connectionreset'), { times: 1 });
  await readerPicker.setInputFiles({
    name: 'interrupted.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(256 * 1024),
  });
  const interruptedChip = page.locator('.pane-reader .image-chip', { hasText: 'interrupted.bin' });
  await interruptedChip.filter({ has: page.locator('.image-chip-retry') }).waitFor({ state: 'visible' });
  const interruptedText = await interruptedChip.locator('.image-chip-meta').textContent();
  check('an interrupted upload fails immediately with a reason and retry',
    !!interruptedText?.includes('connection was interrupted')
      && await interruptedChip.locator('.image-chip-retry').isVisible(),
    JSON.stringify({ interruptedText }));
  await interruptedChip.locator('.image-chip-retry').click();
  await interruptedChip.filter({ has: page.locator('.image-chip-meta', { hasText: 'uploaded' }) }).waitFor();
  const attachmentDir = path.join(DATA_DIR, 'state', 'attachments', id);
  const interruptedStored = await waitFor(() => fs.readdirSync(attachmentDir)
    .some((name) => name.endsWith('-interrupted.bin')));
  await interruptedChip.getByRole('button', { name: 'Remove interrupted.bin' }).click();
  const interruptedRemoved = await waitFor(() => !fs.existsSync(attachmentDir)
    || !fs.readdirSync(attachmentDir).some((name) => name.endsWith('-interrupted.bin')));
  check('removing a successful unsent chip deletes its stored file', interruptedStored && interruptedRemoved);

  // Hugging Face's ingress may answer before Express with an HTML error page.
  // Preserve the status as a useful diagnosis instead of reducing it to "413".
  await page.route(`**/api/sessions/${id}/attachments`, (route) => route.fulfill({
    status: 413, contentType: 'text/html', body: '<h1>Payload Too Large</h1>',
  }), { times: 1 });
  await readerPicker.setInputFiles({
    name: 'proxy-limit.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024),
  });
  const proxyChip = page.locator('.pane-reader .image-chip', { hasText: 'proxy-limit.bin' });
  await proxyChip.filter({ has: page.locator('.image-chip-retry') }).waitFor();
  const proxyText = await proxyChip.locator('.image-chip-meta').textContent();
  check('a non-JSON proxy rejection keeps an actionable HTTP reason',
    !!proxyText?.includes('proxy rejected this file as too large') && proxyText.includes('HTTP 413'),
    JSON.stringify({ proxyText }));
  await proxyChip.getByRole('button', { name: 'Remove proxy-limit.bin' }).click();

  // Client-side size rejection happens at attachment time and never offers a
  // futile retry. The server separately exercises its streaming 100 MiB cap.
  const tooLargePath = path.join(DATA_DIR, 'too-large.bin');
  fs.writeFileSync(tooLargePath, '');
  fs.truncateSync(tooLargePath, 101 * 1024 * 1024);
  await readerPicker.setInputFiles(tooLargePath);
  const tooLargeChip = page.locator('.pane-reader .image-chip', { hasText: 'too-large.bin' });
  await tooLargeChip.filter({ has: page.locator('.image-chip-meta', { hasText: 'too large' }) }).waitFor();
  check('a large file is rejected before upload with its 100 MB limit',
    (await tooLargeChip.locator('.image-chip-meta').textContent())?.includes('100 MB max')
      && await tooLargeChip.locator('.image-chip-retry').count() === 0);
  await tooLargeChip.getByRole('button', { name: 'Remove too-large.bin' }).click();

  // Hold the intercepted request lifecycle so the progress surface can be
  // inspected before the response changes the chip to server-confirmed success.
  let releaseReaderUpload;
  let sawReaderUpload;
  const readerUploadReached = new Promise((resolve) => { sawReaderUpload = resolve; });
  const readerUploadHold = new Promise((resolve) => { releaseReaderUpload = resolve; });
  await page.route(`**/api/sessions/${id}/attachments`, async (route) => {
    const response = await route.fetch();
    sawReaderUpload();
    await readerUploadHold;
    await route.fulfill({ response });
  }, { times: 1 });
  await readerPicker.setInputFiles({ name: 'reader.png', mimeType: 'image/png', buffer: progressPng });
  await Promise.race([
    readerUploadReached,
    sleep(10_000).then(() => { throw new Error('reader upload did not start on attachment'); }),
  ]);
  const readerChip = page.locator('.pane-reader .image-chip', { hasText: 'reader.png' });
  await readerChip.locator('.image-chip-progress').waitFor({ state: 'visible' });
  const readerProgress = await readerChip.locator('.image-chip-progress').getAttribute('aria-valuenow');
  const readerProgressText = await readerChip.locator('.image-chip-meta').textContent();
  check('reader upload starts before Send and reports byte progress',
    readerProgress != null && !!readerProgressText?.includes('%') && readerProgressText.includes('/'),
    JSON.stringify({ readerProgress, readerProgressText }));
  releaseReaderUpload();
  await readerChip.filter({ has: page.locator('.image-chip-meta', { hasText: 'uploaded' }) }).waitFor();
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
  const overviewChip = page.locator('.ovw-win .image-chip', { hasText: 'overview.png' });
  await overviewChip.filter({ has: page.locator('.image-chip-meta', { hasText: 'uploaded' }) }).waitFor();
  check('Overview uploads a file when attached, before Send', await overviewChip.isVisible());
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

  // Quick creation has to allocate its stopped session first, but attachment
  // selection still starts both uploads before the operator launches it. Hold
  // the second request to make that ordering and the progress lock observable.
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
  await Promise.race([
    secondReached,
    sleep(20_000).then(() => { throw new Error('second upload did not start on attachment'); }),
  ]);
  const quickChips = page.locator('.quick .image-chip');
  await quickChips.nth(0).filter({ has: page.locator('.image-chip-meta', { hasText: 'uploaded' }) }).waitFor();
  check('quick creation uploads before launch and shows progress while pending',
    uploadCount === 2
      && await quickChips.nth(1).locator('.image-chip-progress').isVisible()
      && await quickChips.nth(1).getByRole('button', { name: 'Cancel upload requirements.docx' }).isEnabled());
  releaseSecond();
  await quickChips.nth(1).filter({ has: page.locator('.image-chip-meta', { hasText: 'uploaded' }) }).waitFor();
  const uploadsBeforeLaunch = uploadCount;
  await page.locator('.quick-prompt').press('Enter');
  await page.locator('.controls').waitFor({ state: 'hidden', timeout: 30_000 });
  check('launch reuses already-uploaded attachment ids', uploadCount === uploadsBeforeLaunch);

  // Reproduce the blocking review case from a truly fresh browser: before the
  // fix, the attachment-created target became tree.order[0], its pane mounted,
  // and Escape left that running target (and its file) behind after reload.
  await page.close();
  const existing = await (await fetch(`${API}/api/sessions`)).json();
  for (const session of existing) {
    await fetch(`${API}/api/sessions/${session.id}`, { method: 'DELETE' });
  }
  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fresh = await freshContext.newPage();
  await fresh.goto(API, { waitUntil: 'domcontentloaded' });
  await fresh.locator('.bolt-btn').click();
  await fresh.locator('.quick-cli[title="Repaint fixture"]').click();
  await fresh.locator('.quick-prompt').evaluate((element, bytes) => {
    const raw = atob(bytes);
    const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], 'abandon.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: transfer,
    }));
  }, png.toString('base64'));
  const abandonChip = fresh.locator('.quick .image-chip', { hasText: 'abandon.png' });
  await abandonChip.filter({ has: fresh.locator('.image-chip-meta', { hasText: 'uploaded' }) }).waitFor();
  const stagedSessions = await (await fetch(`${API}/api/sessions`)).json();
  check('fresh-visit attachment creates only a stopped target and keeps Overview selected',
    stagedSessions.length === 1
      && stagedSessions[0].everStarted === false
      && stagedSessions[0].running === false
      && await fresh.locator('.sidebar .ov-row').getAttribute('class').then((value) => value?.includes('active'))
      && await fresh.locator('.tile-terminal').count() === 0,
    JSON.stringify(stagedSessions.map((session) => ({ id: session.id, running: session.running, everStarted: session.everStarted }))));
  await fresh.locator('.quick-prompt').press('Escape');
  const abandonedRemoved = await waitFor(async () => (await (await fetch(`${API}/api/sessions`)).json()).length === 0);
  await fresh.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = await (await fetch(`${API}/api/sessions`)).json();
  check('Escape discards the unlaunched target and its upload across reload',
    abandonedRemoved && afterReload.length === 0);

  const retained = await apiJson('/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'test-repaint', name: 'retain-started', path: '.' }),
  });
  await apiJson(`/api/sessions/${retained.body.id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'start it' }),
  });
  const conditionalDelete = await apiJson(`/api/sessions/${retained.body.id}?ifNeverStarted=1`, { method: 'DELETE' });
  const afterConditionalDelete = await (await fetch(`${API}/api/sessions`)).json();
  check('conditional cleanup cannot delete a target that has started',
    conditionalDelete.response.status === 409
      && afterConditionalDelete.some((session) => session.id === retained.body.id));
  await fetch(`${API}/api/sessions/${retained.body.id}`, { method: 'DELETE' });
  await freshContext.close();
} finally {
  try { await browser?.close(); } catch {}
  backend.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
