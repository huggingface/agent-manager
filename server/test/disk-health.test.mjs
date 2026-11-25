// Local disk headroom warning (server/src/disk-health.js) and Proposal B
// guardrails: HF_HOME off local disk + boot-restore mirror cleanup & ENOSPC
// fallback in scripts/agent-state.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const entrypoint = path.join(repoRoot, 'entrypoint.sh');
const agentState = path.join(repoRoot, 'scripts/agent-state.sh');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'am-disk-health-'));
process.env.DATA_DIR = path.join(tmpBase, 'server-data');

const {
  GiB,
  DEFAULT_WARN_FREE_BYTES,
  warnThresholdBytes,
  configuredLimitBytes,
  evaluateDiskHealth,
  probeDiskHealth,
} = await import('../src/disk-health.js');
const { DEFAULT_EXCLUDE } = await import('../src/backup.js');

test('evaluateDiskHealth: healthy disks return null; statfs < 10 GiB warns', () => {
  assert.equal(DEFAULT_WARN_FREE_BYTES, 10 * GiB);
  assert.equal(
    evaluateDiskHealth({
      fsTotalBytes: 100 * GiB,
      fsFreeBytes: 25 * GiB,
    }),
    null,
  );

  const low = evaluateDiskHealth({
    fsTotalBytes: 50 * GiB,
    fsFreeBytes: 6.5 * GiB,
    now: 12345,
  });
  assert.ok(low);
  assert.equal(low.lowDisk, true);
  assert.equal(low.bootRisk, false);
  assert.equal(low.freeBytes, 6.5 * GiB);
  assert.equal(low.totalBytes, 50 * GiB);
  assert.equal(low.source, 'statfs');
  assert.equal(low.checkedAt, 12345);
});

test('evaluateDiskHealth: enforces HF_SPACE_DISK_GB quota over unquotaed host overlayfs without double-counting quotaed volumes', () => {
  // Unquotaed 1.5 TiB Kubernetes node NVMe with 300 GiB free, but Space pod
  // has HF_SPACE_DISK_GB=50 and has written 42.5 GiB to local disk -> 7.5 GiB left.
  const hit = evaluateDiskHealth({
    fsTotalBytes: 1500 * GiB,
    fsFreeBytes: 300 * GiB,
    quotaBytes: 50 * GiB,
    localUsedBytes: 42.5 * GiB,
    isSpace: true,
  });
  assert.ok(hit);
  assert.equal(hit.lowDisk, true);
  assert.equal(hit.source, 'space-quota');
  assert.equal(hit.totalBytes, 50 * GiB);
  assert.equal(hit.freeBytes, 7.5 * GiB);

  // Healthy under quota (12 GiB used of 50 GiB -> 38 GiB left).
  assert.equal(
    evaluateDiskHealth({
      fsTotalBytes: 1500 * GiB,
      fsFreeBytes: 300 * GiB,
      quotaBytes: 50 * GiB,
      localUsedBytes: 12 * GiB,
      adapterSizes: [4 * GiB, 2 * GiB],
      isSpace: true,
    }),
    null,
  );

  // Already-quotaed filesystem (fsTotalBytes == 50 GiB, 24 GiB free): must trust statfs.
  assert.equal(
    evaluateDiskHealth({
      fsTotalBytes: 50 * GiB,
      fsFreeBytes: 24 * GiB,
      quotaBytes: 50 * GiB,
      localUsedBytes: 26 * GiB,
      isSpace: true,
    }),
    null,
  );
});

