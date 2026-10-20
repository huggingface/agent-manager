// The updater against a Space repo that refuses plain-git binaries.
//
// HF's pre-receive hook scans every commit in the pushed range, not just the
// tip. #154 added docs/images/agent-manager.png as an ordinary blob and #178
// moved it to LFS — which fixes the working tree and not the history, so the
// old "clone upstream and force-push its history" updater is now refused on
// every Space, and the route's throw reached the operator as "Request failed."
//
// The fixture is that shape in miniature: an upstream whose HEAD is clean but
// whose history contains the plain binary, and an own repo whose hook rejects
// any pushed commit carrying a .png that is not an LFS pointer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { deployUpstreamTree, deployedFrom, exclusively, isBehind, upstreamShaFromMessage, deployMessage, UPSTREAM_MARKER } from '../src/update-deploy.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-update-deploy-'));
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'am', GIT_AUTHOR_EMAIL: 'am@test', GIT_COMMITTER_NAME: 'am', GIT_COMMITTER_EMAIL: 'am@test' };
const sh = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:'
  + '0'.repeat(64) + '\nsize 16\n';

// A hook that answers the way HF's does: look at every commit in the range,
// refuse a .png whose blob is not an LFS pointer.
const HOOK = `#!/bin/sh
while read old new ref; do
  if [ "$old" = "0000000000000000000000000000000000000000" ]; then range="$new"; else range="$old..$new"; fi
  for c in $(git rev-list $range); do
    for f in $(git ls-tree -r --name-only $c | grep '\\.png$' || true); do
      if ! git show "$c:$f" 2>/dev/null | head -1 | grep -q 'git-lfs.github.com'; then
        echo "Your push was rejected because it contains binary files - $f" >&2
        exit 1
      fi
    done
  done
done
exit 0
`;

function world(name) {
  const dir = path.join(root, name);
  const upstream = path.join(dir, 'upstream');
  const own = path.join(dir, 'own.git');
  fs.mkdirSync(upstream, { recursive: true });
  sh(['init', '--quiet', '--initial-branch=main', '.'], upstream);
  fs.writeFileSync(path.join(upstream, 'README.md'), 'v1\n');
  sh(['add', '.'], upstream); sh(['commit', '--quiet', '-m', 'first'], upstream);
  // #154: the plain binary, in history forever.
  fs.mkdirSync(path.join(upstream, 'docs', 'images'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'docs/images/agent-manager.png'), PNG);
  sh(['add', '.'], upstream); sh(['commit', '--quiet', '-m', 'add screenshot'], upstream);
  // #178: the same path, now a pointer. HEAD is clean; the history is not.
  fs.writeFileSync(path.join(upstream, 'docs/images/agent-manager.png'), POINTER);
  fs.writeFileSync(path.join(upstream, '.gitattributes'), '*.png filter=lfs diff=lfs merge=lfs -text\n');
  fs.writeFileSync(path.join(upstream, 'README.md'), 'v2\n');
  sh(['add', '.'], upstream); sh(['commit', '--quiet', '-m', 'move the screenshot to lfs'], upstream);
  const upstreamSha = sh(['rev-parse', 'HEAD'], upstream).trim();

  // The Space's own repo, seeded with an older tree, and guarded like HF's.
  sh(['init', '--quiet', '--bare', '--initial-branch=main', own], root);
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  sh(['init', '--quiet', '--initial-branch=main', '.'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'older\n');
  sh(['add', '.'], seed); sh(['commit', '--quiet', '-m', 'space as deployed'], seed);
  sh(['push', '--quiet', own, 'main'], seed);
  const ownSha = sh(['rev-parse', 'HEAD'], seed).trim();
  const hook = path.join(own, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, HOOK); fs.chmodSync(hook, 0o755);

  const calls = [];
  const git = (args, cwd) => new Promise((resolve, reject) => {
    calls.push(args.join(' '));
    // git-lfs needs a server, which a bare path remote is not. The transfer
    // itself is out of scope here; that it is attempted, and attempted BEFORE
    // the refs, is exactly what this fixture can prove.
    if (args[0] === 'lfs' && (args[1] === 'push' || args[1] === 'fetch')) return resolve('');
    execFile('git', args, { cwd, env: ENV, timeout: 120_000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(stdout)));
  });
  return { dir, upstream, own, upstreamSha, ownSha, calls, git,
    deploy: (overrides = {}) => deployUpstreamTree({ sourceUrl: upstream, branch: 'main', ownUrl: own,
      dir: path.join(dir, `clone-${calls.length}-${Math.random().toString(36).slice(2)}`), git, ...overrides }),
    ownHead: () => sh(['rev-parse', 'main'], own).trim(),
    ownFile: (f) => sh(['show', `main:${f}`], own),
    ownMessage: () => sh(['log', '-1', '--format=%B', 'main'], own) };
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the old approach is exactly what the Space refuses', () => {
  const w = world('old');
  const clone = path.join(w.dir, 'old-clone');
  sh(['clone', '--quiet', '--branch', 'main', w.upstream, clone], root);
  assert.throws(() => sh(['push', '--force', w.own, 'HEAD:main'], clone),
    /rejected because it contains binary files/,
    'if this ever stops failing the fixture no longer reproduces the bug');
  assert.equal(w.ownHead(), w.ownSha, 'and the Space is untouched');
});

