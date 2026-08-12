// Conversation re-pinning: which transcript a session should follow.
//
// Regression cover for the bug where a mid-session `/clear` left the pin on the
// abandoned conversation, so `--resume` restored the pre-/clear thread after a
// restart. Run with: node test/repin.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));
const CFG = path.join(TMP, 'cfg');
const DATA = path.join(TMP, 'data');
const REPIN = path.join(TMP, 'repin');
const CODEX = path.join(TMP, 'codex');
fs.mkdirSync(path.join(CFG, 'projects'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(CODEX, 'sessions', '2026', '08', '06'), { recursive: true });

process.env.CLAUDE_CONFIG_DIR = CFG;
process.env.DATA_DIR = DATA;
process.env.AM_REPIN_DIR = REPIN;
process.env.CODEX_HOME = CODEX;

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

// ---------- the folder is a tree ----------
// An agent that enters a git worktree is still the same pane in the same folder,
// and the conversation its /clear starts records the DEEPER cwd. Equality here
// meant the pin could never follow that — the reader kept showing the pre-/clear
// thread while the terminal showed the new one, and the next launch would
// `--resume` the abandoned id.
console.log('\ncwdUnderWorkdir: the pane owns its whole tree, and nothing beside it');
const WT = path.join(WORKDIR, '.claude', 'worktrees', 'wt-1');
check('the folder itself', runner.cwdUnderWorkdir(WORKDIR, WORKDIR), true);
check('a worktree below it', runner.cwdUnderWorkdir(WT, WORKDIR), true);
check('a plain subdirectory', runner.cwdUnderWorkdir(path.join(WORKDIR, 'server'), WORKDIR), true);
check('a sibling sharing a name prefix',
  runner.cwdUnderWorkdir(`${WORKDIR}2`, WORKDIR), false);
check('the parent folder', runner.cwdUnderWorkdir(cfg.WORKSPACES_DIR, WORKDIR), false);
check('somewhere else entirely', runner.cwdUnderWorkdir('/elsewhere', WORKDIR), false);
check('no cwd at all', runner.cwdUnderWorkdir(null, WORKDIR), false);
check('no workdir at all', runner.cwdUnderWorkdir(WORKDIR, ''), false);

console.log('\na /clear inside a worktree is followed');
const F = 'ffffffff-0000-0000-0000-000000000006';
transcript(F, { cwd: WT, startMs: NOW + 240_000, projDir: '-proj-a--claude-worktrees-wt-1' });
check('worktree conversation claimed', (await runner.claudeCandidate('s1', WORKDIR, SINCE))?.uuid, F);

console.log('\na neighbouring folder whose name starts the same is still not ours');
transcript('99999999-0000-0000-0000-000000000009',
  { cwd: `${WORKDIR}2`, startMs: NOW + 300_000, projDir: '-proj-a2' });
check('prefix neighbour ignored', (await runner.claudeCandidate('s1', WORKDIR, SINCE))?.uuid, F);

// ---------- breadcrumbs: attribution the scan cannot do in shared folders ----------
const E = 'eeeeeeee-0000-0000-0000-000000000005';
const RUN = '11111111-2222-4333-8444-555555555555';
const crumb = (over = {}) => ({
  amId: 's1', runId: RUN, cli: 'claude', claudePid: 4242,
  payload: { session_id: E, cwd: WORKDIR, source: 'clear' },
  ...over,
});
const facts = (over = {}) => ({
  cli: 'claude', runId: RUN, workdir: WORKDIR, pinned: A,
  claimed: new Set([B]), pidTrusted: true, ...over,
});
const verdict = (c, f) => runner.breadcrumbVerdict(c, 's1', f);

console.log('\na trusted breadcrumb re-pins, no folder-sharing question asked');
check('clean crumb accepted', verdict(crumb(), facts()).repin, E);

console.log('\na breadcrumb only speaks for the pane that wrote it');
check('amId mismatch rejected', verdict(crumb({ amId: 's2' }), facts()).repin, null);
check('stale launch rejected', verdict(crumb({ runId: 'old-run' }), facts()).why, 'runId mismatch');
check('wrong harness rejected', verdict(crumb({ cli: 'codex' }), facts()).why, 'cli mismatch');
check('cwd mismatch rejected',
  verdict(crumb({ payload: { session_id: E, cwd: '/elsewhere', source: 'clear' } }), facts()).repin, null);
check('a crumb from a parent folder rejected',
  verdict(crumb({ payload: { session_id: E, cwd: cfg.WORKSPACES_DIR, source: 'clear' } }), facts()).why,
  'cwd outside the session folder');
check('a crumb from a prefix neighbour rejected',
  verdict(crumb({ payload: { session_id: E, cwd: `${WORKDIR}2`, source: 'clear' } }), facts()).repin, null);

console.log('\na /clear reported from a worktree below the folder is this pane speaking');
check('worktree crumb accepted',
  verdict(crumb({ payload: { session_id: E, cwd: WT, source: 'clear' } }), facts()).repin, E);

console.log('\na nested claude -p cannot claim the pane (pid not under the pane root)');
check('untrusted pid rejected', verdict(crumb(), facts({ pidTrusted: false })).repin, null);
check('untrusted pid says why', verdict(crumb(), facts({ pidTrusted: false })).why, 'pid not top-level pane agent');

console.log('\nno-ops and garbage stay no-ops');
check('already-pinned crumb is a no-op',
  verdict(crumb({ payload: { session_id: A, cwd: WORKDIR, source: 'resume' } }), facts()).why, 'already pinned');
check('claimed uuid left to its session',
  verdict(crumb({ payload: { session_id: B, cwd: WORKDIR, source: 'clear' } }), facts()).why, 'claimed by another session');
check('malformed session_id rejected',
  verdict(crumb({ payload: { session_id: 'not-a-uuid', cwd: WORKDIR } }), facts()).repin, null);
check('null crumb rejected', verdict(null, facts()).repin, null);

console.log('\nCodex and OpenCode use the same pane/run attribution contract');
const CODEX_ID = '12345678-1234-4234-8234-123456789abc';
const rollout = path.join(CODEX, 'sessions', '2026', '08', '06', `rollout-2026-08-06T00-00-00-${CODEX_ID}.jsonl`);
fs.writeFileSync(rollout, '{}\n');
const codexCrumb = {
  amId: 's1', runId: RUN, cli: 'codex',
  payload: { session_id: CODEX_ID, transcript_path: rollout, cwd: WORKDIR, source: 'clear' },
};
check('Codex exact id accepted', runner.breadcrumbVerdict(codexCrumb, 's1', {
  cli: 'codex', runId: RUN, workdir: WORKDIR, pinned: null, claimed: new Set(), pidTrusted: true,
}).repin, CODEX_ID);
check('Codex rollout path retained', runner.codexRolloutForBreadcrumb(codexCrumb), rollout);
check('Codex null transcript resolves by exact id', runner.codexRolloutForId(CODEX_ID), rollout);
const CODEX_ALIAS = path.join(TMP, 'codex-alias');
fs.mkdirSync(CODEX_ALIAS);
fs.symlinkSync(path.join(CODEX, 'sessions'), path.join(CODEX_ALIAS, 'sessions'));
process.env.CODEX_HOME = CODEX_ALIAS;
check('Codex canonical path accepted through a symlinked sessions root',
  runner.codexRolloutForBreadcrumb(codexCrumb), rollout);
process.env.CODEX_HOME = CODEX;
check('Codex path outside CODEX_HOME rejected', runner.codexRolloutForBreadcrumb({
  ...codexCrumb, payload: { ...codexCrumb.payload, transcript_path: `/tmp/rollout-x-${CODEX_ID}.jsonl` },
}), null);
check('OpenCode exact id accepted', runner.breadcrumbVerdict({
  amId: 's1', runId: RUN, cli: 'opencode',
  payload: { session_id: 'ses_1234567890abcdef', cwd: WORKDIR },
}, 's1', {
  cli: 'opencode', runId: RUN, workdir: WORKDIR, pinned: null, claimed: new Set(), pidTrusted: true,
}).repin, 'ses_1234567890abcdef');

console.log('\nonly the top-level agent process may emit a breadcrumb');
const proc = new Map([
  [99, '99 (bash) S 1 0 0'],
  [100, '100 (node) S 1 0 0'],
  [101, '101 (claude) S 100 0 0'],
  [102, '102 (nested claude) S 101 0 0'],
  [110, '110 (codex-x64 (native)) S 100 0 0'],
  [120, '120 (tool shell) S 110 0 0'],
  [200, '200 (node) S 120 0 0'],
  [210, '210 (codex-x64) S 200 0 0'],
]);
const readStat = (pid) => {
  if (!proc.has(pid)) throw new Error('gone');
  return proc.get(pid);
};
check('pane root accepted', runner.pidIsPaneRootOrDirectChild(100, 100, readStat), true);
check('direct Claude child accepted', runner.pidIsPaneRootOrDirectChild(101, 100, readStat), true);
check('nested Claude rejected', runner.pidIsPaneRootOrDirectChild(102, 100, readStat), false);
check('top native Codex accepted', runner.codexProcessPidTrusted(110, 100, readStat), true);
proc.set(100, '100 (node) S 99 0 0');
check('Codex behind retained launch shell accepted', runner.codexProcessPidTrusted(110, 99, readStat), true);
check('nested native Codex rejected', runner.codexProcessPidTrusted(210, 100, readStat), false);
check('gone Codex pid rejected', runner.codexProcessPidTrusted(999, 100, readStat), false);

console.log('\nhook scripts preserve the pane and launch identity');
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const repoRoot = path.dirname(scripts);
const requirements = fs.readFileSync(path.join(repoRoot, 'codex-requirements.toml'), 'utf8');
check('Codex hook is managed (no user trust prompt)', requirements.includes('managed_dir = "/etc/codex/hooks"'), true);
check('managed policy runs the root-owned hook', requirements.includes('command = "/etc/codex/hooks/am-codex-repin-hook.sh"'), true);
const hookPayload = JSON.stringify({ session_id: E, transcript_path: '/tmp/t.jsonl', cwd: WORKDIR, source: 'clear' });
let hook = spawnSync('sh', [path.join(scripts, 'am-repin-hook.sh')], {
  input: hookPayload,
  env: {
    ...process.env, AM_ID: 's1', AM_RUN_ID: RUN, AM_CLI: 'claude',
    AM_PANE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid),
  },
});
check('Claude hook exits cleanly', hook.status, 0);
let written = JSON.parse(fs.readFileSync(path.join(REPIN, 's1.claude.json'), 'utf8'));
check('Claude hook writes run id', written.runId, RUN);
check('Claude hook writes exact session id', written.payload.session_id, E);

