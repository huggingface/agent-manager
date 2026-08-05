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
check('follows the successor', (await runner.claudeCandidate('s1', WORKDIR, SINCE))?.uuid, B);

console.log('\na conversation in a different folder is never claimed');
transcript('cccccccc-0000-0000-0000-000000000003',
  { cwd: path.join(cfg.WORKSPACES_DIR, 'proj-b'), startMs: NOW + 120_000, projDir: '-proj-b' });
check('other folder ignored', (await runner.claudeCandidate('s1', WORKDIR, SINCE))?.uuid, B);

console.log('\nan older thread that merely received writes is not a successor');
transcript('dddddddd-0000-0000-0000-000000000004', { startMs: NOW - 3600_000, mtimeMs: NOW + 180_000 });
check('pre-window thread rejected despite a fresh mtime',
  (await runner.claudeCandidate('s1', WORKDIR, SINCE))?.uuid, B);

console.log('\na conversation another session has pinned is left to it');
const rival = sessions.create({ name: 'rival', cli: 'claude', path: 'proj-a' });
sessions.update(rival.id, { sessionUuid: B });
check('claimed uuid skipped', (await runner.claudeCandidate('s1', WORKDIR, SINCE))?.uuid, A);

console.log('\nnothing new in the window means no re-pin');
check('no candidate', await runner.claudeCandidate('s1', path.join(cfg.WORKSPACES_DIR, 'empty'), SINCE), null);

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

// ---------- the pane root: the fact every breadcrumb is trusted against ----------
// paneRootPid used to shell out to `tmux list-panes`. The libghostty migration
// removed tmux but left the call, referencing identifiers that no longer exist —
// so it threw into its own bare catch, returned null, and every breadcrumb was
// rejected as 'pid not in pane'. A null pane root disables the hook path wholesale,
// so this asserts against a REAL running session rather than a mock.
console.log('\nthe pane root is the session PTY the server holds');
check('unknown session has no pane root', runner.paneRootPid('nope'), null);
const live = sessions.create({ name: 'live', cli: 'shell', path: 'proj-a' });
let liveRoot = null;
try {
  runner.ensureRunning(live, 80, 24);
  liveRoot = runner.paneRootPid(live.id);
  check('live session has a pane root', Number.isInteger(liveRoot) && liveRoot > 1, true);
  check('the pane root is a live process', fs.existsSync(`/proc/${liveRoot}`), true);
} finally {
  runner.stop(live.id);
}

// ---------- scan cadence: the breadcrumb is the mechanism, the scan a backstop ----------
// With the scan awaited the cadence is no longer about event-loop block time — it
// is about not walking the bucket 3x a minute per pane for an answer the
// breadcrumb already gave. So the backstop is a minute, and a minute is also the
// longest a pin can stay stale if a crumb is ever lost.
const MINUTE = 60_000;
console.log('\nwithout a proven hook the scan runs every tick (unchanged)');
check('no proof: due immediately', runner.claudeScanDue({ hookProven: false, lastScanAt: NOW }, NOW), true);
check('no proof: still due 20s later',
  runner.claudeScanDue({ hookProven: false, lastScanAt: NOW }, NOW + 20_000), true);

console.log('\na proven hook steps the scan down to the backstop cadence');
check('proven: not due on the next beat',
  runner.claudeScanDue({ hookProven: true, lastScanAt: NOW }, NOW + 20_000), false);
check('proven: not due at 59s',
  runner.claudeScanDue({ hookProven: true, lastScanAt: NOW }, NOW + MINUTE - 1000), false);
check('proven: due again at a minute',
  runner.claudeScanDue({ hookProven: true, lastScanAt: NOW }, NOW + MINUTE), true);

console.log('\na proven pane still scans once before its first backstop');
check('proven but never scanned: due',
  runner.claudeScanDue({ hookProven: true, lastScanAt: 0 }, NOW), true);

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