test('deploying the tree puts upstream\'s files in place as one commit', async () => {
  const w = world('new');
  const result = await w.deploy();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.to, w.upstreamSha);
  assert.equal(result.from, w.ownSha);

  assert.equal(w.ownFile('README.md'), 'v2\n', "upstream's files, verbatim");
  assert.equal(w.ownFile('docs/images/agent-manager.png'), POINTER);
  // One commit, on top of what was there: a fast-forward, nothing historical
  // in the pushed range for the hook to object to.
  assert.equal(sh(['rev-list', '--count', 'main'], w.own).trim(), '2');
  assert.equal(sh(['rev-parse', 'main^'], w.own).trim(), w.ownSha);
  assert.equal(sh(['rev-parse', 'main^{tree}'], w.own).trim(),
    sh(['rev-parse', 'HEAD^{tree}'], w.upstream).trim(), 'the tree is upstream\'s, not a copy of it');
  assert.ok(!w.calls.some((c) => c.startsWith('push') && c.includes('--force')), 'and no --force was needed');
});

test('LFS objects are sent before the refs that need them', async () => {
  const w = world('lfs');
  await w.deploy();
  const fetched = w.calls.findIndex((c) => c === `lfs fetch upstream ${w.upstreamSha}`);
  const lfs = w.calls.findIndex((c) => c.startsWith('lfs push'));
  const push = w.calls.findIndex((c) => c.startsWith('push own'));
  // Nothing is checked out any more, so no smudge filter downloads them for us.
  assert.ok(fetched >= 0, `the tree's objects were never fetched from upstream: ${w.calls.join(' | ')}`);
  assert.ok(lfs >= 0, `no lfs push was attempted: ${w.calls.join(' | ')}`);
  assert.ok(fetched < lfs && lfs < push, 'a tree of pointers whose objects never arrived is a broken Space');
});

test('an LFS fetch that failed never reaches the ref push', async () => {
  const w = world('lfs-fetch');
  const calls = [];
  const result = await w.deploy({
    git: (args, cwd) => {
      calls.push(args.join(' '));
      if (args[0] === 'lfs' && args[1] === 'fetch') return Promise.reject(new Error('batch response: Repository not found'));
      return w.git(args, cwd);
    },
  });
  assert.deepEqual([result.ok, result.reason], [false, 'lfs-fetch-failed']);
  assert.ok(!calls.some((c) => c.startsWith('lfs push') || c.startsWith('push own')), calls.join(' | '));
  assert.equal(w.ownHead(), w.ownSha);
});

