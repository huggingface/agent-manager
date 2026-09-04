// Manager context belongs in each harness's global/user scope. Project-root
// files are operator-owned and must not become dirty merely because a session
// launched there. OpenClaw's workspace-only contract is bounded to its private
// manager home; external/custom workspaces fail closed.
// Run with: node test/context-files.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  globalContextTargets,
  MANAGED_CONTEXT_END,
  MANAGED_CONTEXT_START,
  mergeManagedContext,
  writeGlobalContextFiles,
} from '../src/context-files.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'context-files-'));
const HOME = path.join(TMP, 'home');
const WORKSPACES = path.join(TMP, 'workspaces');
const REPO = path.join(WORKSPACES, 'project');
fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });

const ENV = {
  HOME,
  AM_MANAGE_GLOBAL_CONTEXT: '1',
  CLAUDE_CONFIG_DIR: path.join(TMP, 'live', 'claude'),
  CODEX_HOME: path.join(TMP, 'live', 'codex'),
  GEMINI_CLI_HOME: path.join(TMP, 'live', 'gemini-home'),
  OPENCODE_LIVE: path.join(TMP, 'live', 'opencode'),
  HERMES_LIVE: path.join(TMP, 'live', 'hermes'),
  OPENCLAW_HOME: path.join(TMP, 'live', 'openclaw-home'),
};

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};
const occurrences = (text, needle) => text.split(needle).length - 1;

console.log('\nmanager homes opt in; an ordinary dev server writes nowhere');
check('HOME alone resolves no targets', globalContextTargets({ HOME }).targets.length, 0);
check('CLI state variables alone do not opt in', globalContextTargets({
  HOME,
  CODEX_HOME: path.join(TMP, 'developer-codex-home'),
}).targets.length, 0);
const entrypoint = fs.readFileSync(new URL('../../entrypoint.sh', import.meta.url), 'utf8');
check('Docker/Space entrypoint opts its isolated homes in',
  entrypoint.includes('export AM_MANAGE_GLOBAL_CONTEXT="${AM_MANAGE_GLOBAL_CONTEXT:-1}"'), true);
const backend = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
check('entrypoint context flag is explicitly classified as non-secret',
  backend.includes("'AM_MANAGE_GLOBAL_CONTEXT'"), true);

console.log('\nexplicit self-host mode uses each CLI supported user-level fallback');
const selfHostHome = path.join(TMP, 'self-host-home');
const selfHost = globalContextTargets({
  HOME: selfHostHome,
  AM_MANAGE_GLOBAL_CONTEXT: '1',
});
const selfHostByCli = Object.fromEntries(selfHost.targets.map((target) => [target.cli, target.file]));
check('self-host Claude fallback', selfHostByCli.claude, path.join(selfHostHome, '.claude', 'CLAUDE.md'));
check('self-host Codex fallback', selfHostByCli.codex, path.join(selfHostHome, '.codex', 'AGENTS.md'));
check('self-host Gemini fallback', selfHostByCli.gemini, path.join(selfHostHome, '.gemini', 'GEMINI.md'));
check('self-host OpenCode fallback', selfHostByCli.opencode, path.join(selfHostHome, '.config', 'opencode', 'AGENTS.md'));
check('self-host Hermes fallback', selfHostByCli.hermes, path.join(selfHostHome, '.hermes', 'memories', 'USER.md'));
check('self-host OpenClaw fallback', selfHostByCli.openclaw, path.join(selfHostHome, '.openclaw', 'workspace', 'AGENTS.md'));
check('self-host mode covers all six harnesses', selfHost.targets.length, 6);
const selfHostWrite = writeGlobalContextFiles({
  HOME: selfHostHome,
  AM_MANAGE_GLOBAL_CONTEXT: '1',
}, 7860);
check('self-host fallback files are written', selfHostWrite.written.length, 6);
check('self-host fallback files contain context', selfHost.targets.every(({ file }) => (
  fs.readFileSync(file, 'utf8').includes(MANAGED_CONTEXT_START)
)), true);

console.log('\neach CLI resolves its supported global/user instruction location');
const resolved = globalContextTargets(ENV);
const byCli = Object.fromEntries(resolved.targets.map((target) => [target.cli, target.file]));
check('Claude user instructions', byCli.claude, path.join(ENV.CLAUDE_CONFIG_DIR, 'CLAUDE.md'));
check('Codex global instructions', byCli.codex, path.join(ENV.CODEX_HOME, 'AGENTS.md'));
check('Gemini global memory', byCli.gemini, path.join(ENV.GEMINI_CLI_HOME, '.gemini', 'GEMINI.md'));
check('OpenCode global instructions', byCli.opencode, path.join(HOME, '.config', 'opencode', 'AGENTS.md'));
check('Hermes global user snapshot', byCli.hermes, path.join(ENV.HERMES_LIVE, 'memories', 'USER.md'));
check('OpenClaw private workspace', byCli.openclaw, path.join(ENV.OPENCLAW_HOME, '.openclaw', 'workspace', 'AGENTS.md'));
check('all six harnesses covered', resolved.targets.length, 6);
check('standard layout skips nothing', resolved.skipped.length, 0);
check('no target is in the workspaces tree', resolved.targets.some(({ file }) => file.startsWith(`${WORKSPACES}${path.sep}`)), false);

