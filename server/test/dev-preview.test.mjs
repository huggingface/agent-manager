// Dev preview switching against a local bare repository standing in for GitHub:
// validation, merge order, conflicts, full-rebuild detection, rollback, and the
// re-apply of a persisted selection after a container restart. The npm installs
// and the web build run for real, against fixture packages with no
// dependencies and a stub `vite` preloaded in the node_modules cache, so the
// suite needs no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createDevPreview, validateSelection, lockKey, REBUILD_FILES, SWAPPED, DEV_PREVIEW_REPO, describe,
} from '../src/dev-preview.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dev-preview-'));
const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C.UTF-8' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');

// ------------------------------------------------------------ fixture "GitHub"
const origin = path.join(root, 'origin.git');
const work = path.join(root, 'work');
fs.mkdirSync(origin);
git(origin, 'init', '-q', '--bare');
git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
git(root, 'init', '-q', work);

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
for (const [f, t] of Object.entries(MAIN)) write(path.join(work, f), t);
git(work, 'add', '-A');
git(work, 'commit', '-qm', 'main');
git(work, 'push', '-q', origin, 'HEAD:refs/heads/main');
const MAIN_SHA = git(work, 'rev-parse', 'HEAD');

// One branch per PR, each off main, published where GitHub publishes them.
const prSha = {};
const makePr = (n, change) => {
  git(work, 'checkout', '-q', '--detach', MAIN_SHA);
  change(work);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', `pr ${n}`);
  git(work, 'push', '-q', '-f', origin, `HEAD:refs/pull/${n}/head`);
  prSha[n] = git(work, 'rev-parse', 'HEAD');
};
makePr(1, (w) => { write(path.join(w, 'web/marker.txt'), 'pr1\n'); write(path.join(w, 'server/src/index.js'), 'export const v = "pr1";\n'); });
makePr(2, (w) => { write(path.join(w, 'scripts/two.sh'), 'echo two\n'); write(path.join(w, 'web/other.txt'), 'two\n'); });
makePr(3, (w) => write(path.join(w, 'server/src/index.js'), 'export const v = "pr3";\n'));
makePr(4, (w) => write(path.join(w, 'Dockerfile'), 'FROM debian\n'));
makePr(5, (w) => fs.rmSync(path.join(w, 'server/src/dev-preview.js')));
makePr(6, (w) => { write(path.join(w, 'server/package.json'), pkg('fx-server', '1.0.1')); write(path.join(w, 'server/package-lock.json'), lock('fx-server', '1.0.1')); });
makePr(7, (w) => write(path.join(w, 'web/package.json'), pkg('fx-web', '1.0.0', { devDependencies: { playwright: '2.0.0' } })));
makePr(8, (w) => write(path.join(w, 'entrypoint.sh'), '#!/bin/sh\necho changed\n'));

// ------------------------------------------------------------ fixture image + instance
let n = 0;
function instance({ stateFile = path.join(root, `state-${++n}.json`), localDir, imageInputs = MAIN } = {}) {
  const dir = path.join(root, `inst-${++n}`);
  const appDir = path.join(dir, 'app');
  localDir ||= path.join(dir, 'local');
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
  // writing which tree it saw.
  const webSrc = path.join(dir, 'websrc');
  write(path.join(webSrc, 'package.json'), MAIN['web/package.json']);
  write(path.join(webSrc, 'package-lock.json'), MAIN['web/package-lock.json']);
  const vite = path.join(localDir, 'node_modules-cache', `web-${lockKey(webSrc)}`, 'node_modules', 'vite');
  write(path.join(vite, 'package.json'), '{"type":"commonjs"}');
  write(path.join(vite, 'bin/vite.js'), `
    const fs = require('fs');
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.html', 'built:' + fs.readFileSync('marker.txt', 'utf8').trim() + (fs.existsSync('other.txt') ? '+other' : ''));
  `);
  const restarts = [];
  const audits = [];
  const dp = createDevPreview({
    appDir, localDir, stateFile, supervised: true,
    restart: () => restarts.push(Date.now()),
    audit: (e) => audits.push(e),
    testRemote: `file://${origin}`,
    env: { PATH: process.env.PATH },
    fetchJson: async () => { throw new Error('no network in tests'); },
  });
  return { dp, appDir, localDir, stateFile, restarts, audits };
}
const live = (appDir, name) => fs.realpathSync(path.join(appDir, name));
const settle = (i) => i.dp._wait();
const waitRestart = async (i, count) => { for (let t = 0; t < 100 && i.restarts.length < count; t++) await new Promise((r) => setTimeout(r, 50)); };

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
  const src = read(path.join(REPO_ROOT, 'server/src/dev-preview.js'));
  assert.match(src, /const REPO_URL = `https:\/\/github\.com\/\$\{DEV_PREVIEW_REPO\}\.git`/);
  const index = read(path.join(REPO_ROOT, 'server/src/index.js'));
  const call = index.slice(index.indexOf('createDevPreview({'), index.indexOf('}) : null;'));
  assert.ok(call.length > 0);
  assert.doesNotMatch(call, /testRemote|remote:|REPO|github|fetchJson/);
  for (const bad of ['https://github.com/evil/fork.git', 'git@github.com:evil/fork.git', '/tmp/x', 'ext::sh -c x']) {
    assert.throws(() => createDevPreview({ appDir: root, localDir: root, stateFile: path.join(root, 'x'), testRemote: bad }), /file:\/\//);
  }
});

