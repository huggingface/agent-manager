// Install the latest CLIs without rebuilding the Space, and restart the panes
// that were running the binary we just replaced.
//
// Why this can work at all: entrypoint.sh sets NPM_CONFIG_PREFIX to
// $AM_LOCAL/npm and puts $AM_LOCAL/npm/bin ahead of /usr/local/bin on PATH, so
// `npm install -g` writes to a directory this process owns and the new binary
// shadows the image's. Sessions launch their CLI as a bare command resolved
// through PATH at spawn time, so a pane started after an install gets the new
// one — but a pane already running keeps the executable it was exec'd with
// until it exits. Hence the restart: a button that leaves four panes on the old
// version has not updated anything the operator can see.
//
// The restart is the dangerous half, so it is announced before it happens, not
// reported after. `cliUpdatePreview()` answers "what will this restart, and what is it
// doing right now" — by name and by state, per CLI, because updating Codex
// restarts the Codex panes and nothing else. A `waiting` pane costs nothing to
// restart; a `working` one loses whatever it is mid-way through. The operator
// decides with that in front of them; a working pane makes the confirmation
// louder, not impossible.
//
// What this cannot do: $AM_LOCAL is container disk and is wiped on every Space
// restart, which takes the whole npm prefix with it. An update made here lasts
// until the next restart. The durable half is $DATA_DIR/install.sh, which
// entrypoint.sh runs on each boot — `persistSnippet()` is the line that belongs
// in it. This module does not write that file: it is the operator's, it runs
// blocking at boot behind a 600s timeout, and five npm installs added to it are
// a minute on every start. Showing the line is help; appending to it is a
// decision that is not ours.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cliUpdatePlan, probeVersion, DATA_DIR } from './config.js';

// One install, not the whole run: npm pulling a large CLI over a slow link is
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
  /** Is npm usable at all — one answer instead of the same ENOENT per package. */
  preflight: () => npm(['--version']),
  /** Install one package's latest release. */
  install: (pkg) => npm(['install', '-g', `${pkg}@latest`, '--no-fund', '--no-audit'], INSTALL_TIMEOUT),
  /** The version a CLI reports right now, or null if it cannot say. */
  version: (id) => probeVersion(id),
};
export function configureCliUpdate(next) { deps = { ...deps, ...next }; }

/** Last run, alive or finished. One at a time — npm's global prefix is shared. */
let current = null;

async function restartPanes(item) {
  // The panes named in the warning, not whatever is running now: a pane opened
  // during the install was never on the list the operator agreed to, and it
  // already has the new binary.
  for (const pane of item.sessions) {
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

async function installOne(item) {
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
    item.sessions = [];
    return;
  }
  // When the new binary landed. A pane that started before this is on the old
  // one; a pane that started after — including one we restarted below — is not.
  item.installedAt = Date.now();
  item.state = item.from ? 'updated' : 'installed';
  if (item.sessions.length) {
    item.state = 'restarting';
    await restartPanes(item);
    item.state = item.from ? 'updated' : 'installed';
  }
}

async function runAll(run) {
  // One preflight instead of the same ENOENT five times over.
  const probe = await deps.preflight();
  if (!probe.ok) {
    for (const item of run.items) { item.state = 'failed'; item.error = `npm is not usable here: ${probe.error}`; }
  } else {
    for (const item of run.items) {
      try { await installOne(item); } catch (e) { item.state = 'failed'; item.error = tail(e?.message); }
    }
  }
  run.running = false;
  run.finishedAt = Date.now();
}

/** Running panes per CLI, with the state that decides how much a restart costs. */
function panesFor(id) {
  try { return deps.panes(id).map((p) => ({ id: p.id, name: p.name, state: p.state })); } catch { return []; }
}

/**
 * What pressing the button would do, as a question the operator can answer:
 * which CLIs get installed, and which panes that restarts — by name, with what
 * each one is doing right now.
 */
export function cliUpdatePreview() {
  const { targets, excluded } = cliUpdatePlan();
  const items = targets.map((t) => ({ ...t, sessions: panesFor(t.id) }));
  const sessions = items.flatMap((i) => i.sessions);
  return {
    items,
    excluded,
    restarts: sessions.length,
    working: sessions.filter((s) => s.state === 'working').length,
  };
}

/**
 * Start a run. Returns false if one is already going — the caller answers 409
 * rather than letting two npm processes fight over the same prefix.
 */
export function startCliUpdate() {
  if (current?.running) return false;
  const { targets } = cliUpdatePlan();
  current = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    items: targets.map((t) => ({
      ...t,
      state: 'pending',
      from: null,
      to: null,
      error: null,
      installedAt: null,
      // Frozen here: this is the list the warning showed, and it is the list
      // that gets restarted. Recomputing it later would restart panes nobody
      // was warned about.
      sessions: panesFor(t.id),
      restarted: [],
    })),
  };
  // Deliberately not awaited: `npm install -g` is tens of seconds per package
  // and the request answers now. The client polls GET for progress.
  runAll(current);
  return true;
}

/** The line that makes an update survive a Space restart. */
export function persistSnippet() {
  const { targets } = cliUpdatePlan();
  return `npm install -g ${targets.map((t) => `${t.npm}@latest`).join(' ')}`;
}

export function cliUpdateStatus() {
  const preview = cliUpdatePreview();
  return {
    running: !!current?.running,
    startedAt: current?.startedAt ?? null,
    finishedAt: current?.finishedAt ?? null,
    // Where the installs land. Absent outside the Space image, which means
    // `npm install -g` would be writing somewhere root owns — worth showing.
    prefix: process.env.NPM_CONFIG_PREFIX || null,
    installScript: path.join(DATA_DIR, 'install.sh'),
    persistSnippet: persistSnippet(),
    excluded: preview.excluded,
    // Idle: what a run would do. Running or finished: what it did.
    items: current
      ? current.items.map((i) => ({ ...i, sessions: [...i.sessions], restarted: [...i.restarted] }))
      : preview.items.map((i) => ({ ...i, state: 'idle', from: null, to: null, error: null, installedAt: null, restarted: [] })),
  };
}

/** Tests only: forget the run so each case starts from idle. */
export function resetCliUpdate() { current = null; }
