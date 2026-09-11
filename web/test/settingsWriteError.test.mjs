import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-error-'));
const output = path.join(root, 'api.mjs');
await build({ entryPoints: ['src/api.ts'], outfile: output, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const api = await import(pathToFileURL(output));
const original = globalThis.fetch;

try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'The request could not be completed. Please try again.',
    code: 'internal-error',
    details: [{ field: 'path', message: 'am-config.json' }],
  }), { status: 500, headers: { 'content-type': 'application/json' } });
  await assert.rejects(api.saveConfig({}, null), (error) => error instanceof Error
    && error.message === 'am-config.json could not be saved.');

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'The request could not be completed. Please try again.',
    code: 'internal-error',
  }), { status: 500, headers: { 'content-type': 'application/json' } });
  await assert.rejects(api.saveSecrets({}, null), (error) => error instanceof Error
    && error.message === 'The request could not be completed. Please try again.');

  console.log('settings write errors: structured relative path is shown; generic fallback remains');
} finally {
  globalThis.fetch = original;
  fs.rmSync(root, { recursive: true, force: true });
}