const codexShim = path.join(TMP, 'codex-test');
fs.symlinkSync('/bin/sh', codexShim);
const paneShim = path.join(TMP, 'pane-shell');
fs.symlinkSync('/bin/sh', paneShim);
const codexLauncher = path.join(TMP, 'codex-launcher.cjs');
fs.writeFileSync(codexLauncher, [
  "const fs = require('node:fs');",
  "const { spawnSync } = require('node:child_process');",
  "const child = spawnSync(process.argv[2], ['-c', `sh '${process.argv[3]}'`], {",
  "  input: fs.readFileSync(0), env: process.env, stdio: ['pipe', 'inherit', 'inherit'],",
  "});",
  "process.exit(child.status ?? 1);",
].join('\n'));
hook = spawnSync(paneShim, ['-c',
  `export AM_PANE_PID=$$; node '${codexLauncher}' '${codexShim}' '${path.join(scripts, 'am-codex-repin-hook.sh')}'`], {
  input: JSON.stringify(codexCrumb.payload),
  env: { ...process.env, AM_ID: 's1', AM_RUN_ID: RUN, AM_CLI: 'codex' },
});
check('Codex hook exits cleanly', hook.status, 0);
written = JSON.parse(fs.readFileSync(path.join(REPIN, 's1.codex.json'), 'utf8'));
check('Codex hook writes run id', written.runId, RUN);
check('Codex hook writes exact session id', written.payload.session_id, CODEX_ID);
check('Codex hook records its live agent process', Number.isInteger(written.codexPid), true);

