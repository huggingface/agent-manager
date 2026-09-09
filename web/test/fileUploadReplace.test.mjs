// Files pane replacement consent: exact destination, Cancel by default, and a
// separate token-bound request only after the operator chooses Replace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-file-replace-ui-'));
const bundle = path.join(tmp, 'fixture.js');
const stub = path.join(tmp, 'api.ts');
fs.writeFileSync(stub, `
  export class TraceUnavailable extends Error {}
  export class WorkspaceUploadError extends Error {
    constructor(message,status,body){super(message);this.status=status;
      if(body?.code==='file-exists'||body?.code==='replacement-stale')this.collision=body;}
  }
  window.fileCalls=[]; window.revisions={existing:'token-existing',stale:'token-stale-1'};
  export const listFiles=()=>Promise.resolve({path:'',root:'workspace',entries:[
    {name:'target',dir:true,size:0,mtime:1},{name:'existing.txt',dir:false,size:8,mtime:1,kind:'text'}]});
  export const uploadFile=(_id,folder,file,{replaceToken,onProgress,signal}={})=>new Promise((resolve,reject)=>{
    const call={folder,name:file.name,replaceToken:replaceToken||null,aborted:false}; window.fileCalls.push(call);
    signal?.addEventListener('abort',()=>{call.aborted=true;reject(new WorkspaceUploadError('Upload was canceled before it completed.',0));},{once:true});
    onProgress?.({loaded:Math.floor(file.size/2),total:file.size});
    setTimeout(()=>{
      if(call.aborted)return;
      if(file.name==='fail.txt')return reject(new WorkspaceUploadError('disk unavailable',500));
      if(file.name==='existing.txt'&&!replaceToken)return reject(new WorkspaceUploadError('"existing.txt" already exists',409,
        {code:'file-exists',name:'existing.txt',path:'target/existing.txt',revision:'sha256:8:a',replaceToken:'token-existing'}));
      if(file.name==='stale.txt'&&!replaceToken)return reject(new WorkspaceUploadError('"stale.txt" already exists',409,
        {code:'file-exists',name:'stale.txt',path:'target/stale.txt',revision:'sha256:5:a',replaceToken:window.revisions.stale}));
      if(file.name==='stale.txt'&&replaceToken==='token-stale-1')return reject(new WorkspaceUploadError('"stale.txt" changed after replacement was confirmed',409,
        {code:'replacement-stale',name:'stale.txt',path:'target/stale.txt',revision:'sha256:7:b',replaceToken:'token-stale-2'}));
      onProgress?.({loaded:file.size,total:file.size}); resolve({ok:true,path:folder+'/'+file.name,size:file.size,mtime:2});
    },file.name==='slow.txt'?500:15);
  });
  export const previewFile=()=>Promise.reject(new Error('not used'));
  export const rawUrl=()=>''; export const downloadUrl=()=>'';
  export const createFolder=()=>Promise.resolve({}); export const createFile=()=>Promise.resolve({});
  export const renameEntry=()=>Promise.resolve({path:''}); export const moveEntry=()=>Promise.resolve({path:''});
  export const deleteEntry=()=>Promise.resolve({}); export const writeFile=()=>Promise.resolve({size:0,mtime:0,tag:''});
  export const getFileTraceWindow=()=>new Promise(()=>{}); export const getFileTraceSummary=()=>new Promise(()=>{});
`);
await build({
  stdin: { resolveDir: WEB, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import FilesPane from './src/components/FilesPane';
    const session={id:'files-1',cli:'files',name:'Files',state:'stopped',running:false,everStarted:false,path:null,createdAt:new Date().toISOString()};
    createRoot(document.getElementById('root')).render(<FilesPane session={session} focused zoom={100} onClose={()=>{}}/>);
  ` }, outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(builder) {
    builder.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
const input = page.locator('.upload-btn input[type=file]');
const row = (name) => page.locator('.files-upload-row', { has: page.locator('.files-upload-name', { hasText: name }) }).last();
try {
  await page.setContent(`<style>${fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8')}
    html,body,#root{width:100%;height:100%;margin:0}.slot{height:100%}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await input.waitFor({ state: 'attached' });
  await page.getByText('target', { exact: true }).click();

  await input.setInputFiles([
    { name: 'existing.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') },
    { name: 'good.txt', mimeType: 'text/plain', buffer: Buffer.from('good') },
    { name: 'fail.txt', mimeType: 'text/plain', buffer: Buffer.from('failure') },
  ]);
  await row('existing.txt').waitFor();
  await row('good.txt').locator('.files-upload-state', { hasText: 'uploaded' }).waitFor();
  await row('fail.txt').locator('.files-upload-state', { hasText: 'disk unavailable' }).waitFor();
  assert.equal(await page.locator('.files-upload-row').count(), 3, 'mixed outcomes all remain visible');
  assert.match(await page.locator('.files-uploads-head').textContent(), /1 uploaded/);
  assert.match(await page.locator('.files-uploads-head').textContent(), /2 need attention/);
  assert.equal((await page.evaluate(() => window.fileCalls)).filter((call) => call.replaceToken).length, 0,
    'a collision alone never authorizes replacement');

  await row('existing.txt').getByRole('button', { name: 'Replace…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace existing.txt?' });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /existing\.txt/);
  assert.match(await dialog.textContent(), /workspace\/target\/existing\.txt/);
  assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).evaluate((button) => button === document.activeElement), true,
    'Cancel is the focused default');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await page.evaluate(() => window.fileCalls)).filter((call) => call.replaceToken).length, 0,
    'Escape does not replace');
  assert.match(await row('existing.txt').locator('.files-upload-state').textContent(), /canceled/);

  await input.setInputFiles({ name: 'existing.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') });
  await row('existing.txt').getByRole('button', { name: 'Replace…' }).click();
  await page.getByRole('dialog', { name: 'Replace existing.txt?' }).getByRole('button', { name: 'Replace', exact: true }).click();
  await row('existing.txt').locator('.files-upload-state', { hasText: 'uploaded' }).waitFor();
  const deliberate = (await page.evaluate(() => window.fileCalls)).filter((call) => call.name === 'existing.txt').at(-1);
  assert.equal(deliberate.replaceToken, 'token-existing');
  assert.equal(deliberate.folder, 'target');

  await input.setInputFiles({ name: 'stale.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') });
  await row('stale.txt').getByRole('button', { name: 'Replace…' }).click();
  await page.getByRole('dialog', { name: 'Replace stale.txt?' }).getByRole('button', { name: 'Replace', exact: true }).click();
  await row('stale.txt').locator('.files-upload-state', { hasText: 'changed after replacement' }).waitFor();
  assert.equal((await page.evaluate(() => window.fileCalls)).filter((call) => call.name === 'stale.txt').length, 2);
  await row('stale.txt').getByRole('button', { name: 'Replace…' }).click();
  await page.getByRole('dialog', { name: 'Replace stale.txt?' }).getByRole('button', { name: 'Replace', exact: true }).click();
  await row('stale.txt').locator('.files-upload-state', { hasText: 'uploaded' }).waitFor();
  assert.equal((await page.evaluate(() => window.fileCalls)).filter((call) => call.name === 'stale.txt').at(-1).replaceToken,
    'token-stale-2', 'a stale choice requires the fresh server token');

  await input.setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2000) });
  await row('slow.txt').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(30);
  const slow = (await page.evaluate(() => window.fileCalls)).find((call) => call.name === 'slow.txt');
  assert.equal(slow.aborted, true);
  assert.match(await row('slow.txt').locator('.files-upload-state').textContent(), /canceled/);

  const geometry = await page.locator('.files-uploads').evaluate((box) => ({
    overflow: box.scrollWidth > box.clientWidth,
    height: box.querySelector('.files-upload-list').getBoundingClientRect().height,
  }));
  assert.ok(!geometry.overflow && geometry.height <= 149, JSON.stringify(geometry));
  console.log('workspace replacement UI tests passed');
} finally {
  await browser.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
