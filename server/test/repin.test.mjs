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
process.env.CODEX_HOME = path.join(TMP, 'codex');

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

// ---------- breadcrumbs: attribution the scan cannot do in shared folders ----------
const E = 'eeeeeeee-0000-0000-0000-000000000005';
const crumb = (over = {}) => ({
  amId: 's1', claudePid: 4242,
  payload: { session_id: E, cwd: WORKDIR, source: 'clear' },
  ...over,
});
const facts = (over = {}) => ({
  workdir: WORKDIR, pinned: A, claimed: new Set([B]), pidTrusted: true, ...over,
});
const verdict = (c, f) => runner.breadcrumbVerdict(c, 's1', f);

console.log('\na trusted breadcrumb re-pins, no folder-sharing question asked');
check('clean crumb accepted', verdict(crumb(), facts()).repin, E);

console.log('\na breadcrumb only speaks for the pane that wrote it');
check('amId mismatch rejected', verdict(crumb({ amId: 's2' }), facts()).repin, null);
check('cwd mismatch rejected',
  verdict(crumb({ payload: { session_id: E, cwd: '/elsewhere', source: 'clear' } }), facts()).repin, null);

console.log('\na nested claude -p cannot claim the pane (pid not under the pane root)');
check('untrusted pid rejected', verdict(crumb(), facts({ pidTrusted: false })).repin, null);
check('untrusted pid says why', verdict(crumb(), facts({ pidTrusted: false })).why, 'pid not in pane');

console.log('\nno-ops and garbage stay no-ops');
check('already-pinned crumb is a no-op',
  verdict(crumb({ payload: { session_id: A, cwd: WORKDIR, source: 'resume' } }), facts()).why, 'already pinned');
check('claimed uuid left to its session',
  verdict(crumb({ payload: { session_id: B, cwd: WORKDIR, source: 'clear' } }), facts()).why, 'claimed by another session');
check('malformed session_id rejected',
  verdict(crumb({ payload: { session_id: 'not-a-uuid', cwd: WORKDIR } }), facts()).repin, null);
check('null crumb rejected', verdict(null, facts()).repin, null);

// ---------- codex: the pin a folder-sharing pane never got ----------
// Codex has no breadcrumb, so a shared folder used to skip capture ENTIRELY and
// the pane stayed unpinned for life — conversation on disk, every restart empty.
// The initial capture is safe there; following a later reset is not.
const R = (n) => `019fd29a-97e5-7d11-b36e-3ce290b0a00${n}`;
function rollout(id, { cwd = WORKDIR, bornMs, mtimeMs, subagent = false }) {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '08', '05');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `rollout-2026-08-05T15-46-14-${id}.jsonl`);
  const payload = { cwd, timestamp: new Date(bornMs).toISOString() };
  if (subagent) payload.thread_source = 'subagent';
  fs.writeFileSync(p, JSON.stringify({ type: 'session_meta', payload }) + '\n');
  const t = (mtimeMs ?? bornMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}
const WINDOW = { bornBefore: SINCE + 120_000 };

console.log('\ncodex: the conversation born in this launch window is ours');
rollout(R(1), { bornMs: NOW });
check('own rollout captured', runner.codexCandidate('c1', WORKDIR, SINCE)?.id, R(1));

console.log('\ncodex: whose folder and whose birth, not whose mtime');
rollout(R(2), { cwd: path.join(cfg.WORKSPACES_DIR, 'proj-b'), bornMs: NOW + 1000, mtimeMs: NOW + 120_000 });
check('other folder ignored', runner.codexCandidate('c1', WORKDIR, SINCE)?.id, R(1));
rollout(R(3), { bornMs: NOW - 3600_000, mtimeMs: NOW + 180_000 });
check('pre-launch rollout rejected despite a fresh mtime',
  runner.codexCandidate('c1', WORKDIR, SINCE)?.id, R(1));
rollout(R(4), { bornMs: NOW + 5000, mtimeMs: NOW + 200_000, subagent: true });
check('subagent rollout skipped', runner.codexCandidate('c1', WORKDIR, SINCE)?.id, R(1));

console.log('\ncodex: a later conversation is a reset to follow, or a sibling to leave alone');
rollout(R(5), { bornMs: NOW + 240_000 });
check('followed when the folder is ours', runner.codexCandidate('c1', WORKDIR, SINCE)?.id, R(5));
check('out of reach in a shared folder', runner.codexCandidate('c1', WORKDIR, SINCE, WINDOW)?.id, R(1));

console.log('\ncodex: a rollout another session pinned is left to it');
const rivalCodex = sessions.create({ name: 'rival-codex', cli: 'codex', path: 'proj-a' });
sessions.update(rivalCodex.id, { codexSessionId: R(1) });
check('claimed rollout skipped', runner.codexCandidate('c1', WORKDIR, SINCE, WINDOW), null);

console.log('\ncodex: what the watcher may do on a tick');
const mode = (o) => runner.codexCaptureMode({ nowMs: NOW, sinceMs: SINCE, ...o });
check('sole pane captures and follows resets', mode({ shared: false, pinned: false }), 'follow');
check('sole pane keeps following once pinned', mode({ shared: false, pinned: true }), 'follow');
check('shared and unpinned still captures', mode({ shared: true, pinned: false }), 'window');
check('shared and pinned stops at the pin', mode({ shared: true, pinned: true }), 'pinned');
check('window is open at its last instant',
  mode({ shared: true, pinned: false, nowMs: SINCE + 120_000 }), 'window');
check('shared, unpinned, window gone',
  mode({ shared: true, pinned: false, nowMs: SINCE + 120_001 }), 'expired');

// ---------- hook installer: merge, never replace; idempotent; refuse corrupt ----------
console.log('\ninstaller merges into existing settings and is idempotent');
const settings = path.join(CFG, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));
check('installs into existing file', runner.installClaudeRepinHook('/app/scripts/am-repin-hook.sh'), true);
let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
check('other keys kept', s.model, 'opus');
check('hook entry present', s.hooks.SessionStart.length, 1);
check('second run is a no-op', runner.installClaudeRepinHook('/app/scripts/am-repin-hook.sh'), true);
s = JSON.parse(fs.readFileSync(settings, 'utf8'));
check('no duplicate entry', s.hooks.SessionStart.length, 1);

console.log('\ninstaller refuses to clobber a corrupt settings file');
fs.writeFileSync(settings, '{ not json');
check('corrupt file left alone', runner.installClaudeRepinHook('/x.sh'), false);
check('corrupt content untouched', fs.readFileSync(settings, 'utf8'), '{ not json');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