// ---------- the pane root: the fact every breadcrumb is trusted against ----------
// paneRootPid used to shell out to `tmux list-panes`. The libghostty migration
// removed tmux but left the call, referencing identifiers that no longer exist —
// so it threw into its own bare catch, returned null, and every breadcrumb was
// rejected as 'pid not in pane'. A null pane root disables the hook path wholesale,
// so this asserts against a REAL running session rather than a mock.
console.log('\nthe pane root is the session PTY the server holds');
check('unknown session has no pane root', runner.paneRootPid('nope'), null);
// Spawning a real pane needs libghostty's native addon, which not every checkout
// has built. Skip rather than throw out of ensureRunning: an unhandled throw here
// aborts the process and takes the cadence and installer checks below with it,
// which reads as a broken test run rather than a missing optional dependency.
if (!runner.ghosttyReady()) {
  console.log('  SKIP  live pane checks (libghostty-vt unavailable)');
} else {
  const live = sessions.create({ name: 'live', cli: 'shell', path: 'proj-a' });
  try {
    runner.ensureRunning(live, 80, 24);
    const liveRoot = runner.paneRootPid(live.id);
    check('live session has a pane root', Number.isInteger(liveRoot) && liveRoot > 1, true);
    check('the pane root is a live process', fs.existsSync(`/proc/${liveRoot}`), true);
  } finally {
    runner.stop(live.id);
  }
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
