// Dev preview: switch ONE dev Space between open PRs of this repo in place,
// without a Docker rebuild. See docs/dev-preview.md.
//
// Everything here exists only when the Space sets AM_DEV_PREVIEW=1. Without it
// index.js registers no route, /api/info carries no `devPreview` key (so the UI
// shows nothing) and nothing runs at boot. Production and the template never set
// it.
//
// This is code execution BY DESIGN: whatever a PR contains runs as the app. So
// the inputs are as narrow as they can be:
//   - the repository is a constant, never a parameter of any request;
//   - a selection is a list of PR numbers (integers) and optional head SHAs
//     (40 hex chars), checked before anything runs;
//   - every subprocess is execFile with an argument array (no shell), with an
//     environment built from scratch rather than inherited from the server, so
//     a PR's install scripts never see the Space's tokens;
//   - git runs with global/system config ignored, so an `insteadOf` in the
//     operator's ~/.gitconfig cannot redirect the fetch to another repository.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const DEV_PREVIEW_REPO = 'huggingface/agent-manager';
const REPO_URL = `https://github.com/${DEV_PREVIEW_REPO}.git`;
const API_URL = `https://api.github.com/repos/${DEV_PREVIEW_REPO}`;

export const devPreviewEnabled = (env = process.env) => env.AM_DEV_PREVIEW === '1';

// What an in-place switch replaces under /app. Everything else in the image
// (CLIs, apt packages, /etc hooks, entrypoint.sh) stays as it was built.
export const SWAPPED = ['server', 'scripts', 'public', 'session.bashrc'];
// Files the image is built FROM that the swap cannot replace. A selection that
// changes any of them, or whose copy differs from the one the running image was
// built with, needs a full rebuild. test/dev-preview.test.mjs checks that every
// COPY in the Dockerfile is covered by SWAPPED or by this list.
export const REBUILD_FILES = [
  'Dockerfile', '.dockerignore', 'entrypoint.sh', 'codex-requirements.toml',
  'gemini-system-defaults.json', 'scripts/am-codex-repin-hook.sh',
];
// web/package.json feeds the image only through its playwright pin (the baked
// Chromium must match it); its other changes are handled by `npm ci`.
const PLAYWRIGHT_PIN_FILE = 'web/package.json';
// The switcher itself. A selection whose tree lacks it would boot an app with
// no way back except a container restart, so it is refused.
const SELF = 'server/src/dev-preview.js';
// Exit code the server uses to ask the entrypoint's supervisor for a restart.
export const RESTART_EXIT_CODE = 75;
export const MAX_PRS = 6;
const SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------- validation

const bad = (message) => Object.assign(new Error(message), { statusCode: 400, code: 'invalid-input' });

/** A PR number: a JSON integer, 1..9_999_999. Strings are refused, not parsed. */
export function validPrNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 9_999_999;
}
export const validSha = (value) => typeof value === 'string' && SHA.test(value);

/**
 * The only shape a switch request may take: {prs: [{number, sha?}, …]}, in merge
 * order, no duplicates. Unknown keys are refused, so nothing that looks like a
 * repository, ref or URL can ride along.
 */
export function validateSelection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body: must be an object');
  for (const key of Object.keys(body)) if (key !== 'prs' && key !== 'from') throw bad(`body: unknown field '${key}'`);
  const { prs } = body;
  if (!Array.isArray(prs) || prs.length < 1 || prs.length > MAX_PRS) throw bad(`prs: must be a list of 1 to ${MAX_PRS} pull requests`);
  const seen = new Set();
  return prs.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(`prs[${i}]: must be an object`);
    for (const key of Object.keys(item)) if (key !== 'number' && key !== 'sha') throw bad(`prs[${i}]: unknown field '${key}'`);
    if (!validPrNumber(item.number)) throw bad(`prs[${i}].number: must be a pull request number`);
    if (item.sha !== undefined && !validSha(item.sha)) throw bad(`prs[${i}].sha: must be a full 40-character commit SHA`);
    if (seen.has(item.number)) throw bad(`prs[${i}].number: #${item.number} is listed twice`);
    seen.add(item.number);
    return item.sha ? { number: item.number, sha: item.sha } : { number: item.number };
  });
}