console.log('\nmanaged blocks preserve every operator-owned global file');
const prefix = '# Operator settings\n\nKeep this exact text.\n';
for (const { file } of resolved.targets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prefix);
}
const first = writeGlobalContextFiles(ENV, 7860);
check('all global files reported written', first.written.length, 6);
check('no target skipped', first.skipped.length, 0);
for (const { cli, file } of resolved.targets) {
  const text = fs.readFileSync(file, 'utf8');
  check(`${cli} operator prefix preserved`, text.startsWith(prefix), true);
  check(`${cli} has one managed block`, occurrences(text, MANAGED_CONTEXT_START), 1);
  check(`${cli} has the configured fallback`, text.includes('${AM_PORT:-7860}'), true);
}
check('project directory remains untouched', fs.readdirSync(REPO).join(','), '.git');

console.log('\nrefresh is idempotent and preserves text after the managed block');
check('unchanged refresh writes nothing', writeGlobalContextFiles(ENV, 7860).written.length, 0);
const claudeFile = byCli.claude;
const suffix = '\n## Operator tail\nKeep this too.\n';
fs.appendFileSync(claudeFile, suffix);
const refreshed = writeGlobalContextFiles(ENV, 9000);
check('all six files refresh for a changed port', refreshed.written.length, 6);
const claude = fs.readFileSync(claudeFile, 'utf8');
check('operator prefix survives refresh', claude.startsWith(prefix), true);
check('operator suffix survives refresh', claude.endsWith(suffix), true);
check('old port removed', claude.includes('${AM_PORT:-7860}'), false);
check('new port present', claude.includes('${AM_PORT:-9000}'), true);
check('refresh does not duplicate the block', occurrences(claude, MANAGED_CONTEXT_END), 1);
check('does not promise an environment skill exists', claude.includes('environment` skill'), false);

console.log('\nmalformed ownership markers fail closed without blocking other CLIs');
const malformed = `# Operator file\n${MANAGED_CONTEXT_START}\nunfinished\n`;
let error = null;
try { mergeManagedContext(malformed, 7860); } catch (e) { error = e; }
check('merge refuses ambiguous ownership', error instanceof Error, true);
fs.writeFileSync(byCli.codex, malformed);
const originalError = console.error;
const originalWarn = console.warn;
console.error = () => {};
console.warn = () => {};
const partial = writeGlobalContextFiles(ENV, 9100);
console.error = originalError;
console.warn = originalWarn;
check('one malformed file is skipped', partial.skipped.length, 1);
check('the other five files still refresh', partial.written.length, 5);
check('malformed operator file is untouched', fs.readFileSync(byCli.codex, 'utf8'), malformed);

console.log('\nOpenClaw never writes into an external custom workspace');
fs.writeFileSync(byCli.codex, mergeManagedContext(prefix, 9100));
const clawState = path.join(ENV.OPENCLAW_HOME, '.openclaw');
fs.mkdirSync(clawState, { recursive: true });
fs.writeFileSync(path.join(clawState, 'openclaw.json'), JSON.stringify({
  agents: { defaults: { workspace: REPO } },
}));
const external = globalContextTargets(ENV);
check('external OpenClaw target omitted', external.targets.some(({ cli }) => cli === 'openclaw'), false);
check('external boundary is documented', external.skipped[0]?.cli, 'openclaw');
console.warn = () => {};
const externalWrite = writeGlobalContextFiles(ENV, 9200);
console.warn = originalWarn;
check('external workspace reported skipped', externalWrite.skipped[0]?.cli, 'openclaw');
check('project directory is still untouched', fs.readdirSync(REPO).join(','), '.git');

const linkedProject = path.join(ENV.OPENCLAW_HOME, 'linked-project');
fs.symlinkSync(REPO, linkedProject, 'dir');
fs.writeFileSync(path.join(clawState, 'openclaw.json'), JSON.stringify({
  agents: { defaults: { workspace: '~/linked-project' } },
}));
const symlinked = globalContextTargets(ENV);
check('symlink escape is not considered manager-owned', symlinked.targets.some(({ cli }) => cli === 'openclaw'), false);
check('symlink escape is reported', symlinked.skipped[0]?.cli, 'openclaw');

fs.writeFileSync(path.join(clawState, 'openclaw.json'), JSON.stringify({
  agents: { defaults: { workspace: '${OPENCLAW_WORKSPACE}' } },
}));
const unresolved = globalContextTargets(ENV);
check('unresolved custom workspace is omitted', unresolved.targets.some(({ cli }) => cli === 'openclaw'), false);
check('unresolved custom workspace is reported', unresolved.skipped[0]?.cli, 'openclaw');

const privateRepo = path.join(ENV.OPENCLAW_HOME, '.openclaw', 'private-repo');
fs.mkdirSync(path.join(privateRepo, '.git'), { recursive: true });
fs.writeFileSync(path.join(clawState, 'openclaw.json'), JSON.stringify({
  agents: { defaults: { workspace: privateRepo } },
}));
const gitWorkspace = globalContextTargets(ENV);
check('manager-home Git workspace is not modified', gitWorkspace.targets.some(({ cli }) => cli === 'openclaw'), false);
check('Git workspace boundary is reported', gitWorkspace.skipped[0]?.reason, 'workspace is a Git repository');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
