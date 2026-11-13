// A checkpoint that fails must be written down, visible, and must not hold
// back the files that can be copied (scripts/agent-state.sh). The incident:
// from 2026-11-06 the Claude adapter failed on every pass for a week, the only
// trace went to a stdout nobody kept, and the restart restored a week-old tree.
//
// Everything runs in temporary directories. The script's environment is an
// allowlist, as in ../state-checkpoint.test.mjs: a shell inside a running Space
// exports the real live and durable paths, and none of them may reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../scripts/agent-state.sh');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ckpt-fail-'));
// checkpoint-health.js reads DATA_DIR through config.js when it is imported.
process.env.DATA_DIR = path.join(base, 'server-data');
const { readCheckpointHealth, WARN_AFTER_MS } = await import('../src/checkpoint-health.js');

const isRoot = process.getuid?.() === 0; // root reads a chmod 000 file

let n = 0;
function world(extra = {}) {
  const root = path.join(base, `w${++n}`);
  const data = path.join(root, 'durable');
  const local = path.join(root, 'local');
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', TMPDIR: path.join(root, 'tmp'),
    HOME: path.join(root, 'home'),
    DATA_DIR: data,
    AM_LOCAL: local,
    CODEX_HOME: path.join(local, 'codex'),
    CODEX_DURABLE: path.join(data, 'state/codex'),
    CLAUDE_CONFIG_DIR: path.join(local, 'claude'),
    CLAUDE_DURABLE: path.join(data, 'state/claude'),
    GEMINI_CLI_HOME: path.join(local, 'gemini-home'),
    GEMINI_LIVE: path.join(local, 'gemini-home/.gemini'),
    GEMINI_DURABLE: path.join(data, 'state/gemini'),
    OPENCLAW_STATE_DIR: path.join(local, 'openclaw'),
    OPENCLAW_DURABLE: path.join(data, 'state/openclaw'),
    OPENCODE_LIVE: path.join(local, 'opencode'),
    OPENCODE_DURABLE: path.join(data, 'state/opencode'),
    HERMES_LIVE: path.join(local, 'hermes'),
    HERMES_DURABLE: path.join(data, 'state/hermes'),
    FX_LIVE: path.join(local, 'fx-home'),
    FX_DURABLE: path.join(data, 'state/fx'),
    ANTIGRAVITY_LIVE: path.join(local, 'antigravity-home'),
    ANTIGRAVITY_DURABLE: path.join(data, 'state/antigravity'),
    ...extra,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  fs.mkdirSync(env.HOME, { recursive: true });
  const run = (mode) => spawnSync('sh', [script, mode], { env, encoding: 'utf8' });
  const status = (adapter) => {
    try {
      return Object.fromEntries(fs.readFileSync(path.join(local, 'agent-state-status', adapter), 'utf8')
        .split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    } catch { return null; }
  };
  const logFile = env.AGENT_STATE_LOG || path.join(data, 'state/agent-state.log');
  const log = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const health = (aheadMs) => readCheckpointHealth({ dir: path.join(local, 'agent-state-status'), now: Date.now() + aheadMs });
  return { root, data, local, env, run, status, log, logFile, health };
}
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const tmpDirs = (dir) => spawnSync('find', [dir, '-name', '.~tmp~'], { encoding: 'utf8' }).stdout.trim();

test('one unreadable Claude file: the rest is saved, the failure is logged and reported, and it recovers', { skip: isRoot && 'root can read a chmod 000 file' }, () => {
  const w = world();
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  put(path.join(live, 'projects/a/one.jsonl'), 'one\n');
  put(path.join(live, 'projects/a/bad.jsonl'), 'bad\n');
  put(path.join(live, 'projects/b/two.jsonl'), 'two\n');
  put(path.join(live, 'settings.json'), '{}\n');
  put(path.join(w.env.CODEX_HOME, 'sessions/rollout.jsonl'), 'codex\n');
  fs.chmodSync(path.join(live, 'projects/a/bad.jsonl'), 0o000);

  const first = w.run('checkpoint');
  assert.notEqual(first.status, 0, 'a pass with a file it could not copy reports failure');
  // The other files of the same adapter are durable after this very pass.
  assert.equal(read(path.join(durable, 'projects/a/one.jsonl')), 'one\n');
  assert.equal(read(path.join(durable, 'projects/b/two.jsonl')), 'two\n');
  assert.equal(read(path.join(durable, 'settings.json')), '{}\n');
  assert.equal(read(path.join(durable, 'projects/a/bad.jsonl')), null);
  assert.equal(tmpDirs(durable), '', 'no temporary is left in the durable tree');

  // Another adapter is not affected at all.
  assert.equal(read(path.join(w.env.CODEX_DURABLE, 'sessions/rollout.jsonl')), 'codex\n');
  assert.equal(w.status('codex').failures, '0');
  assert.ok(Number(w.status('codex').last_success) > 0);

  // Reported: which adapter, rsync's exit code, the path, the reason.
  const st = w.status('claude');
  assert.equal(st.failures, '1');
  assert.equal(st.rc, '23');
  assert.equal(st.pending, '1');
  assert.equal(st.copied, '3');
  assert.match(st.paths, /projects\/a\/bad\.jsonl/);
  assert.match(st.reason, /Permission denied/);
  assert.ok(Number(st.failing_since) > 0);

  // Logged where a restart cannot lose it.
  const line = w.log().split('\n').find((l) => l.includes('claude: checkpoint FAILED'));
  assert.ok(line, `no failure in ${w.logFile}: ${w.log()}`);
  assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ checkpoint /);
  assert.match(line, /exit 23/);
  assert.match(line, /projects\/a\/bad\.jsonl/);
  assert.match(line, /Permission denied/);
  assert.doesNotMatch(w.log(), /codex/);

  // The stamp moved on: only the bad path is kept for another try, and a file
  // written later is saved by the next pass although that pass fails too.
  const retry = path.join(w.local, 'agent-state-stamps/claude.retry');
  assert.deepEqual(fs.readFileSync(retry, 'utf8').split('\0').filter(Boolean), ['./projects/a/bad.jsonl']);
  const stamp = fs.statSync(path.join(w.local, 'agent-state-stamps/claude')).mtimeMs;
  assert.ok(stamp > fs.statSync(path.join(live, 'projects/a/one.jsonl')).mtimeMs - 3000, 'the stamp advanced past the copied files');
  put(path.join(live, 'projects/b/three.jsonl'), 'three\n');
  fs.appendFileSync(path.join(live, 'projects/a/one.jsonl'), 'more\n');
  const second = w.run('checkpoint');
  assert.notEqual(second.status, 0);
  assert.equal(read(path.join(durable, 'projects/b/three.jsonl')), 'three\n');
  assert.equal(read(path.join(durable, 'projects/a/one.jsonl')), 'one\nmore\n', 'a file changed after its copy is copied again');
  assert.equal(w.status('claude').failures, '2');
  assert.equal(w.status('claude').failing_since, st.failing_since);
  // The same failure again is not a new log line every 15 seconds.
  assert.equal(w.log().split('\n').filter((l) => l.includes('checkpoint FAILED')).length, 1);

  // Once the file can be read, it is saved and the adapter is clean again.
  fs.chmodSync(path.join(live, 'projects/a/bad.jsonl'), 0o644);
  const third = w.run('checkpoint');
  assert.equal(third.status, 0, third.stderr);
  assert.equal(read(path.join(durable, 'projects/a/bad.jsonl')), 'bad\n');
  assert.equal(w.status('claude').failures, '0');
  assert.equal(fs.existsSync(retry), false);
  assert.match(w.log(), /claude: checkpoint recovered after 2 failed pass/);
});

