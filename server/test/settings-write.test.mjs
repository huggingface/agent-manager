// Saving settings: what the answer means, and who is allowed to replace what.
//
// Settings are written on every change now, so these two files are rewritten
// constantly, from more than one tab, while agents read what is derived from
// them. Four things follow, and each one is a way work disappears when it is
// missing. The write has to be atomic — a half-written am-config.json reads back
// as "no settings at all", which is every setting reverting at once. The answer
// has to be true: a save that did not happen must not come back as ok. A writer
// has to say which version it is replacing, or two tabs quietly overwrite each
// other's unrelated fields. And a file we cannot read is not permission to
// replace it with defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nativeFetch as fetch } from './native-client.mjs';

const PORT = 7906;
const API = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-write-'));
const CONFIG = path.join(DATA_DIR, 'am-config.json');
const NOTES = path.join(DATA_DIR, 'secret-notes.json');
const ENV_SKILL = path.join(DATA_DIR, 'workspaces', 'skills', 'environment.md');

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRoot = !!(process.getuid && process.getuid() === 0);

// SPACE_ID and AM_DISTRIBUTE_SKILLS are dropped on purpose: with either set, a
// generated skill is fanned out into the real ~/.claude of whoever runs this.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
// The generated skill only lists environment variables the server considers
// injected. Rather than depend on whatever credentials happen to be in the
// ambient environment — the suite must say the same thing on a laptop with none
// — it supplies one of its own with a value nothing reads.
const PROBE_KEY = 'SETTINGS_WRITE_PROBE_KEY';
const server = spawn('node', ['src/index.js'], {
  env: {
    ...BASE_ENV,
    [PROBE_KEY]: 'unused-by-anything',
    PORT: String(PORT), DATA_DIR, HOME: path.join(DATA_DIR, 'home'),
    CLAUDE_CONFIG_DIR: path.join(DATA_DIR, 'home', '.claude'),
    AM_BASHRC: '/nonexistent',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });

const api = async (route, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('x-am-origin', 'operator');
  const response = await fetch(`${API}${route}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};
const putConfig = (value, base) => api(`/api/config${base ? `?base=${encodeURIComponent(base)}` : ''}`,
  { method: 'PUT', body: JSON.stringify(value) });
const putNotes = (notes, base) => api(`/api/secrets${base ? `?base=${encodeURIComponent(base)}` : ''}`,
  { method: 'PUT', body: JSON.stringify({ notes }) });
const until = async (fn, ms = 4000) => {
  for (let i = 0; i * 50 < ms; i++) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const CONFIG_A = {
  artifacts: { enabled: true, space: '  someone/pages  ', visibility: 'public' },
  jobs: { askAboveUsd: 12 },
  archive: { after: 'week' },
  revive: { enabled: false, days: 7 },
  backup: { every: 'never', dataset: '', exclude: [] },
};

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }

  // ---- what the response says was saved ----
  const first = await putConfig(CONFIG_A, null);
  check('a first save needs no revision — there is nothing to replace',
    first.status === 200 && first.body?.artifacts?.space === 'someone/pages'
      && first.body?.jobs?.askAboveUsd === 12,
    `status ${first.status}`);
  check('and answers with the revision it committed', typeof first.body?.rev === 'string' && first.body.rev.length > 0);
  const read = await api('/api/config');
  check('reading it back agrees, revision included', read.body?.archive?.after === 'week'
    && read.body?.artifacts?.visibility === 'public' && read.body?.revive?.enabled === false
    && read.body?.rev === first.body.rev,
    JSON.stringify({ rev: read.body?.rev }));
  check('the file it was written to is whole JSON, not a fragment',
    JSON.parse(fs.readFileSync(CONFIG, 'utf8')).jobs.askAboveUsd === 12);
  check('and nothing is left behind beside it',
    !fs.readdirSync(DATA_DIR).some((f) => f.includes('am-tmp')), fs.readdirSync(DATA_DIR).join(','));

  // ---- two writers, and the one that did not look first ----
  const rev0 = read.body.rev;
  const blind = await putConfig({ ...CONFIG_A, jobs: { askAboveUsd: 3 } }, null);
  check('replacing settings that exist without saying which version is refused',
    blind.status === 409 && blind.body?.code === 'base-required', `status ${blind.status} ${JSON.stringify(blind.body?.code)}`);

  // Tab A and tab B both read rev0. A saves an artifacts Space; B, still holding
  // rev0, saves a Jobs threshold — carrying its own stale copy of every other
  // field with it.
  const tabA = await putConfig({ ...CONFIG_A, artifacts: { ...CONFIG_A.artifacts, space: 'someone/newer' } }, rev0);
  check('the first of two tabs commits', tabA.status === 200 && tabA.body?.artifacts?.space === 'someone/newer');
  const tabB = await putConfig({ ...CONFIG_A, jobs: { askAboveUsd: 99 } }, rev0);
  check('the second, still holding the old revision, is refused',
    tabB.status === 409 && tabB.body?.code === 'stale', `status ${tabB.status} ${JSON.stringify(tabB.body?.code)}`);
  check('and is told what is actually stored, so it can reconcile',
    tabB.body?.rev === tabA.body?.rev && tabB.body?.value?.artifacts?.space === 'someone/newer',
    JSON.stringify(tabB.body?.value?.artifacts));
  const afterRace = await api('/api/config');
  check('the first tab\'s change is still there — nothing was silently erased',
    afterRace.body?.artifacts?.space === 'someone/newer' && afterRace.body?.jobs?.askAboveUsd === 12,
    JSON.stringify({ space: afterRace.body?.artifacts?.space, usd: afterRace.body?.jobs?.askAboveUsd }));
  const reconciled = await putConfig({ ...CONFIG_A, artifacts: { ...CONFIG_A.artifacts, space: 'someone/newer' }, jobs: { askAboveUsd: 99 } }, afterRace.body.rev);
  check('and the refused writer succeeds once it replaces the version it was told about',
    reconciled.status === 200 && reconciled.body?.jobs?.askAboveUsd === 99);

  // ---- a write that cannot happen is not a save ----
  const before = fs.readFileSync(CONFIG, 'utf8');
  // A read-only directory and a read-only file: no temp file can be made beside
  // the target and no in-place write can land on it either, which is what a full
  // disk or a wedged mount looks like from here. Root ignores both modes.
  if (isRoot) {
    console.log('SKIP  write-failure checks (running as root: the modes would not stop a write)');
  } else {
    fs.chmodSync(CONFIG, 0o444);
    fs.chmodSync(DATA_DIR, 0o555);
    const refused = await putConfig({ ...CONFIG_A, jobs: { askAboveUsd: 42 } }, reconciled.body.rev);
    fs.chmodSync(DATA_DIR, 0o755);
    fs.chmodSync(CONFIG, 0o644);
    check('a failed write is answered as a failure, not as ok',
      refused.status === 500 && !refused.body?.ok && typeof refused.body?.error === 'string',
      `status ${refused.status} ${JSON.stringify(refused.body).slice(0, 100)}`);
    check('with something the operator can read',
      /could not save settings/.test(refused.body?.error || ''), refused.body?.error);
    check('the settings that were there are whole and untouched',
      fs.readFileSync(CONFIG, 'utf8') === before);
    check('and no half-written file is left beside them',
      !fs.readdirSync(DATA_DIR).some((f) => f.includes('am-tmp')), fs.readdirSync(DATA_DIR).join(','));
    // The contract, stated as the thing that goes wrong when it is broken: a
    // save that answered ok must be there on the next load. Answering ok for a
    // write that did not happen is how a setting reverts with nothing on screen
    // to say so.
    const still = await api('/api/config');
    check('a save that said ok is still there when the settings are read again',
      refused.body?.ok !== true || still.body?.jobs?.askAboveUsd === 42,
      `answered ${JSON.stringify(refused.body?.ok)}, reads back ${still.body?.jobs?.askAboveUsd}`);
  }

  // ---- a file we cannot read is not permission to replace it ----
  const damaged = '{ "artifacts": { "space": "someone/hand-written" }, oops\n';
  fs.writeFileSync(CONFIG, damaged);
  const damagedRead = await api('/api/config');
  check('a damaged settings file is reported on the read, not silently defaulted over',
    damagedRead.status === 200 && /not valid JSON/.test(damagedRead.body?.readError || ''),
    JSON.stringify(damagedRead.body?.readError));
  const overDamaged = await putConfig({ ...CONFIG_A, jobs: { askAboveUsd: 7 } }, damagedRead.body?.rev || null);
  check('and an ordinary edit does not get to overwrite it',
    overDamaged.status === 409 && overDamaged.body?.code === 'unreadable',
    `status ${overDamaged.status} ${JSON.stringify(overDamaged.body?.code)}`);
  check('the bytes that were there are still there',
    fs.readFileSync(CONFIG, 'utf8') === damaged);
  fs.writeFileSync(CONFIG, before);

  // ---- descriptions, and the skill derived from them ----
  const notesOne = await putNotes({ [PROBE_KEY]: 'mark-a' }, null);
  check('descriptions save the same way', notesOne.status === 200 && notesOne.body?.notes?.[PROBE_KEY] === 'mark-a'
    && typeof notesOne.body?.rev === 'string');
  check('and land as whole JSON', JSON.parse(fs.readFileSync(NOTES, 'utf8'))[PROBE_KEY] === 'mark-a');
  const staleNotes = await putNotes({ [PROBE_KEY]: 'mark-x' }, 'not-the-revision');
  check('a description written against a revision that has moved on is refused',
    staleNotes.status === 409 && staleNotes.body?.code === 'stale');

  // The generated skill is derived state: it is rebuilt after the response, and
  // what it must never do is settle on a value that has been replaced. Markers,
  // not prose: the skill is full of English, and "first" appearing in it would
  // prove nothing either way.
  let rev = notesOne.body.rev;
  for (const value of ['mark-b', 'mark-c', 'mark-d', 'mark-e']) {
    const r = await putNotes({ [PROBE_KEY]: value }, rev);
    rev = r.body?.rev || rev;
  }
  const detected = (await api('/api/secrets')).body?.detected || [];
  check('the probe variable is detected, so the generated skill has something to describe',
    detected.includes(PROBE_KEY), detected.length ? `${detected.length} detected` : 'none detected');
  const settled = await until(() => {
    try { return /mark-e/.test(fs.readFileSync(ENV_SKILL, 'utf8')); } catch { return false; }
  });
  check('a burst of saves leaves the generated skill on the last one', settled);
  check('and not on one it overtook', !/mark-[bcd]/.test(fs.readFileSync(ENV_SKILL, 'utf8')));
  const converged = await api('/api/config');
  check('with nothing reported as pending or failed once it has converged',
    converged.body?.derived?.pending === false && converged.body?.derived?.error === null,
    JSON.stringify(converged.body?.derived));

  // ---- a payload the writer accepts and the reader then refuses ----
  const notesBefore = fs.readFileSync(NOTES, 'utf8');
  const notesRev = (await api('/api/secrets')).body.rev;
  const asArray = await api(`/api/secrets?base=${encodeURIComponent(notesRev)}`,
    { method: 'PUT', body: JSON.stringify({ notes: [] }) });
  check('an array is not an object of descriptions, and is refused',
    asArray.status === 400 && asArray.body?.code === 'invalid',
    `status ${asArray.status} ${JSON.stringify(asArray.body?.error)}`);
  const asNumbers = await api(`/api/secrets?base=${encodeURIComponent(notesRev)}`,
    { method: 'PUT', body: JSON.stringify({ notes: { [PROBE_KEY]: 42 } }) });
  check('and neither is a description that is not text', asNumbers.status === 400);
  check('the descriptions that were there are untouched',
    fs.readFileSync(NOTES, 'utf8') === notesBefore);
  const readsBack = await api('/api/secrets');
  check('so the file still reads, and ordinary saves still work',
    !readsBack.body?.readError && readsBack.body?.rev === notesRev,
    JSON.stringify(readsBack.body?.readError));
  const ordinary = await putNotes({ [PROBE_KEY]: 'mark-ok' }, readsBack.body.rev);
  check('proved by making one', ordinary.status === 200 && ordinary.body?.notes?.[PROBE_KEY] === 'mark-ok');
  rev = ordinary.body.rev;
  const configArray = await api('/api/config', { method: 'PUT', body: JSON.stringify([]) });
  check('a settings body that is not an object is refused rather than normalized to defaults',
    configArray.status === 400, `status ${configArray.status}`);

  // ---- the derived outcome, asked for on its own ----
  const derivedNow = await api('/api/settings/derived');
  check('the derived outcome can be read without sending the settings again',
    derivedNow.status === 200 && typeof derivedNow.body?.pending === 'boolean'
      && 'error' in (derivedNow.body || {}),
    JSON.stringify(derivedNow.body));

  // ---- "saved" and "the agents have been told" are different states ----
  if (isRoot) {
    console.log('SKIP  derived-failure checks (running as root: the mode would not stop a write)');
  } else {
    fs.chmodSync(ENV_SKILL, 0o444);
    fs.chmodSync(path.dirname(ENV_SKILL), 0o555);
    const savedAnyway = await putNotes({ [PROBE_KEY]: 'mark-f' }, rev);
    check('a settings save still succeeds when the derived update cannot be written',
      savedAnyway.status === 200 && savedAnyway.body?.ok === true, `status ${savedAnyway.status}`);
    check('and the file it was asked to save really is saved',
      JSON.parse(fs.readFileSync(NOTES, 'utf8'))[PROBE_KEY] === 'mark-f');
    const reported = await until(async () => !!(await api('/api/settings/derived')).body?.error);
    const derived = (await api('/api/settings/derived')).body;
    check('but the derived failure is reported, not swallowed into a fully applied state',
      reported && /permission denied|EACCES/i.test(derived?.error || ''), JSON.stringify(derived));
    fs.chmodSync(path.dirname(ENV_SKILL), 0o755);
    fs.chmodSync(ENV_SKILL, 0o644);
    rev = savedAnyway.body.rev;
    const retried = await putNotes({ [PROBE_KEY]: 'mark-g' }, rev);
    const cleared = await until(async () => (await api('/api/settings/derived')).body?.error === null);
    check('and it clears once a later save gets the derived update through',
      retried.status === 200 && cleared, JSON.stringify((await api('/api/settings/derived')).body));
    check('with the skill on the newest description', /mark-g/.test(fs.readFileSync(ENV_SKILL, 'utf8')));
  }
} catch (error) {
  check(`suite threw: ${error && error.message}`, false, log.slice(-1200));
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(3000)]);
  try { fs.chmodSync(DATA_DIR, 0o755); } catch {}
  try { fs.chmodSync(path.dirname(ENV_SKILL), 0o755); } catch {}
  // The server may still be flushing state under HOME as it goes down, which
  // makes the first sweep of a temp dir race it. Tidying up is not the test.
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { await sleep(100); }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
