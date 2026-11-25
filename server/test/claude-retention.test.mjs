// Claude transcript recovery from durable bucket state, non-prefix history
// temp files, and bounded graceful shutdown drain (`stopAll`).
//
// Run with: node --test test/claude-retention.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-retention-'));
const amLocal = path.join(root, 'am-local');
const binDir = path.join(amLocal, 'bin');
process.env.DATA_DIR = path.join(root, 'data');
process.env.AM_LOCAL = amLocal;
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'local-claude');
process.env.CLAUDE_DURABLE = path.join(process.env.DATA_DIR, 'state', 'claude');
fs.mkdirSync(path.join(process.env.DATA_DIR, 'workspaces'), { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.CLAUDE_DURABLE, { recursive: true });

const runner = await import('../src/runner.js');
const { createTerminalHistoryCheckpoint, loadTerminalHistory } = await import('../src/history-store.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('recoverClaudeTranscript restores a GC-deleted local transcript from CLAUDE_DURABLE before resume', () => {
  const uuid = '536ba362-de25-4a19-b27a-e770c525f128';
  const workdir = path.join(process.env.DATA_DIR, 'workspaces', 'proj-a');
  const slug = workdir.replace(/[^a-zA-Z0-9-]/g, '-');
  const durableDir = path.join(process.env.CLAUDE_DURABLE, 'projects', slug);
  fs.mkdirSync(durableDir, { recursive: true });
  const durableFile = path.join(durableDir, `${uuid}.jsonl`);
  const payload = '{"type":"user","message":{"content":"survives 30-day GC"}}\n';
  fs.writeFileSync(durableFile, payload);
  const oldTime = new Date('2026-10-15T12:00:00Z');
  fs.utimesSync(durableFile, oldTime, oldTime);

  const session = {
    id: 'proj-a-111111',
    cli: 'claude',
    path: 'proj-a',
    everStarted: true,
    sessionUuid: uuid,
  };

  const recovered = runner.recoverClaudeTranscript(session, workdir);
  const expectedLocal = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug, `${uuid}.jsonl`);
  assert.equal(recovered, expectedLocal);
  assert.equal(fs.readFileSync(expectedLocal, 'utf8'), payload);
  assert.equal(Math.round(fs.statSync(expectedLocal).mtimeMs / 1000), Math.round(oldTime.getTime() / 1000));

  // Idempotent once local transcript exists: never overwrites newer local turns.
  const newerPayload = `${payload}{"type":"assistant","message":{"content":"new turn"}}\n`;
  fs.writeFileSync(expectedLocal, newerPayload);
  assert.equal(runner.recoverClaudeTranscript(session, workdir), null);
  assert.equal(fs.readFileSync(expectedLocal, 'utf8'), newerPayload);
});

