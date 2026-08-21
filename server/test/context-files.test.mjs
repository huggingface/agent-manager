// Root AGENTS.md/CLAUDE.md give every CLI its Agent Manager context at session
// start: Claude Code walks up to CLAUDE.md, Codex/opencode to AGENTS.md. The
// files are app-owned, deployment-generic, and rewritten only when stale.
// Run with: node test/context-files.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeWorkspaceContextFiles } from '../src/context-files.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'context-files-'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

console.log('\nfirst boot writes both files');
const first = writeWorkspaceContextFiles(TMP, 7860);
check('both files reported written', first.sort().join(','), 'AGENTS.md,CLAUDE.md');
const agents = fs.readFileSync(path.join(TMP, 'AGENTS.md'), 'utf8');
const claude = fs.readFileSync(path.join(TMP, 'CLAUDE.md'), 'utf8');
check('the two files are identical', agents, claude);

console.log('\nthe content is guarded and self-describing');
check('guarded on $AM_ID so non-manager sessions ignore it', agents.includes('`$AM_ID` is set'), true);
check('declares itself app-owned', agents.includes('do not edit'), true);
check('carries the configured port as the fallback', agents.includes('${AM_PORT:-7860}'), true);
check('prefers $AM_PORT over the baked-in port', agents.includes('${AM_PORT:-'), true);
check('points at the roster API', agents.includes('/api/agents?from=$AM_ID'), true);
check('names the working state as off-limits', agents.includes('`working` = leave it alone'), true);

console.log('\na second boot with unchanged content writes nothing');
check('no rewrite when current', writeWorkspaceContextFiles(TMP, 7860).length, 0);

console.log('\na changed port refreshes the files');
const changed = writeWorkspaceContextFiles(TMP, 9000);
check('both rewritten', changed.length, 2);
check('new port landed', fs.readFileSync(path.join(TMP, 'AGENTS.md'), 'utf8').includes('${AM_PORT:-9000}'), true);

console.log('\nan operator edit is reverted on the next boot (app-owned)');
fs.writeFileSync(path.join(TMP, 'CLAUDE.md'), '# my edits\n');
check('rewritten after tamper', writeWorkspaceContextFiles(TMP, 9000).join(','), 'CLAUDE.md');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
