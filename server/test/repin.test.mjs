// Conversation re-pinning: which transcript a session should follow.
//
// Regression cover for the bug where a mid-session `/clear` left the pin on the
// abandoned conversation, so `--resume` restored the pre-/clear thread after a
// restart. Run with: node test/repin.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));
const CFG = path.join(TMP, 'cfg');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(CFG, 'projects'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

process.env.CLAUDE_CONFIG_DIR = CFG;
process.env.DATA_DIR = DATA;

const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const cfg = await import('../src/config.js');
sessions.init();

const WORKDIR = path.join(cfg.WORKSPACES_DIR, 'proj-a');
fs.mkdirSync(WORKDIR, { recursive: true });

// A transcript opens with metadata lines that carry no cwd (mode,
// file-history-snapshot, …); only the conversation lines have one. Mirror that,
// or the head-reading logic isn't really being exercised.
function transcript(uuid, { cwd = WORKDIR, startMs, mtimeMs, projDir = '-proj-a' }) {
  const dir = path.join(CFG, 'projects', projDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'mode', mode: 'default' }),
    JSON.stringify({ type: 'file-history-snapshot' }),
    JSON.stringify({ type: 'user', sessionId: uuid, cwd, timestamp: new Date(startMs).toISOString() }),
  ].join('\n') + '\n');
  const t = (mtimeMs ?? startMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}  want ${want}`}`);
};

const NOW = 1770000000000; // fixed clock: these are all relative comparisons
const SINCE = NOW - 2000;  // the launch window scheduleClaudeCapture opens with
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

console.log('\n/clear: the later-born conversation in this folder wins');
transcript(A, { startMs: NOW });
transcript(B, { startMs: NOW + 60_000 });
check('follows the successor', runner.claudeCandidate('s1', WORKDIR, SINCE)?.uuid, B);

console.log('\na conversation in a different folder is never claimed');
transcript('cccccccc-0000-0000-0000-000000000003',
  { cwd: path.join(cfg.WORKSPACES_DIR, 'proj-b'), startMs: NOW + 120_000, projDir: '-proj-b' });
check('other folder ignored', runner.claudeCandidate('s1', WORKDIR, SINCE)?.uuid, B);

console.log('\nan older thread that merely received writes is not a successor');
transcript('dddddddd-0000-0000-0000-000000000004', { startMs: NOW - 3600_000, mtimeMs: NOW + 180_000 });
check('pre-window thread rejected despite a fresh mtime',
  runner.claudeCandidate('s1', WORKDIR, SINCE)?.uuid, B);

console.log('\na conversation another session has pinned is left to it');
const rival = sessions.create({ name: 'rival', cli: 'claude', path: 'proj-a' });
sessions.update(rival.id, { sessionUuid: B });
check('claimed uuid skipped', runner.claudeCandidate('s1', WORKDIR, SINCE)?.uuid, A);

console.log('\nnothing new in the window means no re-pin');
check('no candidate', runner.claudeCandidate('s1', path.join(cfg.WORKSPACES_DIR, 'empty'), SINCE), null);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