// ---------------------------------------------------------------- helpers

const short = (sha) => (sha ? sha.slice(0, 7) : '');
/** Cache key for a package dir's installed node_modules: its manifest + lockfile. */
export const lockKey = (dir) => {
  const h = crypto.createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) {
    h.update(`${name}\0`);
    try { h.update(fs.readFileSync(path.join(dir, name))); } catch { h.update('<missing>'); }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
};
const playwrightPin = (text) => {
  try { return JSON.parse(text)?.devDependencies?.playwright ?? null; } catch { return '<unreadable>'; }
};

/** Label for what is running: "main" or "#182 abc1234 + #190 def5678". */
export function describe(selection) {
  if (!selection?.prs?.length) return 'main';
  return selection.prs.map((p) => `#${p.number} ${short(p.sha)}`).join(' + ');
}

// ---------------------------------------------------------------- the service

/**
 * @param {object} o
 * @param {string} o.appDir        where the image put the app (/app)
 * @param {string} o.localDir      fast local disk for the checkout, caches, releases
 * @param {string} o.stateFile     durable selection (on /data) re-applied on boot
 * @param {string} [o.durableLog]  durable copy of the last switch log
 * @param {boolean} o.supervised   the entrypoint restarts the server on RESTART_EXIT_CODE
 * @param {() => void} o.restart   stop sessions and exit with RESTART_EXIT_CODE
 * @param {(entry) => void} o.audit  append an audit-log record
 * @param {string} [o.testRemote]  file:// URL standing in for GitHub in tests ONLY
 * @param {Function} [o.fetchJson] GitHub API reader (tests stub it)
 */