test('a path the durable tree cannot take does not hold back the other files', () => {
  // The durable tree has a non-empty DIRECTORY where the live tree has a file.
  const w = world();
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  put(path.join(durable, 'projects/x/session.jsonl/keep'), 'in the way\n');
  put(path.join(live, 'projects/x/session.jsonl'), 'blocked\n');
  for (let i = 0; i < 40; i++) put(path.join(live, `projects/p${i % 7}/s${i}.jsonl`), `s${i}\n`);
  put(path.join(w.env.FX_LIVE, 'sessions/1/events.jsonl'), 'fx\n');

  const r = w.run('checkpoint');
  assert.notEqual(r.status, 0);
  for (let i = 0; i < 40; i++) assert.equal(read(path.join(durable, `projects/p${i % 7}/s${i}.jsonl`)), `s${i}\n`);
  assert.equal(read(path.join(w.env.FX_DURABLE, 'sessions/1/events.jsonl')), 'fx\n');
  const st = w.status('claude');
  assert.equal(st.pending, '1');
  assert.equal(st.copied, '40');
  assert.match(st.paths, /projects\/x\/session\.jsonl/);
  assert.equal(w.status('fx').failures, '0');
  assert.equal(read(path.join(durable, 'projects/x/session.jsonl/keep')), 'in the way\n', 'what is in the way is not touched');
  assert.match(w.log(), /claude: checkpoint FAILED.*projects\/x\/session\.jsonl/);

  // Fixed by hand, the next pass copies it.
  fs.rmSync(path.join(durable, 'projects/x'), { recursive: true });
  assert.equal(w.run('checkpoint').status, 0);
  assert.equal(read(path.join(durable, 'projects/x/session.jsonl')), 'blocked\n');
});

