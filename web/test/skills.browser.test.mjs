// Focused browser coverage runs through normal suite discovery. Real component,
// API helpers, routes and disposable server; only a held response is intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { skillsServer } from '../../server/test/fixtures/skills-server.mjs';
import { generatedSkill } from '../../server/src/skills.js';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
const web = fileURLToPath(new URL('..', import.meta.url));
const f = await skillsServer();
let browser, releaseDelete;
const shots = process.env.AM_SKILLS_SCREENSHOTS;
async function screenshot(page, name) {
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); }
}
try {
  fs.mkdirSync(f.env.PUBLIC_DIR);
  fs.copyFileSync(path.join(web, 'src/styles.css'), path.join(f.env.PUBLIC_DIR, 'styles.css'));
  fs.writeFileSync(path.join(f.env.PUBLIC_DIR, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="height:100vh;padding:24px"></div><script src="/skills.js"></script></body></html>');
  await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import SkillsEditor from './src/components/SkillsEditor'; createRoot(document.getElementById('root')).render(<SkillsEditor/>);`, resolveDir: web, loader: 'tsx' },
    bundle: true, outfile: path.join(f.env.PUBLIC_DIR, 'skills.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  await f.start();
  await f.api('demo.md', 'POST', '# Original\n\nKeep this source.');
  await f.api('other.md', 'POST', '# Other');
  browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  let deletes = 0;
  page.on('request', (req) => { if (req.method() === 'DELETE') deletes++; });
  await page.goto(f.url);
  await page.getByRole('button', { name: 'demo.md', exact: true }).click();
  await page.getByText('Keep this source.').waitFor();
  // Same-name upload preserves the existing skill and offers another filename.
  await page.locator('input[type=file]').setInputFiles({ name: 'demo.md', mimeType: 'text/plain', buffer: Buffer.from('# Uploaded replacement') });
  await page.getByRole('alert').filter({ hasText: 'already exists' }).waitFor();
  assert.equal(fs.readFileSync(f.source('demo.md'), 'utf8'), '# Original\n\nKeep this source.');
  assert.equal(await page.getByLabel('Upload as').inputValue(), 'demo.md');
  await screenshot(page, 'skills-upload-conflict');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  console.log('PASS upload collision preserves original and offers a different name');

  // A second browser tab saves first. The failed save must retain text + target.
  const second = await context.newPage(); await second.goto(f.url);
  await second.getByRole('button', { name: 'demo.md', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Skill content' }).fill('# My unsaved buffer');
  await second.getByRole('button', { name: 'Edit', exact: true }).click();
  await second.getByRole('textbox', { name: 'Skill content' }).fill('# Saved by other tab');
  await second.getByRole('button', { name: 'Save', exact: true }).click();
  await second.getByRole('heading', { name: 'Saved by other tab' }).waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Skill content' }).inputValue(), '# My unsaved buffer');
  assert.equal(await page.locator('.skill-title').innerText(), 'demo.md');
  assert.equal(fs.readFileSync(f.source('demo.md'), 'utf8'), '# Saved by other tab');
  await screenshot(page, 'skills-stale-save');
  await page.getByRole('button', { name: 'Refresh revision (keep entered text)' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'My unsaved buffer' }).waitFor();
  console.log('PASS two-tab conflict preserves buffer; explicit save after refresh succeeds');

  // A real source rename failure also keeps the buffer and exposes a safe retry.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Skill content' }).fill('# Storage retry buffer');
  f.fault({ method: 'renameSync', path: f.source('demo.md') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Skill content' }).inputValue(), '# Storage retry buffer');
  assert.equal(fs.readFileSync(f.source('demo.md'), 'utf8'), '# My unsaved buffer');
  assert.match(await page.getByRole('alert').innerText(), /Source: failed/);
  f.fault({});
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await page.getByRole('heading', { name: 'Storage retry buffer' }).waitFor();
  console.log('PASS storage failure preserves old source and entered buffer; retry save completes');

  // Opening/cancelling/Escape are read-only. Cancel owns default focus.
  const dialog = page.getByRole('dialog');
  await page.getByTitle('Delete skill', { exact: true }).click();
  await dialog.waitFor();
  assert.equal(deletes, 0);
  assert.match(await dialog.innerText(), /Permanently delete demo.md/);
  assert.match(await dialog.innerText(), /cannot be undone/);
  assert.equal(await dialog.locator('li').count(), 5);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
  await screenshot(page, 'skills-delete-confirmation');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(deletes, 0);
  await page.getByTitle('Delete skill', { exact: true }).click();
  await dialog.waitFor(); await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' }); assert.equal(deletes, 0);
  // A new selection needs its own confirmation; the old dialog cannot retarget.
  await page.getByRole('button', { name: 'other.md', exact: true }).click();
  await page.getByTitle('Delete skill', { exact: true }).click();
  await dialog.waitFor(); assert.match(await dialog.innerText(), /Permanently delete other.md/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(deletes, 0);
  await page.getByRole('button', { name: 'demo.md', exact: true }).click();
  console.log('PASS opening, Cancel and Escape never delete; selection cannot retarget a dialog');

  // Revision changes after opening require a fresh confirmation.
  await page.getByTitle('Delete skill', { exact: true }).click(); await dialog.waitFor();
  const current = (await f.api('demo.md')).body;
  await f.api('demo.md', 'PUT', '# Changed after confirmation', current.revision);
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Refresh confirmation' }).waitFor();
  assert.equal(deletes, 1); assert.ok(fs.existsSync(f.source('demo.md')));
  await dialog.getByRole('button', { name: 'Refresh confirmation' }).click();
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).waitFor();

  // Hold the actual response so duplicate DOM clicks exercise the immediate ref
  // guard, even before React commits disabled=true. The server fails one unlink.
  f.fault({ method: 'unlinkSync', path: f.target(2, 'demo') });
  const gate = new Promise((r) => { releaseDelete = r; });
  await page.route('**/api/skills/demo.md', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).evaluate((button) => { button.click(); button.click(); });
  await dialog.getByRole('button', { name: 'Deleting…', exact: true }).waitFor();
  assert.equal(deletes, 2);
  assert.equal(await dialog.getByRole('button', { name: 'Deleting…', exact: true }).isDisabled(), true);
  releaseDelete();
  await dialog.getByRole('button', { name: 'Retry permanent deletion' }).waitFor();
  assert.match(await dialog.innerText(), /Deletion is incomplete/);
  assert.equal((await dialog.locator('li').allTextContents()).filter((s) => s.includes('already absent')).length, 4);
  assert.ok(fs.existsSync(f.source('demo.md')));
  assert.equal(fs.existsSync(f.target(0, 'demo')), false);
  await screenshot(page, 'skills-partial-deletion');
  f.fault({}); await page.unroute('**/api/skills/demo.md');
  await dialog.getByRole('button', { name: 'Retry permanent deletion' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(deletes, 3); assert.equal(fs.existsSync(f.source('demo.md')), false);
  assert.equal(fs.readFileSync(f.source('other.md'), 'utf8'), '# Other');
  console.log('PASS stale confirmation refresh, duplicate submission guard, persistent partial state and scoped retry');

  // Files and agents can edit sources too. Reviewing the current source in the
  // real editor must permit an explicit save and a newly confirmed deletion.
  fs.writeFileSync(f.source('other.md'), '# Written outside Skills');
  await page.getByRole('button', { name: 'other.md', exact: true }).click();
  await page.getByRole('heading', { name: 'Written outside Skills' }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Skill content' }).fill('# Reviewed external edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Reviewed external edit' }).waitFor();
  for (let i = 0; i < 5; i++) assert.equal(fs.readFileSync(f.target(i, 'other'), 'utf8'), generatedSkill('other.md', '# Reviewed external edit'));
  fs.writeFileSync(f.source('other.md'), '# Changed before confirmation');
  await page.getByTitle('Delete skill', { exact: true }).click(); await dialog.waitFor();
  assert.equal(deletes, 3); assert.ok(fs.existsSync(f.source('other.md')));
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(deletes, 4); assert.equal(fs.existsSync(f.source('other.md')), false);
  for (let i = 0; i < 5; i++) assert.equal(fs.existsSync(f.target(i, 'other')), false);
  console.log('PASS reviewed external source edits can be saved and explicitly confirmed for deletion');

  // The generated environment skill is read-only: the editor says why, offers
  // no Save or Delete, and Edit is disabled.
  await page.getByRole('button', { name: 'environment.md', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'read-only' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(await page.getByTitle('Delete skill', { exact: true }).count(), 0);
  assert.equal((await f.api('environment.md', 'PUT', '# edit', (await f.api('environment.md')).body.revision)).status, 403);
  await screenshot(page, 'skills-generated-read-only');
  console.log('PASS the generated environment skill is read-only in the editor and the API');
} finally {
  releaseDelete?.();
  await browser?.close(); await f.cleanup();
}
