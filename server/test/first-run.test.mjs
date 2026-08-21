// Pre-answering the first-run dialogs, and the two rules that keep it safe:
// never rewrite CLI-owned state on the session path, and recognise an existing
// answer however it was legally spelled.
//
// Run with: node --test test/first-run.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.CODEX_HOME = path.join(root, 'codex');
for (const d of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) fs.mkdirSync(d, { recursive: true });

const fr = await import('../src/first-run.js');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---- Claude: one boot-time entry on the root, which it inherits downwards ----

test('claude: the workspaces root is trusted, and nothing else is disturbed', () => {
  fs.writeFileSync(fr.claudeStateFile(), JSON.stringify({
    hasCompletedOnboarding: true, userID: 'keep-me',
    projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: ['a'] } },
  }));
  assert.equal(fr.trustWorkspacesRoot('/data/workspaces'), 'written');
  const cfg = readJson(fr.claudeStateFile());
  assert.equal(cfg.projects['/data/workspaces'].hasTrustDialogAccepted, true);
  assert.equal(cfg.hasCompletedOnboarding, true);
  assert.equal(cfg.userID, 'keep-me');
  assert.deepEqual(cfg.projects['/elsewhere'].allowedTools, ['a']);
});

test('claude: an existing root entry keeps its other keys', () => {
  fs.writeFileSync(fr.claudeStateFile(), JSON.stringify({
    projects: { '/data/workspaces': { allowedTools: ['x'] } },
  }));
  assert.equal(fr.trustWorkspacesRoot('/data/workspaces'), 'written');
  const entry = readJson(fr.claudeStateFile()).projects['/data/workspaces'];
  assert.equal(entry.hasTrustDialogAccepted, true);
  assert.deepEqual(entry.allowedTools, ['x']);
});

test('claude: already trusted writes nothing at all', () => {
  fs.writeFileSync(fr.claudeStateFile(), JSON.stringify({
    projects: { '/data/workspaces': { hasTrustDialogAccepted: true } },
  }));
  const before = fs.readFileSync(fr.claudeStateFile(), 'utf8');
  assert.equal(fr.trustWorkspacesRoot('/data/workspaces'), 'already');
  assert.equal(fs.readFileSync(fr.claudeStateFile(), 'utf8'), before);
});

test('claude: a file we do not understand is left alone', () => {
  fs.writeFileSync(fr.claudeStateFile(), '["not","an","object"]');
  assert.equal(fr.trustWorkspacesRoot('/data/workspaces'), 'skipped');
  assert.equal(fs.readFileSync(fr.claudeStateFile(), 'utf8'), '["not","an","object"]');
  fs.writeFileSync(fr.claudeStateFile(), '{ this is not json');
  assert.equal(fr.trustWorkspacesRoot('/data/workspaces'), 'skipped');
});

// ---- Codex: append-only, and an existing answer is recognised in any spelling ----

test('codex: an existing entry is found however TOML spells the key', () => {
  const paths = fr.codexTrustedPaths([
    '[projects."/basic/string"]', 'trust_level = "trusted"',
    "[projects.'/literal/string']", 'trust_level = "trusted"',
    '  [projects."/indented"]  ',
    '[projects."/with\\"quote"]',
  ].join('\n'));
  assert.ok(paths.has('/basic/string'));
  assert.ok(paths.has('/literal/string'), 'a literal-string key is the same key');
  assert.ok(paths.has('/indented'));
  assert.ok(paths.has('/with"quote'), 'escapes are undone before comparing');
});