test('an rsync that dies before putting anything in place: found by halving, the rest is saved in the same pass', () => {
  // What the incident looked like from outside: every pass failed and nothing
  // of the adapter reached the durable tree. This rsync exits 12 at once, with
  // nothing copied, whenever its list names the poisoned path.
  const w = world();
  const bin = path.join(w.root, 'bin');
  const real = spawnSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).stdout.trim();
  put(path.join(bin, 'rsync'), `#!/bin/sh
for a in "$@"; do
  case "$a" in --files-from=*)
    if tr '\\0' '\\n' < "\${a#--files-from=}" | grep -q poison; then
      echo "rsync: connection unexpectedly closed (0 bytes received so far) [sender]" >&2
      echo "rsync error: error in rsync protocol data stream (code 12) at io.c(232) [sender=3.2.7]" >&2
      exit 12
    fi ;;
  esac
done
exec ${real} "$@"
`);
  fs.chmodSync(path.join(bin, 'rsync'), 0o755);
  w.env.PATH = `${bin}:${w.env.PATH}`;
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  for (let i = 0; i < 100; i++) put(path.join(live, `projects/p${i % 9}/s${i}.jsonl`), `s${i}\n`);
  put(path.join(live, 'projects/p4/poison.jsonl'), 'x\n');
  put(path.join(w.env.CODEX_HOME, 'history.jsonl'), 'ok\n');

  const r = w.run('checkpoint');
  assert.equal(r.status, 1);
  for (let i = 0; i < 100; i++) assert.equal(read(path.join(durable, `projects/p${i % 9}/s${i}.jsonl`)), `s${i}\n`);
  assert.equal(read(path.join(w.env.CODEX_DURABLE, 'history.jsonl')), 'ok\n');
  const st = w.status('claude');
  assert.equal(st.rc, '12');
  assert.equal(st.pending, '1');
  assert.equal(st.copied, '100');
  assert.equal(st.paths, 'projects/p4/poison.jsonl');
  assert.match(st.reason, /connection unexpectedly closed/);
  assert.match(w.log(), /claude: checkpoint FAILED.*exit 12.*poison\.jsonl.*connection unexpectedly closed.*code 12/);

  // The next pass costs one small rsync for the kept path, and new files go through.
  put(path.join(live, 'projects/p1/new.jsonl'), 'new\n');
  assert.equal(w.run('checkpoint').status, 1);
  assert.equal(read(path.join(durable, 'projects/p1/new.jsonl')), 'new\n');
  assert.equal(w.status('claude').pending, '1');

  // A pass has a bounded number of tries. Paths it could not tell apart are
  // not dropped and not called bad: they go back into the next pass.
  const w2 = world({ AGENT_STATE_RETRY_MAX: '4' });
  w2.env.PATH = `${bin}:${w2.env.PATH}`;
  for (let i = 0; i < 50; i++) put(path.join(w2.env.CLAUDE_CONFIG_DIR, `projects/poison/s${i}.jsonl`), 'x\n');
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(w2.run('checkpoint').status, 1);
    assert.equal(w2.status('claude').pending, '0');
    assert.equal(w2.status('claude').untested, '50');
    assert.equal(w2.status('claude').copied, '0');
  }
  // The path is gone (the session was deleted): nothing is left to retry.
  fs.rmSync(path.join(live, 'projects/p4/poison.jsonl'));
  assert.equal(w.run('checkpoint').status, 0);
  assert.equal(w.status('claude').failures, '0');
});

