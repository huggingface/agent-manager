// Pre-answering the folder-trust dialog, which is the one first-run question a
// NEW session always hits: both CLIs key trust on the absolute path, so a
// trusted parent does not cover its children.
//
// Run with: node --test test/first-run.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.CODEX_HOME = path.join(root, 'codex');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const { trustWorkspace, ensureClaudeDialogDefaults, claudeStateFile, codexConfigFile } =
  await import('../src/first-run.js');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('claude: the folder is trusted, and nothing else in the file is touched', () => {
  fs.writeFileSync(claudeStateFile(), JSON.stringify({
    hasCompletedOnboarding: true, userID: 'keep-me',
    projects: { '/existing': { hasTrustDialogAccepted: true, allowedTools: ['a'] } },
  }));
  assert.equal(trustWorkspace('claude', '/work/new-one'), true);
  const cfg = readJson(claudeStateFile());
  assert.equal(cfg.projects['/work/new-one'].hasTrustDialogAccepted, true);
  assert.equal(cfg.hasCompletedOnboarding, true, 'global answers survive');
  assert.equal(cfg.userID, 'keep-me');
  assert.deepEqual(cfg.projects['/existing'].allowedTools, ['a'], 'other projects survive');
});

test('claude: an existing project entry keeps its other keys', () => {
  fs.writeFileSync(claudeStateFile(), JSON.stringify({
    projects: { '/work/partial': { allowedTools: ['x'], projectOnboardingSeenCount: 3 } },
  }));
  assert.equal(trustWorkspace('claude', '/work/partial'), true);
  const entry = readJson(claudeStateFile()).projects['/work/partial'];
  assert.equal(entry.hasTrustDialogAccepted, true);
  assert.deepEqual(entry.allowedTools, ['x']);
  assert.equal(entry.projectOnboardingSeenCount, 3);
});

test('claude: already answered is a no-op, so a running CLI is not rewritten under it', () => {
  fs.writeFileSync(claudeStateFile(), JSON.stringify({
    projects: { '/work/done': { hasTrustDialogAccepted: true } },
  }));
  const before = fs.readFileSync(claudeStateFile(), 'utf8');
  assert.equal(trustWorkspace('claude', '/work/done'), false);
  assert.equal(fs.readFileSync(claudeStateFile(), 'utf8'), before);
});

test('claude: a missing state file is created with only what we know', () => {
  fs.rmSync(claudeStateFile(), { force: true });
  assert.equal(trustWorkspace('claude', '/work/fresh'), true);
  const cfg = readJson(claudeStateFile());
  assert.deepEqual(Object.keys(cfg), ['projects']);
  assert.equal(cfg.projects['/work/fresh'].hasTrustDialogAccepted, true);
});

test('codex: the table is appended and the file still parses, with globals intact', async () => {
  const { parse } = await import('node:toml').catch(() => ({ parse: null }));
  fs.writeFileSync(codexConfigFile(), 'approval_policy = "never"\nmodel = "gpt-5"\n\n[projects."/old"]\ntrust_level = "trusted"\n');
  assert.equal(trustWorkspace('codex', '/work/new-two'), true);
  const text = fs.readFileSync(codexConfigFile(), 'utf8');
  assert.match(text, /\[projects\."\/work\/new-two"\]\ntrust_level = "trusted"/);
  assert.match(text, /approval_policy = "never"/, 'globals survive');
  assert.match(text, /\[projects\."\/old"\]/, 'other projects survive');
  if (parse) {
    const cfg = parse(text);
    assert.equal(cfg.projects['/work/new-two'].trust_level, 'trusted');
  }
});

test('codex: appending twice does not duplicate the table', () => {
  fs.writeFileSync(codexConfigFile(), 'model = "gpt-5"\n');
  assert.equal(trustWorkspace('codex', '/work/twice'), true);
  assert.equal(trustWorkspace('codex', '/work/twice'), false);
  const text = fs.readFileSync(codexConfigFile(), 'utf8');
  assert.equal(text.match(/\[projects\."\/work\/twice"\]/g).length, 1);
});

test('codex: a quote in the path is escaped, so the file cannot be broken by a folder name', () => {
  fs.writeFileSync(codexConfigFile(), '');
  assert.equal(trustWorkspace('codex', '/work/od"d'), true);
  assert.match(fs.readFileSync(codexConfigFile(), 'utf8'), /\[projects\."\/work\/od\\"d"\]/);
});

test('only the two CLIs that ask are touched, and only absolute paths', () => {
  assert.equal(trustWorkspace('shell', '/work/x'), false);
  assert.equal(trustWorkspace('gemini', '/work/x'), false);
  assert.equal(trustWorkspace('claude', 'relative/path'), false);
  assert.equal(trustWorkspace('claude', ''), false);
});

test('the bypass-mode warning is answered once, and never re-written', () => {
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: ['keep'] } }));
  assert.equal(ensureClaudeDialogDefaults(), true);
  const cfg = readJson(settings);
  assert.equal(cfg.skipDangerousModePermissionPrompt, true);
  assert.deepEqual(cfg.hooks.SessionStart, ['keep'], 'the hooks installer is not disturbed');
  assert.equal(ensureClaudeDialogDefaults(), false, 'idempotent');
  // and it grants nothing: permissions are left exactly as found
  assert.equal(cfg.permissions, undefined);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