test('a pointer scan that failed never reaches the ref push', async () => {
  const w = world('lfs-scan');
  const calls = [];
  const result = await w.deploy({
    git: (args, cwd) => {
      calls.push(args.join(' '));
      // Only the scan fails. "No pointers" and "could not tell" are different
      // answers, and treating the second as the first pushes a tree of
      // pointers whose objects were never sent.
      if (args[0] === 'lfs' && args[1] === 'ls-files') return Promise.reject(new Error('git: lfs is not a git command'));
      return w.git(args, cwd);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lfs-scan-failed');
  assert.match(result.detail, /not a git command/);
  assert.ok(!calls.some((c) => c.startsWith('push own')), `the ref was pushed anyway: ${calls.join(' | ')}`);
  assert.equal(w.ownHead(), w.ownSha, 'and the Space is left as it was');
});

test('the deploy records which upstream commit it carried', async () => {
  const w = world('marker');
  await w.deploy();
  const message = w.ownMessage();
  assert.match(message, new RegExp(`${UPSTREAM_MARKER} ${w.upstreamSha}`));
  assert.equal(upstreamShaFromMessage(message), w.upstreamSha);
  assert.equal(upstreamShaFromMessage('an ordinary commit message'), null);
});

test('up to date is still up to date, before and after a tree deploy', async () => {
  const w = world('check');
  // Before: this Space was force-pushed upstream's history, so its own sha IS
  // upstream's and that comparison is the right one.
  assert.equal(isBehind({ ownSha: w.upstreamSha, latestSha: w.upstreamSha, deployed: null }), false);
  assert.equal(isBehind({ ownSha: w.ownSha, latestSha: w.upstreamSha, deployed: null }), true);

  await w.deploy();
  const deployed = upstreamShaFromMessage(w.ownMessage());
  const head = w.ownHead();
  assert.notEqual(head, w.upstreamSha, 'the deploy commit is this Space\'s own');
  // Without the marker the sha comparison would now say "behind" forever.
  assert.equal(isBehind({ ownSha: head, latestSha: w.upstreamSha, deployed: null }), true);
  assert.equal(isBehind({ ownSha: head, latestSha: w.upstreamSha, deployed }), false, 'with it, up to date');
  assert.equal(isBehind({ ownSha: head, latestSha: 'f'.repeat(40), deployed }), true, 'and behind when it is');
  assert.equal(isBehind({ ownSha: head, latestSha: w.upstreamSha.slice(0, 10), deployed }), false, 'short forms match');

  // And a second run finds nothing to do, by tree rather than by sha.
  const again = await w.deploy();
  assert.deepEqual({ ok: again.ok, upToDate: again.upToDate }, { ok: true, upToDate: true });
  assert.equal(sh(['rev-list', '--count', 'main'], w.own).trim(), '2', 'no empty commit was pushed');
});

test('an upstream commit with an identical tree is still recorded as deployed', async () => {
  const w = world('same-tree');
  const records = [];
  await w.deploy({ record: (upstream, ownSha) => records.push({ upstream, ownSha }) });
  assert.deepEqual(records, [{ upstream: w.upstreamSha, ownSha: w.ownHead() }]);

  // Upstream moves on without changing a single file — an empty commit is the
  // simplest shape of it; a revert of a revert is the one that happens.
  sh(['commit', '--quiet', '--allow-empty', '-m', 'release notes only'], w.upstream);
  const moved = sh(['rev-parse', 'HEAD'], w.upstream).trim();
  assert.notEqual(moved, w.upstreamSha);
  assert.equal(sh(['rev-parse', 'HEAD^{tree}'], w.upstream).trim(),
    sh(['rev-parse', `${w.upstreamSha}^{tree}`], w.upstream).trim(), 'same tree, new sha');

  // check offers the update, because the marker still names the old commit.
  assert.equal(isBehind({ ownSha: w.ownHead(), latestSha: moved, deployed: w.upstreamSha }), true);
  const again = await w.deploy({ record: (upstream, ownSha) => records.push({ upstream, ownSha }) });
  assert.equal(again.upToDate, true, 'there is nothing to push, and nothing is pushed');
  assert.equal(sh(['rev-list', '--count', 'main'], w.own).trim(), '2', 'no commit just to move a marker');

  // …and the deploy says so, so the next check stops offering it. Without
  // this the Space is permanently "behind" something it already runs.
  assert.deepEqual(records[1], { upstream: moved, ownSha: w.ownHead() });
  assert.equal(isBehind({ ownSha: w.ownHead(), latestSha: moved, deployed: records[1].upstream }), false);
});

test('a refused push is answered with its reason, not thrown', async () => {
  const w = world('refused');
  // A hook that refuses everything: the shape of any server-side rejection.
  fs.writeFileSync(path.join(w.own, 'hooks', 'pre-receive'),
    '#!/bin/sh\necho "Your push was rejected because it contains binary files - docs/images/agent-manager.png" >&2\nexit 1\n');
  fs.chmodSync(path.join(w.own, 'hooks', 'pre-receive'), 0o755);
  const result = await w.deploy();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'push-rejected');
  assert.match(result.detail, /rejected because it contains binary files/);
  assert.equal(w.ownHead(), w.ownSha, 'and the Space is left as it was');
});

test('an unreachable upstream is a reason too', async () => {
  const w = world('unreachable');
  const result = await w.deploy({ sourceUrl: path.join(root, 'no-such-repo') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream-unreachable');
  assert.ok(result.detail);
});

test('a token in git output never reaches the answer', async () => {
  const w = world('scrub');
  const token = 'hf_secret_value';
  const scrub = (text) => String(text).split(token).join('***');
  const result = await deployUpstreamTree({
    sourceUrl: path.join(root, 'no-such-repo'), branch: 'main', ownUrl: w.own,
    dir: path.join(w.dir, 'clone-scrub'),
    git: () => Promise.reject(new Error(scrub(`fatal: could not read https://user:${token}@example/x`))),
  });
  assert.equal(result.ok, false);
  assert.ok(!result.detail.includes(token), result.detail);
  assert.match(result.detail, /\*\*\*/);
});

test('the first deploy into an empty Space has no parent to stand on', async () => {
  const w = world('empty');
  sh(['update-ref', '-d', 'refs/heads/main'], w.own);
  const result = await w.deploy();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.from, null);
  assert.equal(sh(['rev-list', '--count', 'main'], w.own).trim(), '1');
  assert.equal(w.ownFile('README.md'), 'v2\n');
});

test('a Space that has a main but cannot be fetched is an error, never an orphan', async () => {
  // Today's failure: HF's git server dies fetching the Space into a repo that
  // holds GitHub's full history (`fatal: expected 'acknowledgments'`), and the
  // old code read that as "empty Space" and pushed a parentless commit, which
  // HF refused as `! [rejected] am-deploy -> main (fetch first)`.
  const w = world('own-fetch');
  const calls = [];
  const result = await w.deploy({
    git: (args, cwd) => {
      calls.push(args.join(' '));
      if (args[0] === 'fetch' && args.includes('own')) {
        return Promise.reject(new Error("fatal: expected 'acknowledgments'"));
      }
      return w.git(args, cwd);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'own-fetch-failed');
  assert.match(result.detail, /expected 'acknowledgments'/, 'git\'s own words reach the operator');
  assert.ok(!calls.some((c) => c.startsWith('commit-tree') || c.startsWith('push')), calls.join(' | '));
  assert.equal(w.ownHead(), w.ownSha, 'and the Space is left as it was');
});

test('an unreachable Space is not an empty one either', async () => {
  const w = world('own-unreachable');
  const result = await w.deploy({ ownUrl: path.join(root, 'no-such-space.git') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'own-unreachable');
  assert.ok(result.detail);
});

test('both sides are fetched shallowly into a fresh repo, and the push is a fast-forward', async () => {
  const w = world('shallow');
  // Give the Space real history, so depth 1 actually leaves something out.
  const seed = path.join(w.dir, 'seed');
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(seed, 'README.md'), `older ${n}\n`);
    sh(['commit', '--quiet', '-am', `space commit ${n}`], seed);
  }
  sh(['push', '--quiet', w.own, 'main'], seed);
  const before = w.ownHead();
  const dir = path.join(w.dir, 'shallow-work');
  const result = await w.deploy({ dir });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.from, before);

  // No clone, and both fetches at depth 1 — the Space's before upstream's.
  assert.ok(!w.calls.some((c) => c.startsWith('clone')), w.calls.join(' | '));
  const ownFetch = w.calls.findIndex((c) => c.startsWith('fetch') && c.includes(' own '));
  const upFetch = w.calls.findIndex((c) => c.startsWith('fetch') && c.includes(' upstream '));
  assert.ok(ownFetch >= 0 && upFetch > ownFetch, w.calls.join(' | '));
  assert.ok(w.calls[ownFetch].includes('--depth 1') && w.calls[upFetch].includes('--depth 1'));
  assert.equal(sh(['rev-list', '--count', '--all'], dir).trim(), '3',
    'the work repo holds the two tips and the deploy commit, nothing more');
  assert.ok(fs.existsSync(path.join(dir, '.git', 'shallow')));

  // On the Space: a fast-forward from what it had, carrying upstream's tree.
  assert.equal(sh(['rev-parse', 'main^'], w.own).trim(), before);
  assert.equal(sh(['merge-base', '--is-ancestor', before, 'main'], w.own), '');
  assert.equal(sh(['rev-list', '--count', 'main'], w.own).trim(), '5');
  assert.equal(sh(['rev-parse', 'main^{tree}'], w.own).trim(), sh(['rev-parse', 'HEAD^{tree}'], w.upstream).trim());
  assert.equal(w.ownFile('docs/images/agent-manager.png'), POINTER);

  // And the next run, also shallow, is the same-tree no-op.
  const records = [];
  const again = await w.deploy({ record: (upstream, ownSha) => records.push({ upstream, ownSha }) });
  assert.equal(again.upToDate, true);
  assert.deepEqual(records, [{ upstream: w.upstreamSha, ownSha: w.ownHead() }]);
});

test('the local record is believed only about the commit the Space is on', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), head = 'c'.repeat(40);
  const record = { upstream: B, ownSha: head };
  assert.equal(deployedFrom({ record, marker: A, ownSha: head }), B, 'it knows about the push that never happened');
  assert.equal(deployedFrom({ record, marker: A, ownSha: 'd'.repeat(40) }), A,
    'something else pushed since, so the record is about a tree that has gone');
  assert.equal(deployedFrom({ record: null, marker: A, ownSha: head }), A, 'a restored Space has only its history');
  assert.equal(deployedFrom({ record: null, marker: null, ownSha: head }), null);
});

test('one update at a time, and the latch is released however it ends', async () => {
  const state = { busy: false };
  let release;
  const first = exclusively(state, () => new Promise((r) => { release = r; }));
  assert.deepEqual(await exclusively(state, async () => ({ ok: true })), { ok: false, reason: 'busy' },
    'a second update while one is running is refused, not run beside it');
  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(state.busy, false);

  // The failure that jammed it: the temp directory could not be made, and the
  // throw went past the release. Anything that throws has to leave it clear.
  await assert.rejects(exclusively(state, () => { throw new Error('ENOSPC: no space left on device'); }), /ENOSPC/);
  assert.equal(state.busy, false, 'the next update would have answered busy for the life of the process');
  assert.deepEqual(await exclusively(state, async () => ({ ok: true, ran: true })), { ok: true, ran: true });
});

test('deployMessage says what it is, not only which sha', () => {
  const message = deployMessage('a'.repeat(40), 'main');
  assert.match(message, /^Deploy upstream main as one commit/);
  assert.match(message, /History is not copied/);
});