test('every Dockerfile COPY source is either swapped in place or a full-rebuild input', () => {
  const docker = read(path.join(REPO_ROOT, 'Dockerfile'));
  const covered = (src) => {
    const top = src.replace(/\/$/, '').split('/')[0];
    if (SWAPPED.includes(top) && top !== 'scripts') return true;          // server/, session.bashrc
    if (src === 'scripts/' ) return true;                                  // swapped as a whole
    if (REBUILD_FILES.includes(src)) return true;
    if (src === 'web/' ) return true;                                      // built into public/
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

test('switch to one PR: merged onto main, built, swapped atomically, persisted, audited, restarted', async () => {
  const i = instance();
  assert.equal(i.dp.running().kind, 'main');
  i.dp.switchTo({ prs: [{ number: 1, sha: prSha[1] }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'done', s.job.error);
  // the image is kept whole for rollback
  assert.equal(read(path.join(i.appDir, '.image/public/index.html')), 'image ui');
  for (const name of SWAPPED) assert.ok(fs.lstatSync(path.join(i.appDir, name)).isSymbolicLink(), name);
  assert.equal(read(path.join(i.appDir, 'public/index.html')), 'built:pr1');
  assert.equal(read(path.join(i.appDir, 'server/src/index.js')), 'export const v = "pr1";\n');
  // lockfile unchanged → the image's node_modules, no install
  assert.equal(fs.realpathSync(path.join(i.appDir, 'server/node_modules')), fs.realpathSync(path.join(i.appDir, '.image/server/node_modules')));
  assert.match(i.dp.status().log.join('\n'), /lockfile matches the image/);
  assert.match(i.dp.status().log.join('\n'), /web: lockfile [0-9a-f]+ cached, no install/);
  const run = i.dp.running();
  assert.equal(run.kind, 'prs');
  assert.deepEqual(run.prs, [{ number: 1, sha: prSha[1] }]);
  assert.equal(run.base, MAIN_SHA);
  assert.equal(describe(run), `#1 ${prSha[1].slice(0, 7)}`);
  assert.deepEqual(JSON.parse(read(i.stateFile)).prs, [{ number: 1, sha: prSha[1] }]);
  assert.equal(i.audits.at(-1).event, 'switch');
  assert.equal(i.audits.at(-1).ok, true);
  await waitRestart(i, 1);
  assert.equal(i.restarts.length, 1);
  assert.deepEqual(s.job.steps.map((x) => x.name), ['fetch', 'merge', 'check', 'export', 'dependencies', 'build web', 'assemble', 'swap']);
});

test('a stack of two is merged onto main in the order given; rollback returns to the image', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 2 }, { number: 1 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.equal(read(path.join(i.appDir, 'public/index.html')), 'built:pr1+other');
  assert.equal(read(path.join(i.appDir, 'scripts/two.sh')), 'echo two\n');
  const run = i.dp.running();
  assert.deepEqual(run.prs.map((p) => p.number), [2, 1]);
  // merge order is recorded in history: first parent chain main → #2 → #1
  const repo = i.dp._paths.repoDir;
  assert.match(git(repo, 'log', '-1', '--format=%s', run.merged), /preview: merge #1 /);
  assert.match(git(repo, 'log', '-1', '--format=%s', `${run.merged}^1`), /preview: merge #2 /);
  await waitRestart(i, 1);

  i.dp.rollback();
  const r = await settle(i);
  assert.equal(r.job.state, 'done');
  assert.equal(i.dp.running().kind, 'main');
  assert.equal(read(path.join(i.appDir, 'public/index.html')), 'image ui');
  assert.equal(read(path.join(i.appDir, 'server/src/index.js')), 'export const v = "image";\n');
  assert.equal(live(i.appDir, 'server'), fs.realpathSync(path.join(i.appDir, '.image/server')));
  assert.deepEqual(JSON.parse(read(i.stateFile)).prs, []);
  await waitRestart(i, 2);
  assert.equal(i.restarts.length, 2);
  assert.equal(i.audits.at(-1).event, 'rollback');
});

test('a merge conflict stops the switch, names the files, and leaves the running build alone', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 1 }, { number: 3 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.deepEqual(s.job.conflict, { pr: 3, onto: 'main + #1', files: ['server/src/index.js'] });
  assert.match(s.job.error, /#3 conflicts with main \+ #1 in server\/src\/index\.js/);
  assert.equal(i.dp.running().kind, 'main');
  assert.ok(!fs.lstatSync(path.join(i.appDir, 'server')).isSymbolicLink(), 'nothing swapped');
  assert.equal(fs.existsSync(i.stateFile), false, 'selection not persisted');
  assert.equal(i.restarts.length, 0);
  assert.equal(i.audits.at(-1).ok, false);
  // the checkout is usable again: a clean switch right after works
  i.dp.switchTo({ prs: [{ number: 3 }] });
  assert.equal((await settle(i)).job.state, 'done');
});

test('selections that touch image build inputs are refused with "needs a full rebuild" and the files', async () => {
  for (const [pr, file] of [[4, 'Dockerfile'], [8, 'entrypoint.sh'], [7, 'web/package.json (playwright pin)']]) {
    const i = instance();
    i.dp.switchTo({ prs: [{ number: 2 }, { number: pr }] });
    const s = await settle(i);
    assert.equal(s.job.state, 'refused', `#${pr}`);
    assert.match(s.job.error, /^needs a full rebuild: /);
    assert.deepEqual(s.job.rebuild, [{ file, why: 'changed by the selection' }]);
    assert.equal(i.dp.running().kind, 'main');
    assert.equal(i.restarts.length, 0);
  }
  // main moved past the image: its own Dockerfile differs from the one built
  const stale = instance({ imageInputs: { ...MAIN, Dockerfile: 'FROM older\n' } });
  stale.dp.switchTo({ prs: [{ number: 2 }] });
  const s = await settle(stale);
  assert.equal(s.job.state, 'refused');
  assert.deepEqual(s.job.rebuild, [{ file: 'Dockerfile', why: 'differs from the running image' }]);
});

test('a selection that would remove the switcher itself is refused', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 5 }] });
  const s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.match(s.job.error, /no server\/src\/dev-preview\.js/);
  assert.equal(i.dp.running().kind, 'main');
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

test('unknown PRs and PRs that moved since the list was loaded fail cleanly', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 999 }] });
  let s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.match(s.job.error, /#999 does not exist/);
  i.dp.switchTo({ prs: [{ number: 1, sha: prSha[2] }] });
  s = await settle(i);
  assert.equal(s.job.state, 'failed');
  assert.match(s.job.error, /#1 moved/);
  assert.equal(i.dp.running().kind, 'main');
});