test('evaluateDiskHealth: catches < 10 GiB next-boot restore headroom even while live free space is >= 10 GiB', () => {
  // Live usage is 26 GiB of 50 GiB (24 GiB currently free >= 10 GiB), but
  // claude=18 GiB + codex=8 GiB => state=26 GiB, restore peak=44 GiB => 6 GiB boot headroom.
  const risk = evaluateDiskHealth({
    fsTotalBytes: 1500 * GiB,
    fsFreeBytes: 300 * GiB,
    quotaBytes: 50 * GiB,
    localUsedBytes: 26 * GiB,
    adapterSizes: [18 * GiB, 8 * GiB],
    isSpace: true,
  });
  assert.ok(risk);
  assert.equal(risk.lowDisk, false);
  assert.equal(risk.bootRisk, true);
  assert.equal(risk.freeBytes, 24 * GiB);
  assert.equal(risk.stateBytes, 26 * GiB);
  assert.equal(risk.bootPeakBytes, 44 * GiB);
  assert.equal(risk.bootFreeBytes, 6 * GiB);

  // AM_DISK_WARN_BYTES=0 disables the warning.
  assert.equal(
    evaluateDiskHealth({
      fsTotalBytes: 50 * GiB,
      fsFreeBytes: 1 * GiB,
      warnFreeBytes: 0,
    }),
    null,
  );
});