test('codex: a literal-string entry is not duplicated (this made the file unloadable)', () => {
  fs.writeFileSync(fr.codexConfigFile(), "[projects.'/work/legal']\ntrust_level = \"trusted\"\n");
  assert.equal(fr.trustCodexWorkspace('/work/legal'), false, 'already answered');
  const text = fs.readFileSync(fr.codexConfigFile(), 'utf8');
  assert.equal((text.match(/\[projects\./g) || []).length, 1, 'exactly one table for that path');
});

test('codex: a new path is appended, and existing bytes are untouched', () => {
  const before = 'approval_policy = "never"\nmodel = "gpt-5"\n\n[projects."/old"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(fr.codexConfigFile(), before);
  assert.equal(fr.trustCodexWorkspace('/work/new'), true);
  const text = fs.readFileSync(fr.codexConfigFile(), 'utf8');
  assert.ok(text.startsWith(before), 'append-only: the original bytes are still the prefix');
  assert.match(text, /\[projects\."\/work\/new"\]\ntrust_level = "trusted"/);
});

test('codex: appending twice does not duplicate, and a quote in the path is escaped', () => {
  fs.writeFileSync(fr.codexConfigFile(), '');
  assert.equal(fr.trustCodexWorkspace('/work/od"d'), true);
  assert.equal(fr.trustCodexWorkspace('/work/od"d'), false);
  assert.equal((fs.readFileSync(fr.codexConfigFile(), 'utf8').match(/\[projects\./g) || []).length, 1);
});

test('only absolute paths are written', () => {
  fs.writeFileSync(fr.codexConfigFile(), '');
  assert.equal(fr.trustCodexWorkspace('relative'), false);
  assert.equal(fr.trustCodexWorkspace(''), false);
});

// ---- Codex updates: suppress the modal, keep the check ----

test('a newer version is dismissed, and the check itself is left intact', () => {
  const checked = '2026-08-21T16:00:00.000000000Z';
  fs.writeFileSync(fr.codexVersionFile(), JSON.stringify({
    latest_version: '0.200.0', last_checked_at: checked, dismissed_version: null,
  }));
  assert.equal(fr.dismissCodexUpdatePrompt('0.149.0'), true);
  const cache = readJson(fr.codexVersionFile());
  assert.equal(cache.dismissed_version, '0.200.0', 'the modal will not open');
  assert.equal(cache.latest_version, '0.200.0', 'what is available is still recorded');
  assert.equal(cache.last_checked_at, checked, 'and when it was checked');
});

test('nothing is written when there is no newer version, or it is already dismissed', () => {
  fs.writeFileSync(fr.codexVersionFile(), JSON.stringify({ latest_version: '0.149.0', dismissed_version: null }));
  assert.equal(fr.dismissCodexUpdatePrompt('0.149.0'), false, 'same version');
  fs.writeFileSync(fr.codexVersionFile(), JSON.stringify({ latest_version: '0.100.0', dismissed_version: null }));
  assert.equal(fr.dismissCodexUpdatePrompt('0.149.0'), false, 'older');
  fs.writeFileSync(fr.codexVersionFile(), JSON.stringify({ latest_version: '0.200.0', dismissed_version: '0.200.0' }));
  assert.equal(fr.dismissCodexUpdatePrompt('0.149.0'), false, 'already dismissed');
  assert.equal(fr.dismissCodexUpdatePrompt(null), false, 'unknown running version: leave it alone');
});

test('versions compare by number, not by string', () => {
  assert.equal(fr.isNewer('0.200.0', '0.149.0'), true);
  assert.equal(fr.isNewer('0.9.0', '0.10.0'), false, '9 is not newer than 10');
  assert.equal(fr.isNewer('1.0.0', '0.149.0'), true);
  assert.equal(fr.isNewer('0.149.0', '0.149.0'), false);
});

// ---- the bypass warning, in the file the app already owns ----

test('the bypass-mode warning is answered once and grants nothing', () => {
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: ['keep'] } }));
  assert.equal(fr.ensureClaudeDialogDefaults(), true);
  const cfg = readJson(settings);
  assert.equal(cfg.skipDangerousModePermissionPrompt, true);
  assert.deepEqual(cfg.hooks.SessionStart, ['keep']);
  assert.equal(cfg.permissions, undefined, 'permission mode is not touched');
  assert.equal(fr.ensureClaudeDialogDefaults(), false, 'idempotent');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