// An rsync in front of the real one, as a file in `dir` on PATH. `body` is sh
// run for every --files-from list, with $list set to it.
function fakeRsync(dir, body) {
  const real = spawnSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).stdout.trim();
  put(path.join(dir, 'rsync'), `#!/bin/sh
for a in "$@"; do
  case "$a" in --files-from=*) list="\${a#--files-from=}"
${body}
  ;; esac
done
exec ${real} "$@"
`);
  fs.chmodSync(path.join(dir, 'rsync'), 0o755);
}
const lines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\0').filter(Boolean); } catch { return []; } };

test('20 bad paths spread over 1000: every pass saves files, only paths that failed alone are called bad', () => {
  const w = world();
  const bin = path.join(w.root, 'bin');
  fakeRsync(bin, `    if tr '\\0' '\\n' < "$list" | grep -q poison; then
      echo "rsync: connection unexpectedly closed (0 bytes received so far) [sender]" >&2
      exit 12
    fi`);
  w.env.PATH = `${bin}:${w.env.PATH}`;
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  const name = (i) => `projects/p${String(Math.floor(i / 25)).padStart(2, '0')}/s${String(i).padStart(4, '0')}${i % 50 === 7 ? '.poison' : ''}.jsonl`;
  for (let i = 0; i < 1000; i++) put(path.join(live, name(i)), `s${i}\n`);
  const good = [...Array(1000).keys()].filter((i) => i % 50 !== 7);
  const saved = () => good.filter((i) => fs.existsSync(path.join(durable, name(i)))).length;
  const retry = path.join(w.local, 'agent-state-stamps/claude.retry');
  // One good file keeps changing, as a live transcript does.
  const busy = path.join(live, name(999));

  let before = 0, passes = 0;
  while (passes < 40) {
    passes++;
    fs.appendFileSync(busy, `pass ${passes}\n`);
    assert.equal(w.run('checkpoint').status, 1);
    const st = w.status('claude');
    for (const p of lines(retry)) assert.match(p, /poison/, `a good path was called bad: ${p}`);
    assert.doesNotMatch(st.paths, /s\d{4}\.jsonl/, 'only proven-bad paths are reported');
    const now = saved();
    if (st.untested === '0') break;
    assert.ok(now > before, `pass ${passes} saved nothing new (${now} of 980)`);
    before = now;
  }
  assert.equal(saved(), 980, `after ${passes} passes`);
  assert.equal(w.status('claude').pending, '20');
  assert.equal(w.status('claude').untested, '0');
  assert.equal(lines(retry).length, 20);
  // The file that kept changing is current, and still is after another change.
  assert.equal(read(path.join(durable, name(999))), read(busy));
  fs.appendFileSync(busy, 'later\n');
  assert.equal(w.run('checkpoint').status, 1);
  assert.equal(read(path.join(durable, name(999))), read(busy));
  // Proven-bad paths cost a pass a few small rsyncs, not the whole budget again.
  assert.equal(w.status('claude').pending, '20');
});

