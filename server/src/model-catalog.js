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
//              Redone only when the Claude version changes or on refresh,
//              whether it worked or not. If the picker cannot be read (not
//              signed in), the aliases. Only a server started with
//              AM_CLAUDE_MODEL_PROBE=1 reads it (the Docker entrypoint does):
//              it starts the operator's signed-in Claude, which a test or dev
//              server must not do. Sessions never inherit the variable.
//  - codex   : `codex debug models` — JSON with each model's effort levels
//  - gemini  : the VALID_GEMINI_MODELS registry in the installed gemini-cli
//              bundle (it has no list command)
//  - opencode: `opencode models` — only providers that have credentials
//  - hermes  : its own provider model cache (~/.hermes/provider_models_cache.json)
// openclaw and fx take no model at launch, so they get no list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLIS, cliById, STATE_DIR, WORKSPACES_DIR, LAUNCH_MODEL, LAUNCH_EFFORT, cliCatalog } from './config.js';
import { ApiError } from './api-errors.js';
import { scrapeClaudePicker, killGroup, CLAUDE_FAMILIES } from './claude-models.js';

const FILE = path.join(STATE_DIR, 'cli-models.json');
const TIMEOUT_MS = 30_000;

const MAX_OUTPUT = 64 * 1024 * 1024;

/** Whether this server may start Claude Code to read its picker. */
export const claudeProbeEnabled = (env = process.env) => env.AM_CLAUDE_MODEL_PROBE === '1';

/**
 * Run a CLI's list command the way a session runs it. Resolves stdout. It runs
 * in its own process group, and the whole group is killed once the command
 * exits or times out, so nothing it started outlives the call.
 */
export function runList(command, { timeout = TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', `exec ${command}`], {
      cwd: WORKSPACES_DIR, env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let size = 0, failure = null, status = null;
    const sweep = () => { killGroup(child.pid, { graceMs: 0 }).catch(() => {}); };
    const timer = setTimeout(() => { failure ??= `timed out after ${timeout / 1000}s`; sweep(); }, timeout);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUTPUT) { failure ??= 'too much output'; sweep(); } else out.push(d);
    });
    child.stderr.resume();
    child.on('error', (e) => { failure ??= e.message; });
    // Whatever it left behind (still holding the pipes, or not) goes with it.
    child.on('exit', (code, signal) => { status = { code, signal }; setTimeout(sweep, 100); });
    child.on('close', async () => {
      clearTimeout(timer);
      await killGroup(child.pid, { graceMs: 0 });
      if (!failure && status?.code !== 0) failure = `exited with ${status?.signal || status?.code}`;
      if (failure) reject(new Error(failure)); else resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

/**
 * gemini-cli's VALID_GEMINI_MODELS set, from its bundled source: each name in
 * the set is a `var NAME = "id"` (or an alias of another one) in the same file.
 * Also its two "auto" routers, which `-m` takes as well.
 */
export function parseGeminiRegistry(text) {
  const set = /VALID_GEMINI_MODELS\s*=\s*(?:\/\*[^*]*\*\/\s*)?new Set\(\[([^\]]*)\]\)/.exec(text);
  if (!set) return [];
  const resolve = (expr, depth = 0) => {
    const e = expr.trim();
    const lit = /^["'`]([^"'`]+)["'`]$/.exec(e);
    if (lit) return lit[1];
    if (depth > 5 || !/^[A-Za-z_$][\w$]*$/.test(e)) return null;
    const def = new RegExp(`(?:var|let|const)\\s+${e.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`).exec(text);
    return def ? resolve(def[1], depth + 1) : null;
  };
  const names = [...set[1].split(','), 'PREVIEW_GEMINI_MODEL_AUTO', 'DEFAULT_GEMINI_MODEL_AUTO'];
  return [...new Set(names.map((n) => resolve(n)).filter((id) => id && /^(?:gemini|gemma|auto)-[a-z0-9.-]+$/.test(id)))];
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

/**
 * The Claude list source. Its moving parts are injectable so a test can count
 * how often the picker would be started.
 */
export function claudeSource({
  version = async () => /\d+\.\d+\.\d+/.exec(await runList('claude --version'))?.[0] || null,
  ready = () => !!cliCatalog().find((c) => c.id === 'claude')?.ready,
  probeEnabled = () => claudeProbeEnabled(),
  known = async () => claudeIdsIn(await runList(`grep -aoE 'claude-[a-z]+-[0-9][0-9a-z-]{0,12}' "$(readlink -f "$(command -v claude)")"`)),
  scrape = (opts) => {
    const cwd = path.join(STATE_DIR, 'claude-model-probe');
    fs.mkdirSync(cwd, { recursive: true });
    return scrapeClaudePicker({ ...opts, cwd });
  },
} = {}) {
  return async ({ force, previous }) => {
    const v = await version();
    // Once per version: a probe that failed is not retried on every boot, only
    // when Claude Code changes or on an explicit refresh.
    if (!force && v && previous?.version === v && previous.probed && previous.models?.length) return previous;
    const aliases = CLAUDE_FAMILIES.map((id) => ({ id, label: `${id} (latest)` }));
    // Without a credential the picker never opens (sign-in screens instead),
    // so don't start Claude at all. Not `probed`: a sign-in later is tried.
    if (!ready()) return { models: aliases, source: 'aliases (Claude Code is not signed in)', version: v };
    if (!probeEnabled()) return { models: aliases, source: 'aliases (picker probe off: AM_CLAUDE_MODEL_PROBE is not 1)', version: v };
    try {
      const models = await scrape({ known: await known() });
      if (!models.length) throw new Error('the picker listed no model this Claude Code knows');
      return { models, source: 'claude /model picker', version: v, picker: true, probed: true };
    } catch (e) {
      console.warn(`[model-catalog] claude picker: ${e && e.message}`);
      return { models: aliases, source: `aliases (picker unavailable: ${String(e && e.message || e).slice(0, 120)})`, version: v, probed: true };
    }
  };
}

const SOURCES = {
  claude: claudeSource(),
  codex: async () => ({ models: parseCodexModels(await runList('codex debug models')), source: 'codex debug models' }),
  gemini: async () => {
    const file = (await runList(`grep -l 'VALID_GEMINI_MODELS *=' "$(dirname "$(readlink -f "$(command -v gemini)")")"/*.js`)).split('\n')[0].trim();
    const models = parseGeminiRegistry(await fs.promises.readFile(file, 'utf8')).map((id) => ({ id }));
    return { models, source: `gemini-cli bundle (${path.basename(file)})` };
  },
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