export function createDevPreview({
  appDir, localDir, stateFile, durableLog = null, supervised = false,
  restart = () => {}, audit = () => {}, testRemote = null, fetchJson = null,
  githubToken = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '', env = process.env,
}) {
  if (testRemote !== null && !/^file:\/\//.test(testRemote)) throw new Error('testRemote must be a file:// URL');
  const remote = testRemote || REPO_URL;
  const repoDir = path.join(localDir, 'repo');
  const releasesDir = path.join(localDir, 'releases');
  const nmDir = path.join(localDir, 'node_modules-cache');
  const logFile = path.join(localDir, 'last-switch.log');
  const crashFile = path.join(localDir, 'crashed');
  const imageDir = path.join(appDir, '.image');
  const imageInputs = path.join(appDir, '.image-inputs');

  // A clean environment for every child: no Space secrets, no CLI homes.
  const childEnv = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(localDir, 'home'),
    LANG: 'C.UTF-8',
    npm_config_cache: path.join(localDir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Parts of git (merge-ort) and npm want a writable tmp.
    TMPDIR: path.join(localDir, 'tmp'),
  };
  const gitBase = [
    '-c', 'protocol.allow=never', '-c', `protocol.${testRemote ? 'file' : 'https'}.allow=always`,
    '-c', 'user.name=Agent Manager preview', '-c', 'user.email=preview@agent-manager.local',
    '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false',
  ];

  let job = null;           // the switch in flight, or the last one
  let lastLog = [];
  let crashed = null;
  let prCache = null;

  const log = (line) => {
    const text = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    lastLog.push(text);
    if (lastLog.length > 2000) lastLog = lastLog.slice(-1500);
    try { fs.appendFileSync(logFile, `${text}\n`); } catch {}
  };

  const run = (cmd, args, { cwd, timeout = 600_000 } = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: childEnv, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim().split('\n').slice(-25).join('\n');
        reject(Object.assign(new Error(`${cmd} ${args[0] || ''} failed: ${msg}`), { stdout: String(stdout), stderr: String(stderr), exit: err.code }));
      } else resolve(String(stdout));
    });
  });
  const git = (args, opts = {}) => run('git', [...gitBase, ...args], { cwd: repoDir, ...opts });

  // ------------------------------------------------------------ what is running

  /** Read from the filesystem, not from memory: the supervisor may have rolled back. */
  function running() {
    let target = null;
    try { target = fs.readlinkSync(path.join(appDir, 'server')); } catch {}
    if (!target || !target.startsWith(releasesDir + path.sep)) return { kind: 'main', label: 'main', image: true, id: 'image', prs: [] };
    const release = readJson(path.join(path.dirname(target), 'release.json'));
    if (!release) return { kind: 'unknown', label: 'unknown release', id: path.basename(path.dirname(target)), prs: [] };
    return { kind: 'prs', label: describe(release), id: release.id, base: release.base, prs: release.prs, merged: release.merged, builtAt: release.builtAt };
  }

  const selection = () => readJson(stateFile) || { prs: [] };

  function summary() {
    return {
      repo: DEV_PREVIEW_REPO,
      supervised,
      running: running(),
      selected: selection(),
      job: job && {
        id: job.id, kind: job.kind, source: job.source, state: job.state, step: job.step,
        steps: job.steps, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
        rebuild: job.rebuild, conflict: job.conflict, prs: job.prs, restarting: job.restarting,
      },
      crashed,
    };
  }

  // ------------------------------------------------------------ PR list

  async function defaultFetchJson(url) {
    const token = githubToken();
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json', 'user-agent': 'agent-manager-dev-preview',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return res.json();
  }

  async function listPrs() {
    if (prCache && Date.now() - prCache.at < 20_000) return prCache.value;
    const get = fetchJson || defaultFetchJson;
    const [pulls, main] = await Promise.all([
      get(`${API_URL}/pulls?state=open&per_page=100&sort=updated&direction=desc`),
      get(`${API_URL}/branches/main`),
    ]);
    const prs = (Array.isArray(pulls) ? pulls : [])
      .filter((p) => validPrNumber(p?.number) && validSha(p?.head?.sha))
      .map((p) => ({
        number: p.number,
        title: String(p.title || '').slice(0, 300),
        author: String(p.user?.login || '').slice(0, 100),
        sha: p.head.sha,
        draft: !!p.draft,
        updatedAt: p.updated_at || null,
        url: `https://github.com/${DEV_PREVIEW_REPO}/pull/${p.number}`,
      }));
    const mainSha = validSha(main?.commit?.sha) ? main.commit.sha : null;
    const value = { repo: DEV_PREVIEW_REPO, main: { sha: mainSha }, prs };
    prCache = { at: Date.now(), value };
    return value;
  }

  // ------------------------------------------------------------ the switch

  function begin(kind, source, prs) {
    if (job && job.state === 'running') {
      throw Object.assign(new Error(`a ${job.kind} is already running`), { statusCode: 409, code: 'busy' });
    }
    lastLog = [];
    try { fs.mkdirSync(localDir, { recursive: true }); fs.writeFileSync(logFile, ''); } catch {}
    job = {
      id: crypto.randomUUID(), kind, source, prs, state: 'running', step: 'starting', steps: [],
      startedAt: Date.now(), finishedAt: null, error: null, rebuild: null, conflict: null, restarting: false,
    };
    return job;
  }

  async function step(name, fn) {
    job.step = name;
    const t0 = Date.now();
    log(`── ${name}`);
    try { return await fn(); } finally {
      const ms = Date.now() - t0;
      job.steps.push({ name, ms });
      log(`   ${name}: ${(ms / 1000).toFixed(1)}s`);
    }
  }

  async function ensureRepo() {
    fs.mkdirSync(childEnv.HOME, { recursive: true });
    fs.mkdirSync(childEnv.TMPDIR, { recursive: true });
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      fs.mkdirSync(repoDir, { recursive: true });
      await git(['init', '-q']);
    }
  }

  async function revParse(ref) {
    try { return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim(); } catch { return null; }
  }
  async function hasCommit(sha) { return (await revParse(sha)) === sha; }

  /**
   * Fetch main and every PR head into refs/am/*. With `pinned` SHAs (a boot
   * re-apply), make sure those exact commits are present even if the PR has
   * moved on since, fetching them by SHA when the ref no longer points there.
   */
  async function fetchRefs(prs, base) {
    // The remote is passed on every fetch rather than stored as a configured
    // remote, so nothing on disk can redirect it.
    const specs = ['+refs/heads/main:refs/am/main', ...prs.map((p) => `+refs/pull/${p.number}/head:refs/am/pr/${p.number}`)];
    log(`fetching ${DEV_PREVIEW_REPO}: main${prs.map((p) => ` #${p.number}`).join('')}`);
    try {
      await git(['fetch', '--no-tags', '--quiet', remote, ...specs], { timeout: 300_000 });
    } catch (e) {
      const missing = (e.stderr || e.message).match(/refs\/pull\/(\d+)\/head/);
      if (missing) throw new Error(`PR #${missing[1]} does not exist on ${DEV_PREVIEW_REPO}`);
      throw e;
    }
    const want = [...prs.filter((p) => p.sha).map((p) => p.sha), ...(base ? [base] : [])];
    for (const sha of want) {
      if (await hasCommit(sha)) continue;
      log(`fetching pinned commit ${short(sha)}`);
      try { await git(['fetch', '--no-tags', '--quiet', remote, sha], { timeout: 300_000 }); } catch {}
      if (!(await hasCommit(sha))) throw new Error(`commit ${short(sha)} is no longer available on ${DEV_PREVIEW_REPO}`);
    }
  }

  /** Merge every PR onto main in the given order. Stops at the first conflict. */
  async function mergeStack(base, prs) {
    await git(['reset', '-q', '--hard']);
    await git(['checkout', '-q', '--force', '--detach', base]);
    await git(['clean', '-qfdx']);
    for (let i = 0; i < prs.length; i++) {
      const p = prs[i];
      log(`merging #${p.number} (${short(p.sha)})`);
      try {
        await git(['merge', '--no-ff', '--no-edit', '-m', `preview: merge #${p.number} ${p.sha}`, p.sha]);
      } catch (e) {
        let files = [];
        try { files = (await git(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean); } catch {}
        try { await git(['merge', '--abort']); } catch {}
        const onto = ['main', ...prs.slice(0, i).map((q) => `#${q.number}`)].join(' + ');
        job.conflict = { pr: p.number, onto, files };
        throw new Error(files.length
          ? `#${p.number} conflicts with ${onto} in ${files.join(', ')}`
          : `#${p.number} could not be merged onto ${onto}: ${e.message}`);
      }
    }
    return (await git(['rev-parse', 'HEAD'])).trim();
  }

  const showFile = async (rev, file) => {
    try { return await git(['show', `${rev}:${file}`]); } catch { return null; }
  };
  const imageFile = (file) => { try { return fs.readFileSync(path.join(imageInputs, file), 'utf8'); } catch { return null; } };

  /**
   * Files that make this selection impossible to switch to in place: build
   * inputs whose content differs from the copy the running image was built
   * with. That is the rule, not "the PRs touch it": a PR that changes the
   * Dockerfile is fine on an image built from that same Dockerfile, and main
   * itself needs a rebuild once it has moved past the image. Each file says
   * which it is. Without the image's copies (an image older than this feature)
   * it falls back to what the selection changes relative to main.
   */
  async function rebuildNeeded(base, merged) {
    const changed = new Set((await git(['diff', '--name-only', base, merged])).split('\n').filter(Boolean));
    const haveInputs = fs.existsSync(imageInputs);
    const why = (byPrs) => (byPrs ? 'changed by the selection' : 'differs from the running image');
    const out = [];
    for (const file of REBUILD_FILES) {
      const differs = haveInputs ? (await showFile(merged, file)) !== imageFile(file) : changed.has(file);
      if (differs) out.push({ file, why: why(changed.has(file)) });
    }
    const pin = playwrightPin(await showFile(merged, PLAYWRIGHT_PIN_FILE));
    const basePin = playwrightPin(await showFile(base, PLAYWRIGHT_PIN_FILE));
    const imagePin = haveInputs ? playwrightPin(imageFile(PLAYWRIGHT_PIN_FILE)) : basePin;
    if (pin !== imagePin) out.push({ file: `${PLAYWRIGHT_PIN_FILE} (playwright pin)`, why: why(pin !== basePin) });
    return out;
  }

  /** The image's own server dir. Valid once adoptImage() has run. */
  const imageServer = () => path.join(imageDir, 'server');

  // One install per cache entry at a time: a boot-time prewarm and a switch
  // asking for the same lockfile share the same run.
  const installing = new Map();
  function npmCi(kind, srcDir, omitDev) {
    const id = `${kind}-${lockKey(srcDir)}`;
    if (!installing.has(id)) {
      installing.set(id, installOnce(kind, srcDir, omitDev).finally(() => installing.delete(id)));
    } else log(`${kind}: waiting for the install already running for ${id}`);
    return installing.get(id);
  }
  async function installOnce(kind, srcDir, omitDev) {
    const key = lockKey(srcDir);
    const target = path.join(nmDir, `${kind}-${key}`);
    if (fs.existsSync(path.join(target, 'node_modules'))) {
      log(`${kind}: lockfile ${key} cached, no install`);
      return path.join(target, 'node_modules');
    }
    log(`${kind}: lockfile ${key} is new → npm ci${omitDev ? ' --omit=dev' : ''}`);
    const work = `${target}.tmp-${process.pid}`;
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(srcDir, f), path.join(work, f));
    await run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error', ...(omitDev ? ['--omit=dev'] : [])], { cwd: work, timeout: 900_000 });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(work, target);
    return path.join(target, 'node_modules');
  }

  async function serverModules(srcServer) {
    const img = imageServer();
    const same = lockKey(srcServer) === lockKey(img);
    if (same && fs.existsSync(path.join(img, 'node_modules'))) {
      log('server: lockfile matches the image, reusing its node_modules');
      return path.join(img, 'node_modules');
    }
    return npmCi('server', srcServer, true);
  }

  /** Move the image's own copies aside once, leaving symlinks in their place. */
  function adoptImage() {
    fs.mkdirSync(imageDir, { recursive: true });
    for (const name of SWAPPED) {
      const live = path.join(appDir, name);
      const kept = path.join(imageDir, name);
      let st = null;
      try { st = fs.lstatSync(live); } catch {}
      if (st && !st.isSymbolicLink()) {
        fs.renameSync(live, kept);
        fs.symlinkSync(kept, live);
      } else if (!st && fs.existsSync(kept)) fs.symlinkSync(kept, live);
    }
  }

  /** Point every swapped path at `dir` — each one a single atomic rename. */
  function pointAt(dir) {
    adoptImage();
    for (const name of SWAPPED) {
      const live = path.join(appDir, name);
      const tmp = path.join(appDir, `.${name}.swap-${process.pid}`);
      try { fs.unlinkSync(tmp); } catch {}
      fs.symlinkSync(path.join(dir, name), tmp);
      fs.renameSync(tmp, live);
    }
  }

  function pruneReleases(keep) {
    let names = [];
    try { names = fs.readdirSync(releasesDir); } catch { return; }
    for (const n of names) {
      if (keep.includes(n)) continue;
      fs.rmSync(path.join(releasesDir, n), { recursive: true, force: true });
    }
  }

  function finish(state, error = null) {
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
    const secs = ((job.finishedAt - job.startedAt) / 1000).toFixed(1);
    log(state === 'done' ? `done in ${secs}s` : `${state} after ${secs}s: ${error}`);
    if (durableLog) {
      try { fs.mkdirSync(path.dirname(durableLog), { recursive: true }); fs.writeFileSync(durableLog, `${lastLog.join('\n')}\n`); } catch {}
    }
    try {
      audit({
        event: job.kind, source: job.source, ok: state === 'done', state,
        request: { prs: job.prs },
        result: {
          running: running().label, error, durationMs: job.finishedAt - job.startedAt,
          ...(job.conflict ? { conflict: job.conflict } : {}), ...(job.rebuild ? { rebuild: job.rebuild } : {}),
        },
      });
    } catch {}
  }

  function scheduleRestart() {
    if (!supervised) {
      log('not running under the entrypoint supervisor: restart the server yourself to load it');
      return;
    }
    job.restarting = true;
    log('restarting the server');
    // Long enough for a polling panel to see "done" before the socket drops.
    setTimeout(() => { try { restart(); } catch (e) { console.error('[dev-preview] restart failed', e); } }, 1500).unref?.();
  }

  async function doSwitch(prs, { base: pinnedBase = null } = {}) {
    const t0 = Date.now();
    await step('fetch', async () => { await ensureRepo(); await fetchRefs(prs, pinnedBase); });
    const base = pinnedBase || await revParse('refs/am/main');
    if (!base) throw new Error('main could not be fetched');
    const resolved = [];
    for (const p of prs) {
      const head = await revParse(`refs/am/pr/${p.number}`);
      if (!head && !p.sha) throw new Error(`PR #${p.number} does not exist on ${DEV_PREVIEW_REPO}`);
      if (p.sha && job.source !== 'boot' && head !== p.sha) {
        throw new Error(`PR #${p.number} moved to ${short(head)} since the list was loaded (expected ${short(p.sha)}); refresh and try again`);
      }
      resolved.push({ number: p.number, sha: p.sha || head });
    }
    job.prs = resolved;
    log(`base main ${short(base)}; stack ${describe({ prs: resolved })}`);

    const merged = await step('merge', () => mergeStack(base, resolved));
    await step('check', async () => {
      if (!(await showFile(merged, SELF))) {
        throw new Error(`this selection has no ${SELF}: it would boot an app without the preview switcher. Add the PR that introduces it to the stack, or wait until it is on main`);
      }
      const rebuild = await rebuildNeeded(base, merged);
      if (rebuild.length) {
        job.rebuild = rebuild;
        throw new Error(`needs a full rebuild: ${rebuild.map((r) => r.file).join(', ')}`);
      }
    });

    const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${resolved.map((p) => `${p.number}`).join('-')}`;
    const rel = path.join(releasesDir, id);
    const build = path.join(rel, '.build');
    await step('export', async () => {
      fs.rmSync(rel, { recursive: true, force: true });
      fs.mkdirSync(build, { recursive: true });
      const tar = path.join(rel, 'tree.tar');
      await git(['archive', '--format=tar', '-o', tar, merged, 'server', 'scripts', 'web', 'session.bashrc']);
      await run('tar', ['-xf', tar, '-C', build]);
      fs.rmSync(tar);
    });
    const [srvModules, webModules] = await step('dependencies', () => {
      // The release links the image's node_modules by its kept path, never
      // through /app/server — that becomes a link to the release itself.
      adoptImage();
      return Promise.all([
      serverModules(path.join(build, 'server')),
      npmCi('web', path.join(build, 'web'), false),
      ]);
    });
    await step('build web', async () => {
      const web = path.join(build, 'web');
      fs.symlinkSync(webModules, path.join(web, 'node_modules'));
      // vite only: type-checking is the PR's CI's job, not a preview's.
      await run(process.execPath, [path.join(web, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: web, timeout: 600_000 });
    });
    await step('assemble', async () => {
      fs.renameSync(path.join(build, 'server'), path.join(rel, 'server'));
      fs.symlinkSync(srvModules, path.join(rel, 'server', 'node_modules'));
      fs.renameSync(path.join(build, 'scripts'), path.join(rel, 'scripts'));
      fs.renameSync(path.join(build, 'session.bashrc'), path.join(rel, 'session.bashrc'));
      fs.renameSync(path.join(build, 'web', 'dist'), path.join(rel, 'public'));
      fs.rmSync(build, { recursive: true, force: true });
      writeJson(path.join(rel, 'release.json'), {
        id, base, prs: resolved, merged, builtAt: new Date().toISOString(), buildMs: Date.now() - t0,
      });
    });
    const previous = running().id;
    await step('swap', async () => {
      pointAt(rel);
      writeJson(stateFile, { base, prs: resolved, at: new Date().toISOString() });
      pruneReleases([id, previous]);
    });
  }

  function startSwitch(prs, { source = 'operator', base = null } = {}) {
    begin('switch', source, prs);
    log(`switch to ${prs.map((p) => `#${p.number}`).join(' + ')} (${source})`);
    doSwitch(prs, { base }).then(
      () => { finish('done'); scheduleRestart(); },
      (e) => finish(job.rebuild ? 'refused' : 'failed', e.message),
    );
    return summary();
  }

  /** Back to the image's own copy — no fetch, no build. */
  function rollback({ source = 'operator' } = {}) {
    begin('rollback', source, []);
    log('roll back to main (the image build)');
    try {
      const was = running();
      if (fs.existsSync(imageDir)) pointAt(imageDir);
      writeJson(stateFile, { prs: [], at: new Date().toISOString() });
      log(`was ${was.label}`);
      finish('done');
      if (was.kind !== 'main') scheduleRestart();
      else log('already on main; nothing to restart');
    } catch (e) {
      finish('failed', e.message);
    }
    return summary();
  }

  /**
   * At server start: report a crash the supervisor rolled back from, and
   * re-apply the persisted selection when the container lost it (a restart
   * wipes local disk and /app back to the image).
   */
  function boot() {
    try {
      const marker = fs.readFileSync(crashFile, 'utf8').trim();
      fs.rmSync(crashFile, { force: true });
      const bad = selection();
      crashed = { at: new Date().toISOString(), detail: marker.slice(0, 500), selection: bad };
      // Forget it, or every boot would rebuild the same crash.
      writeJson(stateFile, { prs: [], at: crashed.at, crashedFrom: bad });
      lastLog = [];
      log(`the previewed release exited right after starting (${marker.slice(0, 200)}); the supervisor rolled back to main`);
      audit({ event: 'crash-rollback', source: 'supervisor', ok: false, state: 'rolled-back', request: { prs: bad.prs || [] }, result: { detail: marker.slice(0, 500) } });
    } catch {}
    try { lastLog = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-1500); } catch {
      try { if (durableLog) lastLog = fs.readFileSync(durableLog, 'utf8').split('\n').filter(Boolean).slice(-1500); } catch {}
    }
    const want = selection();
    const now = running();
    const prewarm = () => {
      // The image has no web node_modules (the web is built in its own stage),
      // so the first switch after a container start would install them. Do it
      // now, quietly, for main's lockfile.
      const web = path.join(imageInputs, 'web');
      if (!fs.existsSync(path.join(web, 'package-lock.json'))) return;
      fs.mkdirSync(childEnv.TMPDIR, { recursive: true });
      npmCi('web', web, false).catch((e) => console.error('[dev-preview] web prewarm failed:', e.message));
    };
    const same = (want.prs || []).length === now.prs.length
      && (want.prs || []).every((p, i) => p.number === now.prs[i].number && p.sha === now.prs[i].sha);
    if ((want.prs || []).length && !same) {
      const prs = want.prs.filter((p) => validPrNumber(p?.number) && validSha(p?.sha));
      if (prs.length !== want.prs.length || (want.base && !validSha(want.base))) {
        console.error('[dev-preview] persisted selection is malformed; staying on main');
        return null;
      }
      console.log(`[dev-preview] re-applying ${describe(want)} on main ${short(want.base)}`);
      return startSwitch(prs, { source: 'boot', base: want.base || null });
    }
    if (now.kind === 'main') prewarm();
    return null;
  }

  return {
    summary, running, listPrs, boot, rollback,
    switchTo: (body) => startSwitch(validateSelection(body)),
    status: () => ({ ...summary(), log: lastLog.slice(-400) }),
    // tests
    _paths: { repoDir, releasesDir, nmDir, logFile, crashFile, imageDir, imageInputs },
    _wait: async () => { while (job && job.state === 'running') await new Promise((r) => setTimeout(r, 25)); return summary(); },
  };
}