test('probeDiskHealth: measures real directories, deduplicates nested local HOME, and scopes HF_SPACE_DISK_GB to SPACE_ID', async () => {
  assert.equal(configuredLimitBytes({ HF_SPACE_DISK_GB: '50' }), null, 'ignored without SPACE_ID');
  assert.equal(configuredLimitBytes({ SPACE_ID: 'u/s', HF_SPACE_DISK_GB: '50' }), 50 * GiB);
  assert.equal(warnThresholdBytes({ AM_DISK_WARN_BYTES: '0' }), 0);

  const root = fs.mkdtempSync(path.join(tmpBase, 'probe-'));
  const local = path.join(root, 'local');
  const tmp = path.join(root, 'tmp');
  const home = path.join(local, 'home'); // nested inside AM_LOCAL
  const durableHome = path.join(root, 'durable-home');
  const claude = path.join(local, 'agent-state/claude');
  const gitClone = path.join(local, 'git/repo');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(durableHome, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(gitClone, { recursive: true });

  // Write 2 MiB in claude state, 1 MiB in nested home, 3 MiB in local/git => ~6 MiB total.
  fs.writeFileSync(path.join(claude, 'a.jsonl'), Buffer.alloc(2 * 1024 * 1024, 0x61));
  fs.writeFileSync(path.join(home, '.bashrc'), Buffer.alloc(1 * 1024 * 1024, 0x62));
  fs.writeFileSync(path.join(gitClone, 'pack.bin'), Buffer.alloc(3 * 1024 * 1024, 0x63));

  const MiB = 1024 * 1024;
  const env = {
    SPACE_ID: 'org/am',
    AM_LOCAL: local,
    TMPDIR: tmp,
    HOME: home,
    AM_LIVE_HOME: home,
    AM_DURABLE_HOME: durableHome,
    AM_DISK_LIMIT_BYTES: String(10 * MiB),
    AM_DISK_WARN_BYTES: String(5 * MiB),
  };

  const res = await probeDiskHealth({
    env,
    statfs: async () => ({ blocks: 1000 * 256, bavail: 900 * 256, bsize: 4096, frsize: 4096 }), // 1000 MiB fake host fs
  });
  assert.ok(res, '6 MiB used of 10 MiB leaves ~4 MiB (< 5 MiB threshold)');
  assert.equal(res.lowDisk, true);
  assert.equal(res.source, 'space-quota');
  // Nested HOME inside AM_LOCAL must not be counted twice (~6 MiB, never ~7 MiB).
  assert.ok(res.usedBytes >= 5.8 * MiB && res.usedBytes <= 6.5 * MiB, `usedBytes=${res.usedBytes}`);
  assert.ok(res.stateBytes >= 2.8 * MiB && res.stateBytes <= 3.5 * MiB, `stateBytes=${res.stateBytes}`);
});

test('entrypoint.sh sets HF_HOME on DATA_DIR, preserves legacy tokens, and stays in NON_SECRET & DEFAULT_EXCLUDE', () => {
  assert.equal(spawnSync('sh', ['-n', entrypoint], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('sh', ['-n', agentState], { encoding: 'utf8' }).status, 0);
  assert.ok(DEFAULT_EXCLUDE.includes('cache/huggingface'), 'Hub cache on /data/cache/huggingface skipped by dataset backup');

  const idx = fs.readFileSync(path.join(repoRoot, 'server/src/index.js'), 'utf8');
  const ep = fs.readFileSync(entrypoint, 'utf8');
  const catalog = new Set([...idx.slice(idx.indexOf('const NON_SECRET = new Set(['), idx.indexOf(']);', idx.indexOf('const NON_SECRET = new Set(['))).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
  const exported = [...ep.matchAll(/^\s*export ([A-Z_]+)/gm)].map((m) => m[1]).filter((k) => k !== 'PATH' && !k.startsWith('AM_'));
  assert.deepEqual(exported.filter((k) => !catalog.has(k)), []);
  assert.ok(catalog.has('HF_HOME'));

  // Boot entrypoint.sh in a stub /app layout and verify HF_HOME + token carry-over.
  const root = fs.mkdtempSync(path.join(tmpBase, 'ep-'));
  const dataDir = path.join(root, 'data');
  const localDir = path.join(root, 'local');
  const appDir = path.join(root, 'app');
  const envOut = path.join(root, 'node-env.json');
  fs.mkdirSync(path.join(dataDir, 'home/.cache/huggingface'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'home/.cache/huggingface/token'), 'hf_legacy_token', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'home/.cache/huggingface/stored_tokens'), '{"default":"hf_legacy_token"}', { mode: 0o600 });
  fs.mkdirSync(path.join(appDir, 'server/src'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'server/src/index.js'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({ HF_HOME: process.env.HF_HOME })); process.exit(0);\n`,
  );
  fs.writeFileSync(path.join(appDir, 'server/package.json'), '{"type":"module"}\n');

  const epPatched = path.join(root, 'entrypoint-test.sh');
  fs.writeFileSync(
    epPatched,
    ep.replace(/\/home\/node\/local/g, localDir).replace(/\/app\/server\/src\/index\.js/g, path.join(appDir, 'server/src/index.js')),
  );

  const runBoot = (extraEnv = {}) => spawnSync('sh', [epPatched], {
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      TMPDIR: root,
      DATA_DIR: dataDir,
      AGENT_STATE_SCRIPT: agentState,
      AGENT_STATE_CHECKPOINT_SECONDS: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });

  const r1 = runBoot();
  assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
  const captured = JSON.parse(fs.readFileSync(envOut, 'utf8'));
  assert.equal(captured.HF_HOME, path.join(dataDir, 'cache/huggingface'));
  assert.equal(fs.readFileSync(path.join(captured.HF_HOME, 'token'), 'utf8'), 'hf_legacy_token');
  assert.equal(fs.readFileSync(path.join(captured.HF_HOME, 'stored_tokens'), 'utf8'), '{"default":"hf_legacy_token"}');

  // Re-booting after a newer token was saved in HF_HOME must not overwrite it.
  fs.writeFileSync(path.join(captured.HF_HOME, 'token'), 'hf_newer_token');
  const r2 = runBoot();
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(path.join(captured.HF_HOME, 'token'), 'utf8'), 'hf_newer_token');
});

test('agent-state.sh restore isolates HF_XET_CACHE off HF_HOME, deletes per-adapter mirrors early, and skips retry on ENOSPC', () => {
  const root = fs.mkdtempSync(path.join(tmpBase, 'restore-'));
  const data = path.join(root, 'durable');
  const local = path.join(root, 'local');
  const hfHome = path.join(data, 'cache/huggingface');
  const bin = path.join(root, 'bin');
  const logFile = path.join(root, 'hf-calls.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(hfHome, { recursive: true });
  fs.mkdirSync(path.join(data, 'state/codex/sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'state/codex/sessions/r1.jsonl'), '{"ok":1}\n');
  fs.mkdirSync(path.join(data, 'state/claude/projects/p1'), { recursive: true });
  fs.writeFileSync(path.join(data, 'state/claude/projects/p1/c1.jsonl'), '{"ok":2}\n');

  // Fake `hf` CLI:
  // - records HF_XET_CACHE on every invocation
  // - for `claude`, simulates ENOSPC ("No space left on device") so mirror_tree
  //   must NOT burn a second attempt and must fall straight back to $DATA_DIR
  // - for all other adapters, simulates a working bucket plan + download
  fs.writeFileSync(path.join(bin, 'hf'), `#!/usr/bin/env python3
import json, os, shutil, sys

log_path = ${JSON.stringify(logFile)}
data_dir = ${JSON.stringify(data)}
args = sys.argv[1:]
with open(log_path, "a") as f:
    f.write(json.dumps({"args": args, "xet": os.environ.get("HF_XET_CACHE", "")}) + "\\n")

if args[:2] == ["buckets", "list"]:
    sys.exit(0)

if args[:2] == ["buckets", "sync"] and "--plan" in args:
    src = args[2]  # hf://buckets/owner/bkt/state/<adapter>
    mirror = args[3]
    plan_file = args[args.index("--plan") + 1]
    rel = src.split("hf://buckets/owner/bkt/", 1)[1]
    if rel == "state/claude":
        sys.stderr.write("Error: Os { code: 28, kind: StorageFull, message: \\"No space left on device\\" }\\n")
        sys.exit(1)
    durable_src = os.path.join(data_dir, rel)
    ops = []
    if os.path.isdir(durable_src):
        for root_d, _, files in os.walk(durable_src):
            for name in files:
                full = os.path.join(root_d, name)
                sub = os.path.relpath(full, durable_src)
                ops.append({"type": "operation", "action": "download", "path": sub, "src": full, "mirror": mirror, "remote_mtime": "2026-11-20T12:00:00Z"})
    with open(plan_file, "w") as pf:
        for op in ops:
            pf.write(json.dumps(op) + "\\n")
    sys.exit(0)

if args[:2] == ["buckets", "sync"] and "--apply" in args:
    plan_file = args[args.index("--apply") + 1]
    for line in open(plan_file):
        op = json.loads(line)
        dst = os.path.join(op["mirror"], op["path"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(op["src"], dst)
    sys.exit(0)

sys.exit(0)
`, { mode: 0o755 });

  const r = spawnSync('sh', [agentState, 'restore'], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      LANG: 'C.UTF-8',
      TMPDIR: root,
      HOME: path.join(root, 'home'),
      HF_HOME: hfHome,
      DATA_DIR: data,
      AM_LOCAL: local,
      AGENT_STATE_BUCKET: 'owner/bkt',
      AGENT_STATE_FROM_ENTRYPOINT: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  // Both codex (via API mirror) and claude (via ENOSPC fallback to DATA_DIR) restored cleanly.
  assert.equal(fs.readFileSync(path.join(local, 'codex-home/sessions/r1.jsonl'), 'utf8'), '{"ok":1}\n');
  assert.equal(fs.readFileSync(path.join(local, 'agent-state/claude/projects/p1/c1.jsonl'), 'utf8'), '{"ok":2}\n');

  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const syncPlans = calls.filter((c) => c.args[0] === 'buckets' && c.args[1] === 'sync' && c.args.includes('--plan'));
  const claudePlans = syncPlans.filter((c) => c.args[2].endsWith('/state/claude'));
  assert.equal(claudePlans.length, 1, 'ENOSPC on try1 must skip try2 and fall straight back to DATA_DIR');

  // Every sync call isolated HF_XET_CACHE inside local mirror scratch, never HF_HOME on DATA_DIR.
  for (const c of syncPlans) {
    assert.ok(c.xet.startsWith(path.join(local, 'agent-state-mirror/.xet-cache/')), `unexpected HF_XET_CACHE: ${c.xet}`);
  }
  assert.equal(fs.existsSync(path.join(hfHome, 'xet')), false, 'no Xet cache written into FUSE HF_HOME');
  assert.equal(fs.existsSync(path.join(local, 'agent-state-mirror')), false, 'mirror root fully cleaned up');
});
