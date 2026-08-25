import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovsearch-')), 'overviewSearch.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/overviewSearch.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { matchesOverviewSearch, overviewSearchText } = await import(pathToFileURL(out).href);

const session = {
  id: 'one', name: 'Research Agent', cli: 'codex', state: 'waiting', createdAt: '',
  digest: {
    lastPromptText: 'Investigate auth', lastPromptRaw: 'Investigate the OAuth callback', lastPromptTs: 1,
    lastAssistantText: 'Fixed it', lastAssistantMd: 'Fixed the **redirect**.', lastAssistantTs: 2,
    sinceTurns: 2, sinceToolCalls: 2, sinceTools: { Read: 1, apply_patch: 1 },
    sinceFiles: ['/src/login.ts'], sinceTokens: 10,
    turnsLog: [{ answer: 'Found a stale cookie', answerMd: 'Found a `stale cookie`.', ts: 1 }],
  },
};

assert.equal(matchesOverviewSearch(session, 'Web App', ''), true);
assert.equal(matchesOverviewSearch(session, 'Web App', 'research'), true, 'agent name');
assert.equal(matchesOverviewSearch(session, 'Web App', 'web app'), true, 'group name and AND terms');
assert.equal(matchesOverviewSearch(session, 'Web App', 'OAUTH redirect'), true, 'prompt + answer, case-insensitive');
assert.equal(matchesOverviewSearch(session, 'Web App', 'apply_patch login.ts'), true, 'tool + file');
assert.equal(matchesOverviewSearch(session, 'Web App', 'stale cookie'), true, 'recent intermediate answer');
assert.equal(matchesOverviewSearch(session, 'Web App', 'oauth missing'), false, 'every term is required');
assert.match(overviewSearchText(session, 'Web App'), /oauth callback/);

console.log('overview search: all passed');
