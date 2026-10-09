// Install the latest release of one CLI without rebuilding the Space, and
// restart the panes that were running the binary it replaced.
//
// Why this can work at all: entrypoint.sh sets NPM_CONFIG_PREFIX to
// $AM_LOCAL/npm and puts $AM_LOCAL/npm/bin ahead of /usr/local/bin on PATH, so
// `npm install -g` writes to a directory this process owns and the new binary
// shadows the image's. Sessions launch their CLI as a bare command resolved
// through PATH at spawn time, so a pane started after an install gets the new
// one — but a pane already running keeps the executable it was exec'd with
// until it exits. Hence the restart: an update that leaves four panes on the
// old version has not changed anything the operator can see.
//
// The restart is the dangerous half, so it is announced before it happens, not
// reported after. `willRestart` answers "what would updating THIS CLI restart,
// and what is it doing right now" — updating Codex restarts the Codex panes and
// nothing else. A `waiting` pane costs nothing to restart; a `working` one loses
// whatever it is mid-way through. The operator decides with that in front of
// them; a working pane makes the confirmation louder, not impossible.
//
// One CLI per run, and one run at a time: `npm install -g` writes into a prefix
// they all share, and two of them at once corrupt it.
//
// What this cannot do: $AM_LOCAL is container disk and is wiped on every Space
// restart, which takes the whole npm prefix with it. An update made here lasts
// until the next restart. The durable half is $DATA_DIR/install.sh, which
// entrypoint.sh runs on each boot — `persistSnippet()` is the line that belongs
// in it. This module does not write that file: it is the operator's, it runs
// blocking at boot behind a 600s timeout, and the installs added to it cost
// that time on every start. Showing the line is help; appending to it is a
// decision that is not ours.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cliUpdatePlan, probeVersion, DATA_DIR } from './config.js';

// One install, not a whole run: npm pulling a large CLI over a slow link is
// normal, npm wedged on a dead registry is not.
const INSTALL_TIMEOUT = 180_000;

