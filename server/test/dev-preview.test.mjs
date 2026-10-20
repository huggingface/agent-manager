// Dev preview switching against a local bare repository standing in for GitHub
// (and a stubbed GitHub API): validation, open-PR binding, merge order,
// conflicts, full-rebuild detection, the one-link swap and its failure paths,
// rollback, credential filtering of build output, and the re-apply of a
// persisted selection after a container restart. npm installs and the web
// build run for real, against fixture packages with no dependencies and a stub
// `vite` preloaded in the node_modules cache, so the suite needs no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createDevPreview, validateSelection, lockKey, REBUILD_FILES, SWAPPED, DEV_PREVIEW_REPO, describe, headRefusal, permissionAllows,
} from '../src/dev-preview.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const MODULE = path.join(HERE, '..', 'src', 'dev-preview.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dev-preview-'));
const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C.UTF-8' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');
const API = `https://api.github.com/repos/${DEV_PREVIEW_REPO}`;

// ------------------------------------------------------------ fixture "GitHub"
const pkg = (name, version, extra = {}) => JSON.stringify({ name, version, ...extra }, null, 2);
const lock = (name, version) => JSON.stringify({ name, version, lockfileVersion: 3, requires: true, packages: { '': { name, version } } }, null, 2);
const MAIN = {
  'server/src/dev-preview.js': '// the switcher\n',
  'server/src/index.js': 'export const v = "main";\n',
  'server/package.json': pkg('fx-server', '1.0.0'),
  'server/package-lock.json': lock('fx-server', '1.0.0'),
  'scripts/hello.sh': 'echo hi\n',
  'scripts/am-codex-repin-hook.sh': '#!/bin/sh\n',
  'web/package.json': pkg('fx-web', '1.0.0', { devDependencies: { playwright: '1.0.0' } }),
  'web/package-lock.json': lock('fx-web', '1.0.0'),
  'web/marker.txt': 'main\n',
  'session.bashrc': '# rc\n',
  Dockerfile: 'FROM scratch\n',
  '.dockerignore': '**/node_modules\n',
  'entrypoint.sh': '#!/bin/sh\n',
  'codex-requirements.toml': '# req\n',
  'gemini-system-defaults.json': '{}\n',
};

function makeOrigin(name, mainFiles) {
  const origin = path.join(root, `${name}.git`);
  const work = path.join(root, `${name}-work`);
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(root, 'init', '-q', work);
  for (const [f, t] of Object.entries(mainFiles)) write(path.join(work, f), t);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'main');
  git(work, 'push', '-q', origin, 'HEAD:refs/heads/main');
  const mainSha = git(work, 'rev-parse', 'HEAD');
  const shas = {};
  const pr = (n, change) => {
    git(work, 'checkout', '-q', '--detach', mainSha);
    change(work);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', `pr ${n}`);
    git(work, 'push', '-q', '-f', origin, `HEAD:refs/pull/${n}/head`);
    shas[n] = git(work, 'rev-parse', 'HEAD');
  };
  return { origin, work, mainSha, shas, pr };
}

const gh = makeOrigin('origin', MAIN);
const { origin, work, mainSha: MAIN_SHA, shas: prSha } = gh;
gh.pr(1, (w) => { write(path.join(w, 'web/marker.txt'), 'pr1\n'); write(path.join(w, 'server/src/index.js'), 'export const v = "pr1";\n'); });
gh.pr(2, (w) => { write(path.join(w, 'scripts/two.sh'), 'echo two\n'); write(path.join(w, 'web/other.txt'), 'two\n'); });
gh.pr(3, (w) => write(path.join(w, 'server/src/index.js'), 'export const v = "pr3";\n'));
gh.pr(4, (w) => write(path.join(w, 'Dockerfile'), 'FROM debian\n'));
gh.pr(5, (w) => fs.rmSync(path.join(w, 'server/src/dev-preview.js')));
gh.pr(6, (w) => { write(path.join(w, 'server/package.json'), pkg('fx-server', '1.0.1')); write(path.join(w, 'server/package-lock.json'), lock('fx-server', '1.0.1')); });
gh.pr(7, (w) => write(path.join(w, 'web/package.json'), pkg('fx-web', '1.0.0', { devDependencies: { playwright: '2.0.0' } })));
gh.pr(8, (w) => write(path.join(w, 'entrypoint.sh'), '#!/bin/sh\necho changed\n'));
// A PR whose build tries to print the parent process's environment.
gh.pr(9, (w) => write(path.join(w, 'web/leak.js'), `
  const fs = require('fs');
  let out = '';
  try { out = fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8').split('\\0').join('\\n'); } catch (e) { out = 'no environ: ' + e.message; }
  process.stderr.write('LEAK-ATTEMPT\\n' + out + '\\n');
  process.exit(1);
`));
gh.pr(10, (w) => write(path.join(w, 'web/marker.txt'), 'closed pr\n'));

