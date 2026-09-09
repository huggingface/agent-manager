// Dozens of files through the real shared attachment component and scheduler.
// Network/storage are synthetic; server resolution is covered in attachments.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-attachment-batches-'));
const bundle = path.join(tmp, 'fixture.js');

await build({
  stdin: { resolveDir: WEB, loader: 'tsx', contents: `
    import React, { useEffect, useRef, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import Attachments from './src/components/Attachments';
    import {
      discardPendingAttachment, discardPendingAttachments, filesFromTransfer,
      pendingAttachmentsFromFiles, uploadPendingAttachments,
    } from './src/lib/attachments';
    window.transferFiles = filesFromTransfer;
    window.batchApps = {};
    function Batch({ sessionId }) {
      const [items, setItems] = useState([]); const ref = useRef([]);
      const update = (key, patch) => {
        const next = ref.current.map((item) => item.key === key ? {...item, ...patch} : item);
        ref.current = next; setItems(next);
      };
      const add = (files) => {
        const next = pendingAttachmentsFromFiles(files, ref.current.length).attachments;
        ref.current = [...ref.current, ...next]; setItems(ref.current);
        uploadPendingAttachments(sessionId, next, update).catch(() => {});
      };
      const remove = (key) => {
        const item = ref.current.find((candidate) => candidate.key === key);
        if (item) discardPendingAttachment(sessionId, item);
        ref.current = ref.current.filter((candidate) => candidate.key !== key); setItems(ref.current);
      };
      const retry = (key) => {
        const item = ref.current.find((candidate) => candidate.key === key);
        if (item) uploadPendingAttachments(sessionId, [item], update).catch(() => {});
      };
      useEffect(() => { window.batchApps[sessionId] = { clear() {
        discardPendingAttachments(sessionId, ref.current); ref.current = []; setItems([]);
      }, snapshot: () => ref.current.map((item) => ({name:item.file.name,path:item.attachment?.path,status:item.status}))
      }; return () => delete window.batchApps[sessionId]; }, [sessionId]);
      return <div className="fixture-batch" data-session={sessionId}><Attachments attachments={items}
        onFiles={add} onRemove={remove} onRetry={retry} /></div>;
    }
    createRoot(document.getElementById('root')).render(<><Batch sessionId="one"/><Batch sessionId="two"/></>);
  ` },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'fake-api', setup(builder) {
    builder.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'ts', contents: `
      export const metrics = window.uploadMetrics = {active:{}, max:{}, total:0, maxTotal:0, starts:[], deletes:[], attempts:{}};
      export const uploadAttachment = (sessionId, file, {signal, onProgress} = {}) => new Promise((resolve, reject) => {
        const key = sessionId + '/' + file.name;
        metrics.attempts[key] = (metrics.attempts[key] || 0) + 1;
        metrics.starts.push({sessionId, name:file.name, attempt:metrics.attempts[key]});
        metrics.active[sessionId] = (metrics.active[sessionId] || 0) + 1;
        metrics.max[sessionId] = Math.max(metrics.max[sessionId] || 0, metrics.active[sessionId]);
        metrics.total += 1; metrics.maxTotal = Math.max(metrics.maxTotal, metrics.total);
        onProgress?.({loaded:Math.floor(file.size/2),total:file.size});
        let done = false;
        const finish = (task) => { if(done)return; done=true; clearTimeout(timer);
          metrics.active[sessionId] -= 1; metrics.total -= 1; signal?.removeEventListener('abort', abort); task(); };
        const abort = () => {
          if(file.name === 'late-success.txt') return;
          finish(() => reject(new Error('Upload was canceled before it completed.')));
        };
        const number = Number((file.name.match(/(\d+)/) || [0,0])[1]);
        const timer = setTimeout(() => finish(() => {
          if(file.name === 'fail-once.txt' && metrics.attempts[key] === 1) return reject(new Error('connection interrupted'));
          onProgress?.({loaded:file.size,total:file.size});
          resolve({id:'att_'+String(metrics.starts.length).padStart(24,'0'),kind:'file',name:file.name,mime:file.type,
            bytes:file.size,path:'/stored/'+sessionId+'/'+metrics.starts.length+'-'+file.name,previewUrl:'',insertText:''});
        }), file.name.startsWith('cancel-') ? 180 : 8 + (number % 5) * 4);
        signal?.addEventListener('abort', abort, {once:true});
      });
      export const deleteAttachment = (sessionId, id) => { metrics.deletes.push({sessionId,id}); return Promise.resolve({ok:true}); };
    ` }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const files = (count, prefix = 'file') => Array.from({ length: count }, (_, index) => ({
  name: `${prefix}-${index}.txt`, mimeType: index % 3 ? 'text/plain' : 'text/markdown', buffer: Buffer.from(`body-${index}`),
}));
const input = (session) => page.locator(`[data-session="${session}"] input[type=file]`);
const batch = (session) => page.locator(`[data-session="${session}"]`);
const waitUploaded = (session, count) => page.waitForFunction(({ session, count }) =>
  document.querySelectorAll(`[data-session="${session}"] .image-chip.uploaded`).length === count, { session, count });

try {
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await input('one').waitFor({ state: 'attached' });

  const transfer = await page.evaluate(() => {
    const canonical = new File(['a'], 'same.txt', { type: 'text/plain', lastModified: 1 });
    const duplicateView = new File(['a'], 'same.txt', { type: 'text/plain', lastModified: 2 });
    const fromBoth = window.transferFiles({ files: [canonical], items: [{ kind: 'file', getAsFile: () => duplicateView }] });
    const first = new File(['x'], 'twins.txt', { type: 'text/plain' });
    const second = new File(['y'], 'twins.txt', { type: 'text/plain' });
    const itemsOnly = window.transferFiles({ files: [], items: [
      { kind: 'file', getAsFile: () => first }, { kind: 'file', getAsFile: () => second },
    ] });
    return { fromBoth: fromBoth.length, canonical: fromBoth[0] === canonical,
      itemsOnly: itemsOnly.length, distinct: itemsOnly[0] !== itemsOnly[1] };
  });
  assert.deepEqual(transfer, { fromBoth: 1, canonical: true, itemsOnly: 2, distinct: true });

  for (const count of [6, 30]) {
    await input('one').setInputFiles(files(count, `batch${count}`));
    await waitUploaded('one', count);
    assert.match(await batch('one').locator('.image-attachments-summary').textContent(), new RegExp(`^${count} files`));
    await page.evaluate(() => window.batchApps.one.clear());
  }

  // Overlapping additions share one FIFO and still preserve visible selection order.
  const longFirst = 'first-with-an-intentionally-long-reader-attachment-name-that-must-ellipsize';
  const longSecond = 'second-with-an-intentionally-long-reader-attachment-name-that-must-ellipsize';
  await input('one').setInputFiles(files(30, longFirst));
  await input('one').setInputFiles(files(20, longSecond));
  await waitUploaded('one', 50);
  const fifty = await batch('one').evaluate((root) => {
    const list = root.querySelector('.image-attachment-list');
    return {
      summary: root.querySelector('.image-attachments-summary')?.textContent,
      names: [...root.querySelectorAll('.image-chip-name')].map((node) => node.textContent),
      listHeight: list.getBoundingClientRect().height,
      scrollable: list.scrollHeight > list.clientHeight,
      overflow: root.scrollWidth > root.clientWidth,
    };
  });
  assert.match(fifty.summary, /^50 files/);
  assert.deepEqual(fifty.names, [...files(30, longFirst), ...files(20, longSecond)].map((file) => file.name));
  assert.ok(fifty.listHeight <= 153 && fifty.scrollable && !fifty.overflow, JSON.stringify(fifty));
  let metrics = await page.evaluate(() => window.uploadMetrics);
  assert.ok(metrics.max.one <= 3, `same-session active uploads: ${metrics.max.one}`);
  await page.evaluate(() => window.batchApps.one.clear());

  await input('one').setInputFiles(files(75, 'over-fifty'));
  await waitUploaded('one', 75);
  assert.match(await batch('one').locator('.image-attachments-summary').textContent(), /^75 files/);
  await page.evaluate(() => window.batchApps.one.clear());

  // Independent sessions each start work; neither waits for the other's queue.
  await input('one').setInputFiles(files(8, 'one'));
  await input('two').setInputFiles(files(8, 'two'));
  await Promise.all([waitUploaded('one', 8), waitUploaded('two', 8)]);
  metrics = await page.evaluate(() => window.uploadMetrics);
  assert.ok(metrics.max.one <= 3 && metrics.max.two <= 3 && metrics.maxTotal >= 2, JSON.stringify(metrics));
  const associations = await page.evaluate(() => ({
    one: window.batchApps.one.snapshot(), two: window.batchApps.two.snapshot(),
  }));
  assert.ok(associations.one.every((item) => item.path.includes('/one/'))
    && associations.two.every((item) => item.path.includes('/two/')), JSON.stringify(associations));
  await page.evaluate(() => { window.batchApps.one.clear(); window.batchApps.two.clear(); });

  const cancelFiles = [...files(7, 'cancel'), { name: 'fail-once.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') }];
  await input('one').setInputFiles(cancelFiles);
  await page.waitForFunction(() => document.querySelectorAll('[data-session="one"] .image-chip.uploading').length === 3);
  const queuedCancel = batch('one').getByRole('button', { name: 'Cancel upload cancel-6.txt' });
  await queuedCancel.focus(); await page.keyboard.press('Enter');
  await batch('one').getByRole('button', { name: 'Cancel upload cancel-0.txt' }).click();
  const failed = batch('one').locator('.image-chip.error', { hasText: 'fail-once.txt' });
  await failed.waitFor().catch(async (error) => {
    console.error('batch state at failure timeout', await page.evaluate(() => ({
      metrics: window.uploadMetrics, items: window.batchApps.one.snapshot(),
    })));
    throw error;
  });
  await batch('one').getByRole('button', { name: 'hide' }).click();
  assert.equal(await batch('one').locator('.image-chip').count(), 1, 'collapsed details keep the blocking failure visible');
  const retry = failed.getByRole('button', { name: 'Retry fail-once.txt' });
  await retry.focus(); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-session="one"] .image-attachments-summary')
    ?.textContent?.includes('6 uploaded'));
  await page.waitForTimeout(80);
  await batch('one').getByRole('button', { name: 'details' }).click();
  const canceled = await batch('one').locator('.image-chip-name').allTextContents();
  assert.ok(!canceled.includes('cancel-0.txt') && !canceled.includes('cancel-6.txt'));
  metrics = await page.evaluate(() => window.uploadMetrics);
  assert.equal(metrics.attempts['one/fail-once.txt'], 2);
  for (const name of canceled.filter((name) => name !== 'fail-once.txt')) {
    assert.equal(metrics.attempts[`one/${name}`], 1, `${name} was re-uploaded`);
  }

  await page.evaluate(() => window.batchApps.one.clear());
  const deletesBeforeLate = await page.evaluate(() => window.uploadMetrics.deletes.length);
  await input('one').setInputFiles({ name: 'late-success.txt', mimeType: 'text/plain', buffer: Buffer.from('late') });
  const late = batch('one').locator('.image-chip', { hasText: 'late-success.txt' });
  await late.getByRole('button', { name: 'Cancel upload late-success.txt' }).click();
  await late.waitFor({ state: 'detached' });
  await page.waitForFunction((before) => window.uploadMetrics.deletes.length > before, deletesBeforeLate);
  metrics = await page.evaluate(() => window.uploadMetrics);
  assert.equal(metrics.deletes.length, deletesBeforeLate + 1,
    'a server success racing cancellation is explicitly removed');

  console.log('attachment batch browser tests passed');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
