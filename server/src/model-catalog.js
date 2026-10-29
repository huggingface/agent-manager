// The models each installed CLI offers at launch, for the model select on the
// create form, and the allow-list a chosen model is checked against.
//
// Built in the background after boot (never on a request's path) and kept in
// memory plus a file in STATE_DIR, so a restart has the last lists at once and
// replaces them when the new ones arrive. A CLI whose list cannot be built
// offers no model choice at all — never free text.
//
// Where each list comes from (the CLIs' own commands, run like a session is:
// `bash -lc`, in the server's environment, with a timeout):
//  - claude  : its own `/model` picker, read off the screen (claude-models.js),
//              each name checked against the ids in the installed binary.
//              Redone only when the Claude version changes or on refresh. If
//              the picker cannot be read (not signed in), the aliases.
//  - codex   : `codex debug models` — JSON with each model's effort levels
//  - gemini  : the names bundled in gemini-cli (it has no list command)
//  - opencode: `opencode models` — only providers that have credentials
//  - hermes  : its own provider model cache (~/.hermes/provider_models_cache.json)
// openclaw and fx take no model at launch, so they get no list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CLIS, cliById, STATE_DIR, WORKSPACES_DIR, LAUNCH_MODEL, LAUNCH_EFFORT, cliCatalog } from './config.js';
import { ApiError } from './api-errors.js';
import { scrapeClaudePicker } from './claude-models.js';

const FILE = path.join(STATE_DIR, 'cli-models.json');
const TIMEOUT_MS = 30_000;

// Claude Code takes these as --model and resolves them to the newest model of
// the family, so they lead the list.
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
// gemini-cli 0.66 VALID_GEMINI_MODELS, plus its two "auto" routers.
const GEMINI_MODELS = [
  'auto-gemini-3', 'auto-gemini-2.5',
  'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash',
  'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
];

/** Run a CLI's list command the way a session runs it. Resolves stdout. */
export function runList(command, { timeout = TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-lc', `exec ${command}`], {
      cwd: WORKSPACES_DIR, env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
      timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(new Error(err.killed ? `timed out after ${timeout / 1000}s` : (err.message || 'failed').split('\n')[0])) : resolve(String(stdout))));
  });
}

/** Every `claude-<family>-<major>[-<minor>]` id in some text (the binary). */
export function claudeIdsIn(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/claude-[a-z]+-\d+(?:-\d)?(?![\w.-])/g)) ids.add(m[0]);
  return ids;
}

export function parseCodexModels(stdout) {
  const data = JSON.parse(stdout);
  return (data.models || []).filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({
    id: m.slug,
    label: typeof m.display_name === 'string' ? m.display_name : undefined,
    efforts: (m.supported_reasoning_levels || []).map((l) => l?.effort).filter((e) => typeof e === 'string' && LAUNCH_EFFORT.test(e)),
    defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
  }));
}

/** `opencode models`: one `provider/model` per line. */
export function parseOpencodeModels(stdout) {
  return String(stdout).split('\n').map((l) => l.trim()).filter((l) => /^[^\s/]+\/\S+$/.test(l)).map((id) => ({ id }));
}

/** Hermes' cache: { <provider>: { models: [id | {id}] } } → `<provider>/<id>`. */
export function parseHermesCache(json) {
  const out = [];
  for (const [provider, entry] of Object.entries(json || {})) {
    const models = Array.isArray(entry?.models) ? entry.models : [];
    for (const m of models) {
      const id = typeof m === 'string' ? m : m?.id;
      if (typeof id === 'string' && id) out.push({ id: `${provider}/${id}` });
    }
  }
  return out;
}

const SOURCES = {
  claude: async ({ force, previous }) => {
    const version = /\d+\.\d+\.\d+/.exec(await runList('claude --version'))?.[0] || null;
    if (!force && version && previous?.version === version && previous.picker && previous.models?.length) return previous;
    const aliases = CLAUDE_ALIASES.map((id) => ({ id, label: `${id} (latest)` }));
    // Without a credential the picker never opens (sign-in screens instead),
    // so don't start Claude at all.
    if (!cliCatalog().find((c) => c.id === 'claude')?.ready) {
      return { models: aliases, source: 'aliases (Claude Code is not signed in)', version };
    }
    // Off for test servers (scripts/run-suites.mjs), which run on the real HOME.
    if (process.env.AM_CLAUDE_MODEL_PROBE === '0') return { models: aliases, source: 'aliases (picker probe disabled)', version };
    try {
      const known = claudeIdsIn(await runList(`grep -aoE 'claude-[a-z]+-[0-9][0-9a-z-]{0,12}' "$(readlink -f "$(command -v claude)")"`));
      const probe = path.join(STATE_DIR, 'claude-model-probe');
      fs.mkdirSync(probe, { recursive: true });
      const models = await scrapeClaudePicker({ cwd: probe, known });
      if (!models.length) throw new Error('the picker listed no model this Claude Code knows');
      return { models, source: 'claude /model picker', version, picker: true };
    } catch (e) {
      console.warn(`[model-catalog] claude picker: ${e && e.message}`);
      return { models: aliases, source: `aliases (picker unavailable: ${String(e && e.message || e).slice(0, 120)})`, version };
    }
  },
  codex: async () => ({ models: parseCodexModels(await runList('codex debug models')), source: 'codex debug models' }),
  gemini: async () => ({ models: GEMINI_MODELS.map((id) => ({ id })), source: 'gemini-cli bundle' }),
  opencode: async () => ({ models: parseOpencodeModels(await runList('opencode models')), source: 'opencode models' }),
  hermes: async () => {
    const file = path.join(process.env.HOME || os.homedir(), '.hermes', 'provider_models_cache.json');
    return { models: parseHermesCache(JSON.parse(fs.readFileSync(file, 'utf8'))), source: '~/.hermes/provider_models_cache.json' };
  },
};