// The GitHub API as the fixture origin answers it right now. `closed` lists
// PRs the API reports as closed although their refs/pull/N/head still exist;
// `as` overrides what GitHub says about a PR's author and branch; `perms` is
// each login's current permission on the repo, and a login in `permFails`
// makes that lookup fail the way a rate limit or an outage would.
const closed = new Set([10]);
const as = new Map();
const perms = new Map();
const permFails = new Set();
const ghPr = (n, head) => {
  const o = as.get(n) || {};
  return {
    number: n, state: closed.has(n) ? 'closed' : 'open', title: `PR ${n}`, user: { login: 'member-dev' },
    base: { repo: { full_name: DEV_PREVIEW_REPO } }, ...o,
    head: { sha: head, repo: { full_name: DEV_PREVIEW_REPO, owner: { login: 'huggingface' } }, ...(o.head || {}) },
  };
};
const permissionOf = (login) => {
  if (permFails.has(login)) throw new Error('GitHub answered 403');
  const role = perms.get(login) ?? (login === 'member-dev' ? 'write' : 'read');
  // the legacy field folds maintain into write and triage into read
  return { role_name: role, permission: { maintain: 'write', triage: 'read' }[role] ?? role, user: { login } };
};
const refOf = (o, ref) => {
  const line = git(root, 'ls-remote', o, ref);
  return line ? line.split('\t')[0] : null;
};
const fixtureApi = (o = origin) => async (url) => {
  if (url === `${API}/branches/main`) return { name: 'main', commit: { sha: refOf(o, 'refs/heads/main') } };
  const m = url.match(/\/pulls\/(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    const head = refOf(o, `refs/pull/${n}/head`);
    if (!head) throw Object.assign(new Error('not found'), { notFound: true });
    return ghPr(n, head);
  }
  const c = url.match(/\/collaborators\/([^/]+)\/permission$/);
  if (c) return permissionOf(decodeURIComponent(c[1]));
  if (url.startsWith(`${API}/pulls?`)) {
    const out = [];
    for (const k of [1, 2, 3, 9, 10]) { const head = refOf(o, `refs/pull/${k}/head`); if (head) out.push(ghPr(k, head)); }
    return out.filter((p) => p.state === 'open');
  }
  throw new Error(`unexpected API call ${url}`);
};

// ------------------------------------------------------------ fixture image + instance
// entrypoint.sh's own layout step, run against a fixture dir instead of /app.
const ENTRYPOINT = read(path.join(REPO_ROOT, 'entrypoint.sh'));
const PREPARE = ENTRYPOINT.slice(ENTRYPOINT.indexOf('prepare_dev_preview_layout() {'), ENTRYPOINT.indexOf('\n}\n', ENTRYPOINT.indexOf('prepare_dev_preview_layout() {')) + 3);
const prepareLayout = (appDir) => execFileSync('sh', ['-c', `${PREPARE.replaceAll('/app', appDir)}\nprepare_dev_preview_layout`], { env: { PATH: process.env.PATH } });
let n = 0;
function makeImage({ imageInputs = MAIN, layout = true } = {}) {
  const dir = path.join(root, `inst-${++n}`);
  const appDir = path.join(dir, 'app');
  const localDir = path.join(dir, 'local');
  // What the Dockerfile leaves in /app.
  write(path.join(appDir, 'server/src/index.js'), 'export const v = "image";\n');
  write(path.join(appDir, 'server/package.json'), MAIN['server/package.json']);
  write(path.join(appDir, 'server/package-lock.json'), MAIN['server/package-lock.json']);
  write(path.join(appDir, 'server/node_modules/.image-modules'), 'image\n');
  write(path.join(appDir, 'scripts/hello.sh'), 'echo image\n');
  write(path.join(appDir, 'public/index.html'), 'image ui');
  write(path.join(appDir, 'session.bashrc'), '# image rc\n');
  for (const f of [...REBUILD_FILES, 'web/package.json', 'web/package-lock.json']) {
    if (imageInputs[f] !== undefined) write(path.join(appDir, '.image-inputs', f), imageInputs[f]);
  }
  // The web deps of main, already installed: a stub vite that "builds" by
  // writing which tree it saw, and runs a PR's leak.js if there is one.
  const webSrc = path.join(dir, 'websrc');
  write(path.join(webSrc, 'package.json'), MAIN['web/package.json']);
  write(path.join(webSrc, 'package-lock.json'), MAIN['web/package-lock.json']);
  const cache = path.join(localDir, 'node_modules-cache', `web-${lockKey(webSrc)}`);
  write(path.join(cache, 'package-lock.json'), MAIN['web/package-lock.json']);
  const vite = path.join(cache, 'node_modules', 'vite');
  write(path.join(vite, 'package.json'), '{"type":"commonjs"}');
  write(path.join(vite, 'bin/vite.js'), `
    const fs = require('fs');
    if (fs.existsSync('leak.js')) require(require('path').resolve('leak.js'));
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.html', 'built:' + fs.readFileSync('marker.txt', 'utf8').trim() + (fs.existsSync('other.txt') ? '+other' : ''));
  `);
  if (layout) prepareLayout(appDir);
  return { appDir, localDir };
}
/** A server process on these dirs. Called again with the same dirs = after its restart. */
function server({ appDir, localDir, stateFile, faults = null, api = fixtureApi(), remote = origin }) {
  const restarts = [];
  const audits = [];
  const dp = createDevPreview({
    appDir, localDir, stateFile, supervised: true,
    restart: () => restarts.push(Date.now()),
    audit: (e) => audits.push(e),
    testRemote: `file://${remote}`,
    env: { PATH: process.env.PATH },
    fetchJson: api,
    fault: (point) => { if (faults && faults.has(point)) { faults.delete(point); throw new Error(`injected fault at ${point}`); } },
  });
  return { dp, appDir, localDir, stateFile, restarts, audits };
}
function instance(opts = {}) {
  const { stateFile = path.join(root, `state-${++n}.json`), imageInputs, layout, ...rest } = opts;
  return server({ ...makeImage({ imageInputs, layout }), stateFile, ...rest });
}
const restarted = (i, extra = {}) => server({ appDir: i.appDir, localDir: i.localDir, stateFile: i.stateFile, ...extra });
const settle = (i) => i.dp._wait();
const waitRestart = async (i, count) => { for (let t = 0; t < 100 && i.restarts.length < count; t++) await new Promise((r) => setTimeout(r, 20)); };
const imageContent = (appDir) => ({
  server: read(path.join(appDir, 'server/src/index.js')),
  scripts: read(path.join(appDir, 'scripts/hello.sh')),
  public: read(path.join(appDir, 'public/index.html')),
  rc: read(path.join(appDir, 'session.bashrc')),
});
const IMAGE = { server: 'export const v = "image";\n', scripts: 'echo image\n', public: 'image ui', rc: '# image rc\n' };

// ------------------------------------------------------------ validation

test('selection validation accepts only PR numbers and full SHAs', () => {
  assert.deepEqual(validateSelection({ prs: [{ number: 182 }] }), [{ number: 182 }]);
  assert.deepEqual(validateSelection({ prs: [{ number: 1, sha: 'a'.repeat(40) }, { number: 2 }] }), [{ number: 1, sha: 'a'.repeat(40) }, { number: 2 }]);
  const refused = [
    null, [], {}, { prs: [] }, { prs: 'x' },
    { prs: [{ number: '182' }] }, { prs: [{ number: 0 }] }, { prs: [{ number: -1 }] }, { prs: [{ number: 1.5 }] },
    { prs: [{ number: 10_000_000 }] }, { prs: [{ number: '1; rm -rf /' }] }, { prs: [182] },
    { prs: [{ number: 1, sha: 'abc123' }] }, { prs: [{ number: 1, sha: 'A'.repeat(40) }] },
    { prs: [{ number: 1, sha: `${'a'.repeat(39)};` }] }, { prs: [{ number: 1, sha: '--upload-pack=x' }] },
    { prs: [{ number: 1 }, { number: 1 }] },
    { prs: Array.from({ length: 7 }, (_, i) => ({ number: i + 1 })) },
    // Nothing can name another repository, ref or URL.
    { prs: [{ number: 1 }], repo: 'evil/fork' }, { prs: [{ number: 1, repo: 'evil/fork' }] },
    { prs: [{ number: 1, ref: 'refs/heads/x' }] }, { prs: [{ number: 1 }], remote: 'https://example.com/x.git' },
  ];
  for (const body of refused) assert.throws(() => validateSelection(body), /must|unknown|twice/, JSON.stringify(body));
});

test('the repository is a constant: production passes no remote, and only file:// test remotes are accepted', () => {
  assert.equal(DEV_PREVIEW_REPO, 'huggingface/agent-manager');
  const src = read(MODULE);
  assert.match(src, /const REPO_URL = `https:\/\/github\.com\/\$\{DEV_PREVIEW_REPO\}\.git`/);
  const index = read(path.join(REPO_ROOT, 'server/src/index.js'));
  const call = index.slice(index.indexOf('createDevPreview({'), index.indexOf('}) : null;'));
  assert.ok(call.length > 0);
  assert.doesNotMatch(call, /testRemote|remote:|REPO|github|fetchJson|fault/);
  for (const bad of ['https://github.com/evil/fork.git', 'git@github.com:evil/fork.git', '/tmp/x', 'ext::sh -c x']) {
    assert.throws(() => createDevPreview({ appDir: root, localDir: root, stateFile: path.join(root, 'x'), testRemote: bad }), /file:\/\//);
  }
});

test('every Dockerfile COPY source is either swapped in place or a full-rebuild input', () => {
  const docker = read(path.join(REPO_ROOT, 'Dockerfile'));
  const covered = (src) => {
    const top = src.replace(/\/$/, '').split('/')[0];
    if (SWAPPED.includes(top) && top !== 'scripts') return true;          // server/, session.bashrc
    if (src === 'scripts/') return true;                                   // swapped as a whole
    if (REBUILD_FILES.includes(src)) return true;
    if (src === 'web/') return true;                                       // built into public/
    if (src === 'web/package.json' || src === 'web/package-lock.json') return true; // pin check + npm ci
    return false;
  };
  const sources = [];
  for (const line of docker.split('\n')) {
    const m = line.match(/^COPY\s+(.*)$/);
    if (!m || /--from=/.test(m[1])) continue;
    const parts = m[1].split(/\s+/).filter((p) => !p.startsWith('--'));
    sources.push(...parts.slice(0, -1));
  }
  assert.ok(sources.length > 5, 'parsed the COPY lines');
  for (const src of sources) assert.ok(covered(src), `Dockerfile COPY ${src} is neither swapped nor in REBUILD_FILES`);
});

// ------------------------------------------------------------ switching

test('switch to one PR: bound to the API head, merged onto main, built, swapped by one link, persisted, restarted', async () => {
  const i = instance();
  assert.equal(i.dp.running().kind, 'main');
  i.dp.switchTo({ prs: [{ number: 1 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.deepEqual(s.job.steps.map((x) => x.name), ['resolve', 'fetch', 'merge', 'check', 'export', 'dependencies', 'build web', 'assemble', 'swap']);
  // the image is kept whole for rollback; the four paths go through one link
  assert.equal(read(path.join(i.appDir, '.image/public/index.html')), 'image ui');
  for (const name of SWAPPED) assert.equal(fs.readlinkSync(path.join(i.appDir, name)), path.join('current', name), name);
  assert.equal(fs.readlinkSync(path.join(i.appDir, 'current')), path.join(i.localDir, 'releases', s.next.id));
  assert.equal(read(path.join(i.appDir, 'public/index.html')), 'built:pr1');
  assert.equal(read(path.join(i.appDir, 'server/src/index.js')), 'export const v = "pr1";\n');
  // lockfile unchanged → the image's node_modules, no install
  assert.equal(fs.realpathSync(path.join(i.appDir, 'server/node_modules')), fs.realpathSync(path.join(i.appDir, '.image/server/node_modules')));
  assert.match(i.dp.status().log.join('\n'), /lockfile matches the image/);
  assert.match(i.dp.status().log.join('\n'), /web: lockfile [0-9a-f]+ cached, no install/);
  // This process still runs the image: it says so, and that a restart is due.
  assert.equal(s.running.kind, 'main');
  assert.equal(s.restartPending, true);
  assert.deepEqual(s.next.prs.map(({ number, sha }) => ({ number, sha })), [{ number: 1, sha: prSha[1] }]);
  assert.equal(s.next.base, MAIN_SHA);
  assert.deepEqual(JSON.parse(read(i.stateFile)).prs.map(({ number, sha }) => ({ number, sha })), [{ number: 1, sha: prSha[1] }]);
  assert.equal(i.audits.at(-1).event, 'switch');
  assert.equal(i.audits.at(-1).ok, true);
  await waitRestart(i, 1);
  assert.equal(i.restarts.length, 1);
  // The restarted server is the one that claims the release.
  const after = restarted(i);
  assert.equal(after.dp.running().kind, 'prs');
  assert.equal(describe(after.dp.running()), `#1 ${prSha[1].slice(0, 7)}`);
  assert.equal(after.dp.summary().restartPending, false);
  assert.equal(after.dp.boot(), null, 'nothing to re-apply');
});

test('a stack of two is merged onto main in the order given; rollback returns to the image', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 2 }, { number: 1, sha: prSha[1] }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.equal(read(path.join(i.appDir, 'public/index.html')), 'built:pr1+other');
  assert.equal(read(path.join(i.appDir, 'scripts/two.sh')), 'echo two\n');
  const repo = i.dp._paths.repoDir;
  assert.match(git(repo, 'log', '-1', '--format=%s', s.next.merged), /preview: merge #1 /);
  assert.match(git(repo, 'log', '-1', '--format=%s', `${s.next.merged}^1`), /preview: merge #2 /);
  await waitRestart(i, 1);

  const up = restarted(i);
  assert.deepEqual(up.dp.running().prs.map((p) => p.number), [2, 1]);
  up.dp.rollback();
  const r = await settle(up);
  assert.equal(r.job.state, 'done');
  assert.equal(r.restartPending, true);
  assert.equal(r.next.kind, 'main');
  assert.deepEqual(imageContent(up.appDir), IMAGE);
  assert.deepEqual(JSON.parse(read(up.stateFile)).prs, []);
  await waitRestart(up, 1);
  assert.equal(up.restarts.length, 1);
  assert.equal(up.audits.at(-1).event, 'rollback');
  assert.equal(restarted(up).dp.running().kind, 'main');
});

test('a merge conflict stops the switch, names the files, and leaves the running build alone', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 1 }, { number: 3 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.deepEqual(s.job.conflict, { pr: 3, onto: 'main + #1', files: ['server/src/index.js'] });
  assert.match(s.job.error, /#3 conflicts with main \+ #1 in server\/src\/index\.js/);
  assert.equal(s.restartPending, false);
  assert.deepEqual(imageContent(i.appDir), IMAGE);
  assert.equal(fs.existsSync(i.stateFile), false, 'selection not persisted');
  assert.equal(i.restarts.length, 0);
  assert.equal(i.audits.at(-1).ok, false);
  // a clean switch right after works
  i.dp.switchTo({ prs: [{ number: 3 }] });
  assert.equal((await settle(i)).job.state, 'done');
});

test('selections whose image build inputs differ from the running image are refused with the files', async () => {
  for (const [pr, file] of [[4, 'Dockerfile'], [8, 'entrypoint.sh'], [7, 'web/package.json (playwright pin)']]) {
    const i = instance();
    i.dp.switchTo({ prs: [{ number: 2 }, { number: pr }] });
    const s = await settle(i);
    assert.equal(s.job.state, 'refused', `#${pr}`);
    assert.match(s.job.error, /^needs a full rebuild: /);
    assert.deepEqual(s.job.rebuild, [{ file, why: 'changed by the selection' }]);
    assert.equal(s.restartPending, false);
    assert.equal(i.restarts.length, 0);
  }
  // main moved past the image: its own Dockerfile differs from the one built
  const stale = instance({ imageInputs: { ...MAIN, Dockerfile: 'FROM older\n' } });
  stale.dp.switchTo({ prs: [{ number: 2 }] });
  const s = await settle(stale);
  assert.equal(s.job.state, 'refused');
  assert.deepEqual(s.job.rebuild, [{ file: 'Dockerfile', why: 'differs from the running image' }]);

  // An image built from #4's own Dockerfile runs #4 in place: what counts is
  // the running image, not main.
  const built = instance({ imageInputs: { ...MAIN, Dockerfile: 'FROM debian\n' } });
  built.dp.switchTo({ prs: [{ number: 4 }] });
  assert.equal((await settle(built)).job.state, 'done');
});

test('a selection that would remove the switcher itself is refused', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 5 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.match(s.job.error, /no server\/src\/dev-preview\.js/);
  assert.equal(s.restartPending, false);
});

test('npm ci runs only when the lockfile changed, and its result is cached by lockfile hash', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 6 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'done', s.job.error);
  const log = i.dp.status().log.join('\n');
  assert.match(log, /server: lockfile ([0-9a-f]+) is new → npm ci --omit=dev/);
  const key = log.match(/server: lockfile ([0-9a-f]+) is new/)[1];
  assert.ok(fs.existsSync(path.join(i.localDir, 'node_modules-cache', `server-${key}`, 'package-lock.json')));
  assert.equal(fs.readlinkSync(path.join(i.appDir, 'server/node_modules')), path.join(i.localDir, 'node_modules-cache', `server-${key}`, 'node_modules'));
});

// ------------------------------------------------------------ source boundary

test('only open PRs, bound to the head SHA GitHub reports', async () => {
  const i = instance();
  // #10 still has refs/pull/10/head, but GitHub says it is closed.
  i.dp.switchTo({ prs: [{ number: 10 }] });
  let s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.match(s.job.error, /PR #10 is closed; only open PRs/);
  // one closed PR anywhere in a stack refuses the stack
  i.dp.switchTo({ prs: [{ number: 2 }, { number: 10 }] });
  assert.match((await settle(i)).job.error, /#10 is closed/);
  // unknown number
  i.dp.switchTo({ prs: [{ number: 999 }] });
  assert.match((await settle(i)).job.error, /#999 does not exist/);
  // a SHA from the list that is no longer the head
  i.dp.switchTo({ prs: [{ number: 1, sha: prSha[2] }] });
  assert.match((await settle(i)).job.error, /#1 moved/);
  // a PR that GitHub says is on another repository
  const elsewhere = instance({ api: async (url) => {
    const r = await fixtureApi()(url);
    return url.includes('/pulls/') ? { ...r, base: { repo: { full_name: 'someone/fork' } } } : r;
  } });
  elsewhere.dp.switchTo({ prs: [{ number: 1 }] });
  assert.match((await settle(elsewhere)).job.error, /not a PR on huggingface\/agent-manager/);
  assert.equal(i.restarts.length + elsewhere.restarts.length, 0);
  assert.deepEqual(imageContent(i.appDir), IMAGE);
});

test('the author must have write, maintain or admin permission now, and the branch must be upstream or on their own fork', async () => {
  // GitHub's answer, field by field
  for (const role of ['write', 'maintain', 'admin']) assert.equal(permissionAllows({ role_name: role }), true, role);
  for (const role of ['read', 'triage', 'none', undefined]) assert.equal(permissionAllows({ role_name: role }), false, String(role));
  assert.equal(permissionAllows({ role_name: 'custom-reviewer', permission: 'write' }), true, 'an org custom role built on write');
  assert.equal(permissionAllows({ role_name: 'custom-reader', permission: 'read' }), false);
  const pr = (head, login = 'alice') => ({ user: { login }, base: { repo: { full_name: DEV_PREVIEW_REPO } }, head: { repo: head } });
  assert.equal(headRefusal(pr({ full_name: DEV_PREVIEW_REPO, owner: { login: 'huggingface' } })), null, 'upstream branch');
  assert.equal(headRefusal(pr({ full_name: 'Alice/agent-manager', owner: { login: 'Alice' } })), null, 'the author\'s own fork');
  assert.match(headRefusal(pr({ full_name: 'mallory/agent-manager', owner: { login: 'mallory' } })), /fork not owned by its author alice/);
  assert.match(headRefusal(pr(null)), /branch is gone/);
  assert.match(headRefusal({ ...pr({ full_name: DEV_PREVIEW_REPO }), base: { repo: { full_name: 'x/y' } } }), /not a PR on/);

  as.set(2, { user: { login: 'reader' } });
  as.set(3, { user: { login: 'collab' }, head: { repo: { full_name: 'collab/agent-manager', owner: { login: 'collab' } } } });
  as.set(9, { user: { login: 'mallory' }, head: { repo: { full_name: 'other/agent-manager', owner: { login: 'other' } } } });
  perms.set('reader', 'read');
  perms.set('collab', 'write');
  perms.set('mallory', 'admin');
  try {
    const i = instance();
    const byNumber = Object.fromEntries((await i.dp.listPrs()).prs.map((p) => [p.number, p]));
    assert.deepEqual([byNumber[1].allowed, byNumber[1].permission, byNumber[1].fork, byNumber[1].headRepo], [true, 'write', false, DEV_PREVIEW_REPO]);
    assert.deepEqual([byNumber[2].allowed, byNumber[2].permission], [false, 'read']);
    assert.match(byNumber[2].refusal, /its author reader has read permission on huggingface\/agent-manager, not write, maintain or admin/);
    assert.deepEqual([byNumber[3].allowed, byNumber[3].fork, byNumber[3].headRepo], [true, true, 'collab/agent-manager'], 'a writer\'s own fork');
    assert.equal(byNumber[9].allowed, false, 'even an admin\'s PR from someone else\'s fork');
    assert.match(byNumber[9].refusal, /fork not owned by its author mallory/);

    // read → refused before anything is fetched
    i.dp.switchTo({ prs: [{ number: 2 }] });
    let r = await settle(i);
    assert.equal(r.job.state, 'failed');
    assert.match(r.job.error, /PR #2 cannot be previewed: its author reader has read permission/);
    assert.deepEqual(r.job.steps.map((x) => x.name), ['resolve']);
    // inside a stack, too
    i.dp.switchTo({ prs: [{ number: 1 }, { number: 2 }] });
    assert.match((await settle(i)).job.error, /PR #2 cannot be previewed/);
    // a permission that cannot be read is a refusal, in the list and in a switch
    permFails.add('member-dev');
    i.dp.switchTo({ prs: [{ number: 1 }] });
    r = await settle(i);
    assert.match(r.job.error, /could not check member-dev's permission on huggingface\/agent-manager \(GitHub answered 403\); permission is never assumed/);
    const fresh = instance();
    const listed = (await fresh.dp.listPrs()).prs.find((p) => p.number === 1);
    assert.deepEqual([listed.allowed, listed.permission], [false, null]);
    permFails.clear();
    // a bot or anything that is not a plain user login is never looked up
    as.set(2, { user: { login: 'dependabot[bot]' } });
    i.dp.switchTo({ prs: [{ number: 2 }] });
    assert.match((await settle(i)).job.error, /is not a GitHub user login/);
    assert.deepEqual(imageContent(i.appDir), IMAGE);
    assert.equal(i.restarts.length, 0);

    // write → allowed; from the author's own fork as well
    i.dp.switchTo({ prs: [{ number: 3 }] });
    r = await settle(i);
    assert.equal(r.job.state, 'done', r.job.error);
    assert.deepEqual(r.next.prs.map(({ number, author, permission, headRepo }) => ({ number, author, permission, headRepo })),
      [{ number: 3, author: 'collab', permission: 'write', headRepo: 'collab/agent-manager' }]);
  } finally { as.clear(); perms.clear(); permFails.clear(); }
});

test('a repository-local git redirect cannot change what is fetched', async () => {
  // Another "repository" with its own main and #1.
  const evil = makeOrigin('evil', { ...MAIN, 'web/marker.txt': 'EVIL\n' });
  evil.pr(1, (w) => write(path.join(w, 'web/marker.txt'), 'EVIL-PR\n'));
  const i = instance();
  // Plant a redirect where the checkout lives, as if left by anything that
  // could write there.
  const repo = i.dp._paths.repoDir;
  git(root, 'init', '-q', repo);
  git(repo, 'config', `url.file://${evil.origin}.insteadOf`, `file://${origin}`);
  i.dp.switchTo({ prs: [{ number: 1 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.equal(read(path.join(i.appDir, 'public/index.html')), 'built:pr1');
  assert.deepEqual(s.next.prs.map(({ number, sha }) => ({ number, sha })), [{ number: 1, sha: prSha[1] }]);
  assert.equal(s.next.base, MAIN_SHA);
  assert.doesNotMatch(read(path.join(repo, '.git', 'config')), /insteadOf/i, 'a fresh database');
  // And if a fetch WERE redirected, the API-bound SHAs would not be there.
  const redirected = instance({ remote: evil.origin });
  redirected.dp.switchTo({ prs: [{ number: 1 }] });
  const r = await settle(redirected);
  assert.equal(r.job.state, 'failed');
  assert.match(r.job.error, /PR #1 moved to [0-9a-f]{7} while switching|is not the head of PR #1/);
});

// ------------------------------------------------------------ swap failures

test('a failure at any swap or state-write boundary leaves the image serving and nothing pending', async () => {
  const points = ['state-write', 'swap'];
  for (const point of points) {
    const i = instance({ faults: new Set([point]) });
    i.dp.switchTo({ prs: [{ number: 1 }] });
    const s = await settle(i);
    assert.equal(s.job.state, 'failed', point);
    assert.match(s.job.error, new RegExp(`injected fault at ${point}`));
    assert.deepEqual(imageContent(i.appDir), IMAGE, `${point}: all four paths still the image`);
    assert.equal(s.restartPending, false, `${point}: no restart claimed`);
    assert.equal(s.running.kind, 'main');
    assert.equal(fs.existsSync(i.stateFile), false, `${point}: no selection saved`);
    assert.equal(i.restarts.length, 0);
    // and the next attempt goes through
    i.dp.switchTo({ prs: [{ number: 1 }] });
    assert.equal((await settle(i)).job.state, 'done', `${point}: retry`);
  }
  // A failed swap restores the previous saved selection byte for byte.
  const i = instance({ faults: new Set(['swap']) });
  write(i.stateFile, '{"prs":[],"at":"before"}\n');
  i.dp.switchTo({ prs: [{ number: 2 }] });
  assert.equal((await settle(i)).job.state, 'failed');
  assert.equal(read(i.stateFile), '{"prs":[],"at":"before"}\n');
});

test('entrypoint.sh lays /app out once, keeping the image whole; without that layout nothing switches', async () => {
  const i = instance();
  assert.equal(fs.readlinkSync(path.join(i.appDir, 'current')), path.join(i.appDir, '.image'));
  for (const name of SWAPPED) assert.equal(fs.readlinkSync(path.join(i.appDir, name)), path.join('current', name));
  assert.deepEqual(imageContent(i.appDir), IMAGE);
  prepareLayout(i.appDir); // a second boot of the same container: no change
  assert.deepEqual(imageContent(i.appDir), IMAGE);
  assert.equal(read(path.join(i.appDir, '.image/server/src/index.js')), IMAGE.server);

  const bare = instance({ layout: false });
  bare.dp.switchTo({ prs: [{ number: 1 }] });
  const s = await settle(bare);
  assert.equal(s.job.state, 'failed');
  assert.match(s.job.error, /was not laid out for switching/);
  assert.ok(fs.statSync(path.join(bare.appDir, 'server')).isDirectory(), 'the image dirs are left as they are');
  assert.equal(s.job.steps.length, 0, 'refused before fetching anything');
});

test('a failed rollback leaves the release in place and says so', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 2 }] });
  await settle(i);
  await waitRestart(i, 1);
  const up = restarted(i, { faults: new Set(['swap']) });
  up.dp.rollback();
  const r = await settle(up);
  assert.equal(r.job.state, 'failed');
  assert.match(r.job.error, /roll back failed/);
  assert.equal(r.restartPending, false);
  assert.equal(r.running.kind, 'prs');
  assert.equal(read(path.join(up.appDir, 'scripts/two.sh')), 'echo two\n');
  assert.deepEqual(JSON.parse(read(up.stateFile)).prs.map((p) => p.number), [2]);
  assert.equal(up.restarts.length, 0);
});

test('one switch at a time, and none while a restart into the last one is pending', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 2 }] });
  assert.throws(() => i.dp.switchTo({ prs: [{ number: 1 }] }), /already running/);
  assert.throws(() => i.dp.rollback(), /already running/);
  assert.equal((await settle(i)).job.state, 'done');
  // built and swapped; this process has not restarted yet
  assert.throws(() => i.dp.switchTo({ prs: [{ number: 1 }] }), (e) => e.code === 'busy' && /restarting into the last switch/.test(e.message));
  assert.throws(() => i.dp.rollback(), (e) => e.code === 'busy');
  // once restarted, it accepts again
  const up = restarted(i);
  up.dp.switchTo({ prs: [{ number: 1 }] });
  assert.equal((await settle(up)).job.state, 'done');
});

// ------------------------------------------------------------ build output

test('a build that prints the parent\'s environment leaks a secret into no status, log or audit', () => {
  // A separate process that starts with the secrets in its environment, the
  // way the manager does, so /proc/<ppid>/environ really contains them.
  const known = 'am-canary-known-7f3e9d2c51b8';           // a Space secret (known value)
  const pattern = `hf_${'Qz9'.repeat(12)}`;               // not configured; caught by the token pattern
  const { appDir, localDir } = makeImage();
  const stateFile = path.join(root, 'leak-state.json');
  const durableLog = path.join(root, 'leak-durable.log');
  const out = path.join(root, 'leak-out.json');
  const runner = path.join(root, 'leak-runner.mjs');
  write(runner, `
    import fs from 'node:fs';
    import { createDevPreview } from ${JSON.stringify(MODULE)};
    const cfg = JSON.parse(process.argv[2]);
    const audits = [];
    const dp = createDevPreview({
      appDir: cfg.appDir, localDir: cfg.localDir, stateFile: cfg.stateFile, durableLog: cfg.durableLog,
      supervised: true, restart: () => {}, audit: (e) => audits.push(e),
      knownSecrets: () => [process.env.AM_CANARY_KNOWN],
      testRemote: 'file://' + cfg.origin, env: { PATH: process.env.PATH },
      fetchJson: async (url) => url.endsWith('/branches/main') ? { commit: { sha: cfg.main } }
        : url.endsWith('/permission') ? { role_name: 'write', permission: 'write' }
        : { number: 9, state: 'open', user: { login: 'm' }, head: { sha: cfg.head, repo: { full_name: 'huggingface/agent-manager' } }, base: { repo: { full_name: 'huggingface/agent-manager' } } },
    });
    dp.switchTo({ prs: [{ number: 9 }] });
    const s = await dp._wait();
    fs.writeFileSync(cfg.out, JSON.stringify({ status: dp.status(), info: dp.summary(), audits, state: s.job.state, error: s.job.error }));
  `);
  const cfg = { appDir, localDir, stateFile, durableLog, out, origin, main: MAIN_SHA, head: prSha[9] };
  const r = spawnSync(process.execPath, [runner, JSON.stringify(cfg)], {
    env: { PATH: process.env.PATH, AM_CANARY_KNOWN: known, AM_CANARY_PATTERN: pattern }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(read(out));
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'vite build failed (exit 1); its output is in the log', 'job.error carries no build output');
  const logText = result.status.log.join('\n');
  assert.match(logText, /LEAK-ATTEMPT/, 'the attempt really ran and its output reached the log');
  assert.match(logText, /AM_CANARY_KNOWN=\[redacted\]/);
  assert.match(logText, /AM_CANARY_PATTERN=\[redacted\]/);
  const sinks = {
    status: JSON.stringify(result.status), info: JSON.stringify(result.info), audit: JSON.stringify(result.audits),
    localLog: read(path.join(localDir, 'last-switch.log')), durableLog: read(durableLog),
  };
  for (const [name, text] of Object.entries(sinks)) {
    assert.ok(!text.includes(known), `known secret reached ${name}`);
    assert.ok(!text.includes(pattern), `pattern secret reached ${name}`);
  }
  assert.equal(fs.existsSync(stateFile), false);
});

// ------------------------------------------------------------ restart

test('after a container restart the saved selection is re-applied only if GitHub still allows exactly it', async () => {
  const stateFile = path.join(root, 'durable-selection.json');
  const first = instance({ stateFile });
  first.dp.switchTo({ prs: [{ number: 2 }, { number: 1 }] });
  const done = await settle(first);
  assert.equal(done.job.state, 'done');
  const pinned = done.next.prs.map(({ number, sha }) => ({ number, sha }));
  const saved = read(stateFile);
  const reboot = (api) => { write(stateFile, saved); return instance({ stateFile, api }); };

  // Unchanged: re-applied after a restart (/app back to the image, local disk empty).
  const second = reboot();
  assert.equal(second.dp.running().kind, 'main');
  assert.ok(second.dp.boot(), 'boot started a re-apply');
  let s = await settle(second);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.equal(s.job.source, 'boot');
  assert.deepEqual(s.job.steps[0].name, 're-check');
  assert.deepEqual(s.next.prs.map(({ number, sha }) => ({ number, sha })), pinned);
  assert.equal(s.next.base, MAIN_SHA);
  assert.equal(read(path.join(second.appDir, 'public/index.html')), 'built:pr1+other');
  await waitRestart(second, 1);
  assert.equal(restarted(second).dp.boot(), null, 'its own restart: nothing left to re-apply');

  // Each of these leaves the image running, says why, and restarts nothing.
  const staysOnImage = async (label, api, why) => {
    const i = reboot(api);
    assert.ok(i.dp.boot(), label);
    const r = await settle(i);
    assert.equal(r.job.state, 'failed', label);
    assert.match(r.job.error, why, label);
    assert.match(r.job.error, /Staying on main/, label);
    assert.deepEqual(imageContent(i.appDir), IMAGE, label);
    assert.equal(r.restartPending, false, label);
    assert.equal(i.restarts.length, 0, label);
  };
  closed.add(1);
  try { await staysOnImage('closed since', undefined, /PR #1 is closed/); } finally { closed.delete(1); }
  // the author's write access was revoked after the selection was made
  perms.set('member-dev', 'read');
  try { await staysOnImage('permission revoked since', undefined, /its author member-dev has read permission/); } finally { perms.clear(); }
  // the permission cannot be read at boot: never assumed, the image keeps running
  permFails.add('member-dev');
  try { await staysOnImage('permission unreadable', undefined, /could not check member-dev's permission.*never assumed/); } finally { permFails.clear(); }
  await staysOnImage('GitHub unreachable', async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }, /could not read main from GitHub/);
  // #1 gets a new commit: the accepted SHA is no longer what the PR is.
  git(work, 'checkout', '-q', '--detach', prSha[1]);
  write(path.join(work, 'web/marker.txt'), 'pr1-moved\n');
  git(work, 'commit', '-qam', 'pr 1 moved');
  git(work, 'push', '-q', '-f', origin, 'HEAD:refs/pull/1/head');
  try { await staysOnImage('moved since', undefined, /PR #1 moved to [0-9a-f]{7} since it was picked/); } finally {
    git(work, 'push', '-q', '-f', origin, `${prSha[1]}:refs/pull/1/head`);
  }
});

test('a tampered saved selection cannot name commits that are not those PRs or main', async () => {
  // A commit that exists on the origin (as any fork-network commit would) but
  // is neither main nor the PR's head.
  git(work, 'checkout', '-q', '--detach', MAIN_SHA);
  write(path.join(work, 'web/marker.txt'), 'unreviewed\n');
  git(work, 'commit', '-qam', 'not a PR head, not on main');
  const stray = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', '-f', origin, `${stray}:refs/hidden/stray`);
  for (const [label, sel, why] of [
    ['as a PR head', { base: MAIN_SHA, prs: [{ number: 1, sha: stray }] }, /PR #1 moved to/],
    ['as the base', { base: stray, prs: [{ number: 1, sha: prSha[1] }] }, /is not on main/],
  ]) {
    const stateFile = path.join(root, `tampered-${label.replace(/\W/g, '')}.json`);
    write(stateFile, JSON.stringify(sel));
    const i = instance({ stateFile });
    assert.ok(i.dp.boot(), label);
    const r = await settle(i);
    assert.equal(r.job.state, 'failed', label);
    assert.match(r.job.error, why, label);
    assert.deepEqual(imageContent(i.appDir), IMAGE, label);
  }
});

test('a build the supervisor rolled back after a crash is reported and not re-applied', async () => {
  const stateFile = path.join(root, 'crashed-selection.json');
  write(stateFile, JSON.stringify({ base: MAIN_SHA, prs: [{ number: 1, sha: prSha[1] }] }));
  const i = instance({ stateFile });
  write(path.join(i.localDir, 'crashed'), 'exit 1 from /x/server\n');
  assert.equal(i.dp.boot(), null);
  const s = i.dp.summary();
  assert.match(s.crashed.detail, /exit 1/);
  assert.deepEqual(s.selected.prs, []);
  assert.equal(i.audits.at(-1).event, 'crash-rollback');
  assert.equal(fs.existsSync(path.join(i.localDir, 'crashed')), false);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
