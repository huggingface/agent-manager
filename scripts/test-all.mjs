// The whole default test run in one pool: every server and web suite plus the
// web typecheck, `--jobs` at a time, with one shared web build. Same options as
// run-suites.mjs (filters, --manual, --jobs N, --verbose); see docs/testing.md.
//
// Usage (from the repository root):  npm test   or   node scripts/test-all.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuites, parseArgs } from './run-suites.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = parseArgs(process.argv.slice(2));
// The typecheck is not a suite, so a filter (running one suite by hand) leaves it out.
const extraTasks = opts.filters.length ? [] : [{
  name: 'web typecheck (tsc --noEmit)', cwd: path.join(REPO, 'web'),
  cmd: [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit'],
}];
process.exitCode = await runSuites({ pkgDirs: [path.join(REPO, 'server'), path.join(REPO, 'web')], extraTasks, ...opts });