let lists = {};
let refreshing = null;

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (saved && typeof saved.clis === 'object') lists = saved.clis;
  } catch { /* first boot, or unreadable: rebuilt in the background */ }
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, clis: lists }, null, 1));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('[model-catalog] persist', e && e.message); }
}

const clean = (models) => {
  const seen = new Set();
  return models.filter((m) => m && LAUNCH_MODEL.test(m.id) && !seen.has(m.id) && seen.add(m.id))
    .map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)));
};

/**
 * Rebuild the lists, one CLI at a time (a small box: no burst of processes).
 * Concurrent callers share the run in flight. A failed CLI keeps its previous
 * list and records why; an empty answer counts as a failure.
 */
export function refreshModelLists({ sources = SOURCES, force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const installed = new Set(cliCatalog().filter((c) => c.available).map((c) => c.id));
    for (const [id, build] of Object.entries(sources)) {
      if (!installed.has(id)) continue;
      const at = new Date().toISOString();
      try {
        const built = await build({ force, previous: lists[id] });
        if (built === lists[id]) continue; // unchanged, e.g. same Claude version
        const kept = clean(built.models);
        if (!kept.length) throw new Error('the CLI listed no models');
        lists[id] = { ...built, models: kept, at };
      } catch (e) {
        lists[id] = { ...(lists[id] || { models: [] }), error: String(e && e.message || e).slice(0, 300), errorAt: at };
        console.warn(`[model-catalog] ${id}: ${lists[id].error}`);
      }
    }
    persist();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Load the saved lists now; rebuild them shortly after boot, off the request path. */
export function startModelCatalog({ delayMs = 5000 } = {}) {
  load();
  const t = setTimeout(() => { refreshModelLists().catch(() => {}); }, delayMs);
  if (t.unref) t.unref();
}

/** For tests: replace the in-memory lists. */
export function setModelLists(next) { lists = next; }

const modelsOf = (id) => (Array.isArray(lists[id]?.models) ? lists[id].models : []);

/** What the create form can offer, per CLI that takes any launch choice. */
export function launchOptions() {
  return {
    refreshing: !!refreshing,
    clis: CLIS.filter((c) => c.launch).map((c) => {
      const entry = lists[c.id] || {};
      const models = c.launch.model ? modelsOf(c.id) : [];
      const perModel = c.launch.efforts === 'per-model';
      return {
        id: c.id,
        model: models.length > 0,
        models,
        // Per-model CLIs (codex) carry their levels on each model; the select
        // follows the chosen one. Otherwise one list for the whole CLI.
        efforts: perModel ? null : (c.launch.efforts || null),
        perModelEfforts: perModel,
        source: entry.source || null,
        at: entry.at || null,
        error: entry.error || null,
      };
    }),
  };
}

const bad = (message) => new ApiError(400, 'invalid-launch-option', message);

/**
 * The model / effort a creation asked for, checked against what this CLI
 * offers now. Empty or absent = the CLI's default. Returns the values to store.
 */
export function checkLaunchChoice(cliId, { model, effort } = {}) {
  const val = (v, field, max) => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string' || v.length > max) throw bad(`${field} must be a string of at most ${max} characters`);
    return v;
  };
  const m = val(model, 'model', 120);
  const e = val(effort, 'effort', 16);
  if (!m && !e) return {};
  const spec = cliById(cliId)?.launch;
  if (!spec) throw bad(`${cliById(cliId)?.label || cliId} takes no model or effort at launch`);
  const models = modelsOf(cliId);
  let chosen = null;
  if (m) {
    if (!spec.model) throw bad(`${cliById(cliId).label} takes no model at launch`);
    chosen = models.find((x) => x.id === m);
    if (!chosen || !LAUNCH_MODEL.test(m)) throw bad(`'${m}' is not a model ${cliById(cliId).label} lists here — see GET /api/launch-options`);
  }
  if (e) {
    if (!spec.efforts) throw bad(`${cliById(cliId).label} takes no reasoning effort at launch`);
    const allowed = spec.efforts !== 'per-model' ? spec.efforts
      : chosen ? (chosen.efforts || [])
        : [...new Set(models.flatMap((x) => x.efforts || []))];
    if (!allowed.includes(e) || !LAUNCH_EFFORT.test(e)) {
      throw bad(`'${e}' is not an effort ${chosen ? chosen.id : cliById(cliId).label} supports${allowed.length ? ` (${allowed.join(', ')})` : ''}`);
    }
  }
  return { ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) };
}