test('a checkpoint bigger than the time limit is saved batch by batch', () => {
  // This rsync takes 20 ms per listed path before it copies anything, and the
  // limit for one rsync is 5 s: 300 paths in one list can never finish.
  const slow = `    n=$(tr -cd '\\0' < "$list" | wc -c)
    sleep "$(awk -v n="$n" 'BEGIN { printf "%.2f", n * 0.02 }')"`;
  const files = (w) => { for (let i = 0; i < 300; i++) put(path.join(w.env.CLAUDE_CONFIG_DIR, `projects/p${i % 10}/s${i}.jsonl`), `s${i}\n`); };
  const saved = (w) => [...Array(300).keys()].filter((i) => fs.existsSync(path.join(w.env.CLAUDE_DURABLE, `projects/p${i % 10}/s${i}.jsonl`))).length;

  // In batches of 50 each rsync takes a second: one pass saves everything.
  const w = world({ AGENT_STATE_CHECKPOINT_TIMEOUT: '5', AGENT_STATE_BATCH_FILES: '50' });
  fakeRsync(path.join(w.root, 'bin'), slow);
  w.env.PATH = `${path.join(w.root, 'bin')}:${w.env.PATH}`;
  files(w);
  const r = w.run('checkpoint');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(saved(w), 300);

  // The byte cap cuts batches too: 20 files of 1 kB under a 4 kB cap.
  const wb = world({ AGENT_STATE_BATCH_BYTES: '4096' });
  const counts = path.join(wb.root, 'counts');
  fakeRsync(path.join(wb.root, 'bin'), `    tr -cd '\\0' < "$list" | wc -c >> ${counts}`);
  wb.env.PATH = `${path.join(wb.root, 'bin')}:${wb.env.PATH}`;
  for (let i = 0; i < 20; i++) put(path.join(wb.env.CLAUDE_CONFIG_DIR, `projects/a/s${i}.jsonl`), 'x'.repeat(1024));
  put(path.join(wb.env.CLAUDE_CONFIG_DIR, 'projects/a/big.jsonl'), 'x'.repeat(10_000));
  assert.equal(wb.run('checkpoint').status, 0);
  const sizes = fs.readFileSync(counts, 'utf8').trim().split('\n').map(Number);
  assert.ok(sizes.every((n) => n <= 4), `a batch went over the byte cap: ${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 21);
  assert.equal(read(path.join(wb.env.CLAUDE_DURABLE, 'projects/a/big.jsonl')).length, 10_000);

  // Even with one batch too big for the limit it gets there: the pass that
  // timed out is followed by one with batches half the size.
  const w2 = world({ AGENT_STATE_CHECKPOINT_TIMEOUT: '5', AGENT_STATE_BATCH_FILES: '1000' });
  fakeRsync(path.join(w2.root, 'bin'), slow);
  w2.env.PATH = `${path.join(w2.root, 'bin')}:${w2.env.PATH}`;
  files(w2);
  put(path.join(w2.env.FX_LIVE, 'sessions/1/events.jsonl'), 'fx\n');
  const first = w2.run('checkpoint');
  assert.equal(first.status, 1);
  assert.equal(saved(w2), 0);
  assert.equal(tmpDirs(w2.env.CLAUDE_DURABLE), '', 'nothing partial is visible');
  assert.equal(w2.status('claude').rc, '124');
  assert.equal(w2.status('claude').untested, '300');
  assert.equal(w2.status('claude').pending, '0');
  assert.match(w2.status('claude').reason, /did not finish within 5s/);
  assert.match(w2.log(), /claude: checkpoint FAILED.*exit 124/);
  assert.equal(read(path.join(w2.env.FX_DURABLE, 'sessions/1/events.jsonl')), 'fx\n', 'the adapters after it still ran');
  const second = w2.run('checkpoint');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(saved(w2), 300);
  assert.equal(w2.status('claude').failures, '0');
});

test('one path that hangs the copy is isolated, then retried only once in a while', () => {
  const w = world({ AGENT_STATE_CHECKPOINT_TIMEOUT: '2' });
  fakeRsync(path.join(w.root, 'bin'), `    if tr '\\0' '\\n' < "$list" | grep -q hang; then sleep 30; fi`);
  w.env.PATH = `${path.join(w.root, 'bin')}:${w.env.PATH}`;
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  for (let i = 0; i < 6; i++) put(path.join(live, `projects/a/s${i}.jsonl`), `s${i}\n`);
  put(path.join(live, 'projects/a/s3.hang.jsonl'), 'x\n');
  let passes = 0;
  do { assert.equal(w.run('checkpoint').status, 1); } while (++passes < 8 && w.status('claude').untested !== '0');
  for (let i = 0; i < 6; i++) assert.equal(read(path.join(durable, `projects/a/s${i}.jsonl`)), `s${i}\n`);
  assert.equal(w.status('claude').pending, '1');
  assert.equal(w.status('claude').paths, 'projects/a/s3.hang.jsonl');

  // The next passes do not wait out the limit again for it, and save new files.
  put(path.join(live, 'projects/a/new.jsonl'), 'new\n');
  const t0 = Date.now();
  assert.equal(w.run('checkpoint').status, 1);
  assert.ok(Date.now() - t0 < 1500, 'the hanging path was not tried again');
  assert.equal(read(path.join(durable, 'projects/a/new.jsonl')), 'new\n');
  assert.equal(w.status('claude').pending, '1');
  assert.match(w.status('claude').reason, /tried again every 3600s/);

  // It is tried again after the wait, and saved once it no longer hangs.
  w.env.AGENT_STATE_RETRY_SLOW_SECONDS = '0';
  fakeRsync(path.join(w.root, 'bin'), '    :');
  assert.equal(w.run('checkpoint').status, 0);
  assert.equal(read(path.join(durable, 'projects/a/s3.hang.jsonl')), 'x\n');
});

test('a failed file does not skip the SQLite backup of the same adapter', { skip: isRoot && 'root can read a chmod 000 file' }, () => {
  const w = world();
  const live = w.env.HERMES_LIVE;
  put(path.join(live, 'config.yaml'), 'a: 1\n');
  put(path.join(live, 'bad.txt'), 'x\n');
  fs.chmodSync(path.join(live, 'bad.txt'), 0o000);
  spawnSync('sqlite3', [path.join(live, 'state.db'), 'create table t(x); insert into t values (7);']);
  assert.notEqual(w.run('checkpoint').status, 0);
  const copy = path.join(w.env.HERMES_DURABLE, 'checkpoints/state.db');
  assert.equal(spawnSync('sqlite3', [copy, 'select x from t;'], { encoding: 'utf8' }).stdout.trim(), '7');
  assert.equal(w.status('hermes').failures, '1');
  assert.match(w.status('hermes').paths, /bad\.txt/);
});

test('the warning appears only after the threshold, also with no success since boot', { skip: isRoot && 'root can read a chmod 000 file' }, () => {
  const w = world();
  const live = w.env.CLAUDE_CONFIG_DIR;
  put(path.join(live, 'projects/a/bad.jsonl'), 'bad\n');
  put(path.join(w.env.CODEX_HOME, 'history.jsonl'), 'ok\n');
  fs.chmodSync(path.join(live, 'projects/a/bad.jsonl'), 0o000);
  assert.equal(w.health(0), null, 'no status yet: nothing to say');

  // Claude has never had a clean pass here: the clock starts at its first failure.
  assert.notEqual(w.run('checkpoint').status, 0);
  assert.equal(w.status('claude').last_success, '');
  assert.equal(w.health(0), null, 'one failed pass is not a warning');
  assert.equal(w.health(WARN_AFTER_MS - 30_000), null);
  const h = w.health(WARN_AFTER_MS + 30_000);
  assert.deepEqual(h.adapters.map((a) => a.adapter), ['claude'], 'only the failing adapter is named');
  assert.equal(h.adapters[0].lastSuccessAt, null);
  assert.equal(h.adapters[0].rc, 23);
  assert.equal(h.adapters[0].pending, 1);
  assert.match(h.adapters[0].reason, /Permission denied/);
  assert.match(h.adapters[0].paths, /projects\/a\/bad\.jsonl/);
  assert.match(h.log, /agent-state\.log$/);

  // After a clean pass and a later failure, it counts from the last success.
  fs.chmodSync(path.join(live, 'projects/a/bad.jsonl'), 0o644);
  assert.equal(w.run('checkpoint').status, 0);
  assert.equal(w.health(0), null);
  put(path.join(live, 'projects/a/bad2.jsonl'), 'bad\n');
  fs.chmodSync(path.join(live, 'projects/a/bad2.jsonl'), 0o000);
  assert.notEqual(w.run('checkpoint').status, 0);
  assert.ok(Number(w.status('claude').last_success) > 0);
  assert.equal(w.health(WARN_AFTER_MS - 30_000), null);
  assert.equal(w.health(WARN_AFTER_MS + 30_000).adapters[0].adapter, 'claude');
  assert.ok(w.health(WARN_AFTER_MS + 30_000).adapters[0].lastSuccessAt > 0);
  fs.chmodSync(path.join(live, 'projects/a/bad2.jsonl'), 0o644);
});

test('a checkpoint loop that stops finishing passes is reported', () => {
  const w = world();
  put(path.join(w.env.CODEX_HOME, 'history.jsonl'), 'ok\n');
  assert.equal(w.run('checkpoint').status, 0);
  assert.ok(Number(w.status('_pass').finished) > 0);
  assert.equal(w.health(WARN_AFTER_MS - 30_000), null);
  const h = w.health(WARN_AFTER_MS + 30_000);
  assert.deepEqual(h.adapters, []);
  assert.ok(h.stalled.lastPassAt > 0);
});

test('a log that cannot be written never fails or blocks a checkpoint', () => {
  const w = world();
  // The log's directory is a regular file, and one path cannot be copied.
  const notADir = path.join(w.root, 'not-a-dir');
  fs.mkdirSync(w.root, { recursive: true });
  fs.writeFileSync(notADir, '');
  w.env.AGENT_STATE_LOG = path.join(notADir, 'agent-state.log');
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  put(path.join(durable, 'projects/x/session.jsonl/keep'), 'in the way\n');
  put(path.join(live, 'projects/x/session.jsonl'), 'blocked\n');
  put(path.join(live, 'projects/y/session.jsonl'), 'fine\n');
  const t0 = Date.now();
  const r = w.run('checkpoint');
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 30_000);
  assert.equal(read(path.join(durable, 'projects/y/session.jsonl')), 'fine\n');
  assert.match(r.stderr, /claude: checkpoint FAILED/, 'still on the container log');
  assert.equal(w.status('claude').failures, '1');
});

test('the log keeps its history across a restart and rotates at its size cap', () => {
  const w = world({ AGENT_STATE_LOG_MAX: '600', AGENT_STATE_LOG_EVERY: '1' });
  const live = w.env.CLAUDE_CONFIG_DIR, durable = w.env.CLAUDE_DURABLE;
  put(w.logFile, '2026-11-12T00:00:00Z checkpoint from an earlier boot\n');
  put(path.join(durable, 'projects/x/session.jsonl/keep'), 'in the way\n');
  put(path.join(live, 'projects/x/session.jsonl'), 'blocked\n');
  assert.equal(w.run('checkpoint').status, 1);
  assert.match(w.log(), /from an earlier boot\n.*claude: checkpoint FAILED/s);
  for (let i = 0; i < 4; i++) assert.equal(w.run('checkpoint').status, 1);
  assert.ok(fs.existsSync(`${w.logFile}.1`), 'rotated');
  assert.ok(fs.statSync(w.logFile).size <= 1200);
  assert.match(fs.readFileSync(`${w.logFile}.1`, 'utf8') + w.log(), /pass 5 in a row/);
});

test("rsync's leftover .~tmp~ directories are never restored, and the prune removes them", () => {
  const w = world();
  const durable = w.env.CLAUDE_DURABLE;
  put(path.join(durable, 'sessions/1.json'), '{}\n');
  put(path.join(durable, 'sessions/.~tmp~/2.json'), 'partial');
  put(path.join(durable, 'file-history/abc/.~tmp~/x@v1'), 'partial');
  put(path.join(durable, '.~tmp~/settings.json'), 'partial');
  const r = w.run('restore');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(path.join(w.env.CLAUDE_CONFIG_DIR, 'sessions/1.json')), '{}\n');
  assert.equal(tmpDirs(w.env.CLAUDE_CONFIG_DIR), '');
  assert.ok(Number(w.status('_pass').finished) > 0, 'the restore starts the clock for the first pass');

  assert.equal(w.run('prune').status, 0);
  assert.equal(tmpDirs(durable), '');
  assert.equal(read(path.join(durable, 'sessions/1.json')), '{}\n');
});