test('only one switch at a time', async () => {
  const i = instance();
  i.dp.switchTo({ prs: [{ number: 2 }] });
  assert.throws(() => i.dp.switchTo({ prs: [{ number: 1 }] }), /already running/);
  assert.throws(() => i.dp.rollback(), /already running/);
  await settle(i);
});

// ------------------------------------------------------------ restart

test('after a container restart the persisted selection is re-applied with the same SHAs', async () => {
  const stateFile = path.join(root, 'durable-selection.json');
  const first = instance({ stateFile });
  first.dp.switchTo({ prs: [{ number: 2 }, { number: 1 }] });
  assert.equal((await settle(first)).job.state, 'done');
  const pinned = first.dp.running().prs;

  // #1 gets a new commit after the switch; the restart must not pick it up.
  git(work, 'checkout', '-q', '--detach', prSha[1]);
  write(path.join(work, 'web/marker.txt'), 'pr1-moved\n');
  git(work, 'commit', '-qam', 'pr 1 moved');
  git(work, 'push', '-q', '-f', origin, 'HEAD:refs/pull/1/head');

  // A restart: /app is the image again and local disk is empty; /data kept the file.
  const second = instance({ stateFile });
  assert.equal(second.dp.running().kind, 'main');
  assert.ok(second.dp.boot(), 'boot started a re-apply');
  const s = await settle(second);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.equal(s.job.source, 'boot');
  assert.deepEqual(second.dp.running().prs, pinned);
  assert.equal(second.dp.running().base, MAIN_SHA);
  assert.equal(read(path.join(second.appDir, 'public/index.html')), 'built:pr1+other');
  await waitRestart(second, 1);
  assert.equal(second.restarts.length, 1);

  // Its server restarting into the build: nothing left to re-apply.
  assert.equal(second.dp.boot(), null);
  git(work, 'push', '-q', '-f', origin, `${prSha[1]}:refs/pull/1/head`);
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