const tail = (text, n = 400) => {
  const s = String(text || '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
};

const npm = (args, timeout = 30_000) => new Promise((resolve) => {
  execFile('npm', args, { timeout, maxBuffer: 4 << 20, env: process.env },
    (err, stdout, stderr) => resolve({
      ok: !err,
      // npm says what went wrong on stderr; err.message is usually just the exit
      // code. Prefer the former, and name a timeout as a timeout.
      error: err ? (err.killed ? `timed out after ${Math.round(timeout / 1000)}s` : tail(stderr) || err.message) : null,
    }));
});

// Everything with a side effect sits behind this adapter: panes, PTYs, npm, and
// `<bin> --version`. index.js wires the first two at boot; the defaults are the
// real thing. The seam exists because the part worth testing is the bookkeeping
// — which outcome a version pair means, and what that does or does not restart
// — and none of it should need a registry, a network or a libghostty build.
let deps = {
  /** Running panes for one CLI id: [{ id, name, state }]. */
  panes: () => [],
  /** Stop and start one pane by id; rejects if it could not come back. */
  restart: async () => { throw new Error('restart is not wired'); },
  /** Is npm usable at all — asked once, before the install it would break. */
  preflight: () => npm(['--version']),
  /** Install one package's latest release. */
  install: (pkg) => npm(['install', '-g', `${pkg}@latest`, '--no-fund', '--no-audit'], INSTALL_TIMEOUT),
  /** The version a CLI reports right now, or null if it cannot say. */
  version: (id) => probeVersion(id),
};
export function configureCliUpdate(next) { deps = { ...deps, ...next }; }

/** Last run per CLI id, so updating Codex does not erase what Claude reported. */
const results = new Map();
let runningId = null;

/** Running panes for one CLI, with the state that decides what a restart costs. */
function panesFor(id) {
  try { return deps.panes(id).map((p) => ({ id: p.id, name: p.name, state: p.state })); } catch { return []; }
}

async function restartPanes(item) {
  // The panes named in the warning, not whatever is running now: a pane opened
  // during the install was never on the list the operator agreed to, and it
  // already has the new binary.
  for (const pane of item.frozen) {
    const result = { id: pane.id, name: pane.name, was: pane.state, ok: false, error: null };
    item.restarted.push(result);
    try {
      await deps.restart(pane.id);
      result.ok = true;
    } catch (e) {
      result.error = tail(e?.message, 160) || 'restart failed';
    }
  }
}

async function runOne(item) {
  // One clear answer instead of an ENOENT dressed up as an install failure.
  const probe = await deps.preflight();
  if (!probe.ok) {
    item.state = 'failed';
    item.error = `npm is not usable here: ${probe.error}`;
    return;
  }
  item.state = 'installing';
  item.from = await deps.version(item.id);
  const { ok, error } = await deps.install(item.npm);
  if (!ok) {
    item.state = 'failed';
    item.error = error;
    return;
  }
  item.to = await deps.version(item.id);
  if (!item.to) {
    // npm reported success and the binary still will not say its version. That
    // is a broken install, and calling it "updated" would hide it.
    item.state = 'failed';
    item.error = `npm installed ${item.npm}, but \`${item.bin} --version\` did not answer`;
    return;
  }
  if (item.from && item.from === item.to) {
    // Nothing moved, so nothing is stale — restarting panes here would cost the
    // operator work for no change at all.
    item.state = 'current';
    item.frozen = [];
    return;
  }
  // When the new binary landed. A pane that started before this is on the old
  // one; a pane that started after — including one restarted below — is not.
  item.installedAt = Date.now();
  item.state = item.from ? 'updated' : 'installed';
  if (item.frozen.length) {
    item.state = 'restarting';
    await restartPanes(item);
    item.state = item.from ? 'updated' : 'installed';
  }
}

/**
 * Start a run for one CLI. Returns a reason string when it cannot start, so the
 * route can answer with something more useful than false.
 */
export function startCliUpdate(id) {
  if (runningId) return runningId === id ? 'already-running' : 'busy';
  const target = cliUpdatePlan().targets.find((t) => t.id === id);
  if (!target) return 'not-updatable';
  const item = {
    ...target,
    state: 'pending',
    from: null,
    to: null,
    error: null,
    installedAt: null,
    startedAt: Date.now(),
    finishedAt: null,
    // Frozen here: this is the list the warning showed, and it is the list that
    // gets restarted. Recomputing it later would restart panes nobody was
    // warned about.
    frozen: panesFor(id),
    restarted: [],
  };
  results.set(id, item);
  runningId = id;
  // Deliberately not awaited: `npm install -g` is tens of seconds and the
  // request answers now. The client polls GET for progress.
  runOne(item)
    .catch((e) => { item.state = 'failed'; item.error = tail(e?.message); })
    .finally(() => { item.finishedAt = Date.now(); runningId = null; });
  return null;
}

/** The line that makes these updates survive a Space restart. */
export function persistSnippet() {
  const { targets } = cliUpdatePlan();
  return `npm install -g ${targets.map((t) => `${t.npm}@latest`).join(' ')}`;
}

const publicItem = (item) => {
  const { frozen, ...rest } = item;
  return { ...rest, restarted: [...item.restarted] };
};

export function cliUpdateStatus() {
  const { targets, excluded } = cliUpdatePlan();
  return {
    runningId,
    // Where the installs land. Absent outside the Space image, which means
    // `npm install -g` would be writing somewhere root owns — worth showing.
    prefix: process.env.NPM_CONFIG_PREFIX || null,
    installScript: path.join(DATA_DIR, 'install.sh'),
    persistSnippet: persistSnippet(),
    excluded,
    items: targets.map((t) => {
      const item = results.get(t.id);
      return {
        ...(item ? publicItem(item) : {
          ...t, state: 'idle', from: null, to: null, error: null,
          installedAt: null, startedAt: null, finishedAt: null, restarted: [],
        }),
        // Always live: what updating this CLI would restart if pressed now.
        // During its own run that is the frozen list, which is the same thing
        // the confirmation showed.
        willRestart: runningId === t.id ? [...(item?.frozen || [])] : panesFor(t.id),
      };
    }),
  };
}

/** Tests only: forget every run so each case starts from idle. */
export function resetCliUpdate() { results.clear(); runningId = null; }