test('recoverClaudeTranscript finds durable transcripts even when project folder moved', () => {
  const uuid = '6c0a6112-d0d8-478d-8873-6e6dc3ecc2d4';
  const oldSlug = '-data-workspaces-old-location';
  const durableDir = path.join(process.env.CLAUDE_DURABLE, 'projects', oldSlug);
  fs.mkdirSync(durableDir, { recursive: true });
  const payload = '{"type":"user","message":{"content":"moved folder"}}\n';
  fs.writeFileSync(path.join(durableDir, `${uuid}.jsonl`), payload);

  const session = {
    id: 'moved-222222',
    cli: 'claude',
    path: 'new-location',
    everStarted: true,
    sessionUuid: uuid,
  };
  const workdir = path.join(process.env.DATA_DIR, 'workspaces', 'new-location');
  const recovered = runner.recoverClaudeTranscript(session, workdir);
  assert.equal(recovered, path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', oldSlug, `${uuid}.jsonl`));
  assert.equal(fs.readFileSync(recovered, 'utf8'), payload);
});

test('recoverClaudeTranscript ignores empty durable stubs and unstarted/non-claude sessions', () => {
  const uuid = '0dcf86f6-6308-4ffc-9e3d-0d6d8c433c6d';
  const slug = '-data-workspaces-empty-stub';
  const durableDir = path.join(process.env.CLAUDE_DURABLE, 'projects', slug);
  fs.mkdirSync(durableDir, { recursive: true });
  fs.writeFileSync(path.join(durableDir, `${uuid}.jsonl`), '');

  const workdir = path.join(process.env.DATA_DIR, 'workspaces', 'empty-stub');
  assert.equal(runner.recoverClaudeTranscript({
    id: 's1', cli: 'claude', everStarted: true, sessionUuid: uuid,
  }, workdir), null, '0-byte file is not recovered');
  assert.equal(runner.recoverClaudeTranscript({
    id: 's2', cli: 'claude', everStarted: false, sessionUuid: uuid,
  }, workdir), null, 'never-started session does not scan durable');
  assert.equal(runner.recoverClaudeTranscript({
    id: 's3', cli: 'codex', everStarted: true, sessionUuid: uuid,
  }, workdir), null, 'non-claude session ignored');
});

test('terminal history checkpoint writes dot-prefixed temp files and flush() awaits rename completion', async () => {
  const histDir = path.join(root, 'terminal-history');
  const seenTemps = [];
  const origWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async (file, data, ...rest) => {
    seenTemps.push(path.basename(String(file)));
    return origWriteFile.call(fs.promises, file, data, ...rest);
  };
  try {
    const cp = createTerminalHistoryCheckpoint({
      directory: histDir,
      id: 'sess-alpha',
      delayMs: 60_000,
      blocked: () => false,
      snapshot: () => ({ cols: 100, scrollbackLines: [{ text: 'hello world' }] }),
    });
    await cp.flush();
    assert.equal(seenTemps.length, 1);
    assert.ok(seenTemps[0].startsWith('.sess-alpha.json.'), `temp file must start with leading dot, got ${seenTemps[0]}`);
    assert.ok(!seenTemps[0].startsWith('sess-alpha.json'), 'target filename must not be a prefix of temp filename');
    const loaded = loadTerminalHistory(histDir, 'sess-alpha');
    assert.equal(loaded?.cols, 100);
    assert.deepEqual(loaded?.lines, [{ text: 'hello world' }]);
  } finally {
    fs.promises.writeFile = origWriteFile;
  }
});

test('stopAll gives slow SIGHUP handlers >1s default drain and flushes terminal history before returning', async () => {
  assert.ok(runner.DEFAULT_STOP_ALL_TIMEOUT_MS >= 5000, `expected >=5000ms shutdown drain, got ${runner.DEFAULT_STOP_ALL_TIMEOUT_MS}`);
  await runner.ghosttyReady();

  // /etc/profile.d/agent-manager.sh prepends $AM_LOCAL/bin on login shells, so
  // place a fixture `claude` binary there and verify a slow (1.4s) SIGHUP
  // handler finishes cleanly instead of being cut off at the old 1000ms timeout.
  const readyFile = path.join(root, 'trap-ready.txt');
  const marker = path.join(root, 'graceful-exit.txt');
  const fakeClaude = path.join(binDir, 'claude');
  fs.writeFileSync(fakeClaude, [
    '#!/usr/bin/env bash',
    `trap 'sleep 1.4; printf flushed > "${marker}"; exit 0' HUP TERM`,
    // Emit >30 lines so scrollback has lines for terminal-history to flush.
    'for i in $(seq 1 40); do echo "line-$i"; done',
    `printf ready > "${readyFile}"`,
    'while true; do sleep 0.2; done',
    '',
  ].join('\n'), { mode: 0o755 });

  try {
    const session = {
      id: 'drain-claude-1',
      name: 'drain-claude-1',
      cli: 'claude',
      path: 'drain-claude-1',
      sessionUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      everStarted: false,
    };
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'workspaces', session.path), { recursive: true });
    runner.ensureRunning(session, 80, 24);
    assert.equal(runner.isRunning(session.id), true);

    for (let i = 0; i < 60 && !fs.existsSync(readyFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(fs.existsSync(readyFile), true, 'fixture CLI booted and installed SIGHUP trap');
    await new Promise((r) => setTimeout(r, 150));

    const t0 = Date.now();
    await runner.stopAll();
    const elapsed = Date.now() - t0;
    assert.equal(fs.existsSync(marker), true, `process should finish 1.4s HUP cleanup before stopAll resolves (elapsed=${elapsed}ms)`);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'flushed');
    const hist = loadTerminalHistory(path.join(process.env.DATA_DIR, 'state', 'terminal-history'), session.id);
    assert.ok(hist && hist.lines.some((l) => l.text.includes('line-1')), 'stopAll flushed terminal history before resolving');
  } finally {
    fs.rmSync(fakeClaude, { force: true });
  }
});
