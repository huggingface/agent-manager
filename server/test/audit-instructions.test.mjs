// The environment skill is generated at boot and read-only, so the only way to
// pin what it tells every agent is to render it. Boot the server in an isolated
// data/home tree and assert on the output: its privacy claims, so they cannot
// drift from the API-log documentation again, and the rule that a dispatched
// task is still the dispatcher's — which is asserted PER SECTION, because that
// rule failed by being true in the wrong place. It was stated once under
// "Watch instead of asking", several screens above every way of handing work
// over, so an agent reading the send instructions never met it.
//
// Run with: node test/audit-instructions.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-audit-instructions-'));
const dataDir = path.join(TMP, 'data');
const homeDir = path.join(TMP, 'home');
const generated = path.join(dataDir, 'workspaces', 'skills', 'environment.md');
fs.mkdirSync(homeDir, { recursive: true });
// An artifacts Space, so the publishing section is rendered (SPACE_ID, which
// would otherwise name a default one, is deleted below).
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'am-config.json'),
  JSON.stringify({ artifacts: { enabled: true, space: 'someone/pages', visibility: 'private' } }));

// Do not let a local test child inherit actual configured credential values.
// The request policy validates PORT at startup (#130), so an ephemeral 0 is refused.
const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const env = { ...process.env, DATA_DIR: dataDir, HOME: homeDir, PORT: String(port), AM_BASHRC: '/nonexistent' };
for (const key of Object.keys(env)) {
  if (/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
}
delete env.SPACE_ID;
delete env.AM_DISTRIBUTE_SKILLS;
env.AUDIT_TEST_SECRET = 'synthetic-configured-value';

const server = spawn(process.execPath, ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let second = null;   // the boot with artifacts disabled, below
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });

try {
  // The normal suite runner starts this immediately after filesystem-heavy
  // integration tests; allow a cold server boot without making the assertion
  // depend on host load. The loop still exits as soon as generation completes.
  for (let i = 0; i < 600 && !fs.existsSync(generated); i++) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}: ${output.slice(-2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(generated), `environment skill was not generated: ${output.slice(-300)}`);
  const text = fs.readFileSync(generated, 'utf8');
  assert.match(text, /full non-secret prompt, file and response content/);
  assert.match(text, /best-effort filtering for recognizable credentials/);
  assert.match(text, /remains sensitive and private/);
  assert.match(text, /deleting a source does not delete its audit copy/);
  assert.match(text, /older records were not rewritten/);
  assert.doesNotMatch(text, /prompt and file contents are hashed rather than copied/);

  // Everything from `### <heading>` up to the next heading at the same level or
  // higher. Asserting against the whole file would pass on a rule that sits
  // anywhere, which is the bug.
  const section = (heading) => {
    const start = text.indexOf(`\n${heading}`);
    assert.ok(start >= 0, `the generated skill has no "${heading}" section`);
    const rest = text.slice(start + heading.length + 1);
    const depth = heading.match(/^#+/)[0].length;
    const next = rest.search(new RegExp(`\\n#{1,${depth}} `));
    return next < 0 ? rest : rest.slice(0, next);
  };

  // Sending a prompt is the common dispatch: the rule lives here in full.
  // (#191 split "Send an agent a prompt" into a durable delegation section and
  // this one; the rule still has to be where the plain send is described.)
  const send = section('### Send an ordinary message');
  assert.match(send, /A task you hand over is still yours/);
  assert.match(send, /start the background `wait` loop/);
  assert.match(send, /`tail` it and act on what it actually produced/);
  assert.match(send, /not finished when the prompt is sent/);
  assert.match(send, /Never report work as done that you only delegated/);

  // Launching an agent and spawning into a group are dispatches too — each one
  // has to arm the watch where it happens, not leave it to a section the reader
  // may never reach.
  const launch = section('### Launch a new agent');
  assert.match(launch, /it is a\s+dispatch and the rule under \*\*Send an ordinary message\*\* applies/);
  assert.match(launch, /start the background `wait` loop right\s+then/);
  assert.match(launch, /read its screen before you\s+call the job done/);
  assert.match(launch, /arming each\s+one's watch as you go/, 'spawning into a group arms a watch per agent');

  // A remote agent has no pane to tail, so its result has to be named instead.
  const remote = section('## Remote agents');
  assert.match(remote, /a task handed to one is still yours/);
  assert.match(remote, /no result until you have read it there/);

  // `wait` answering is not the work succeeding. A CLI that rejects its own
  // flags returns to its input box and reports `waiting`, which is why the
  // state alone must never be read as a result.
  const watch = section('### Observe a peer without requesting a callback');
  assert.match(watch, /`matched` means the agent STOPPED, not that it succeeded/);
  assert.match(watch, /Read `tail` afterwards and judge the\s+work, not the state/);
  assert.doesNotMatch(watch, /`matched: true`\s+is finished/);
  assert.match(watch, /start the\s+background `wait` loop below/);
  // Every API call in the generated text goes to the address the manager is
  // bound to — a hardcoded localhost answers nothing on a local install bound
  // elsewhere (#191 had one in the delegation snippet).
  assert.doesNotMatch(text, /localhost:/, 'no generated snippet hardcodes localhost');
  // …and the delegation command keeps its line continuations (a lone `\` in
  // the template literal is eaten, joining the command into one line).
  assert.match(section('### Delegate with a durable completion reply'),
    /curl -sS --fail-with-body -H 'X-AM-Request: 1' -X POST \\\n  "http:\/\/\$\{AM_HOST:-[^}]+\}:\$\{AM_PORT:-\d+\}\/api\/agents\/\$ID\/prompt\?from=\$AM_ID" \\\n/);

  // Artifact links go through the Hub page, whatever the visibility: a direct
  // *.static.hf.space link to a private Space only works right after visiting
  // its hf.co page. The Hub hands only ?query and #hash to the static site, so
  // a page is ?p=<name>.html and the index carries the router that opens it —
  // byte for byte the operator's snippet, which forwards nothing else.
  const artifacts = section('## Publishing results as web pages (artifacts)');
  assert.match(artifacts, /`https:\/\/huggingface\.co\/spaces\/someone\/pages\?p=<name>\.html`/);
  assert.doesNotMatch(artifacts, /https:\/\/[^\s`]*static\.hf\.space/, 'no page is linked on the static host');
  const router = [
    '<script>',
    '// Deep links through the Hub page: huggingface.co/spaces/<owner>/<space>?p=<page>.html',
    '(function () {',
    "  var p = new URLSearchParams(location.search).get('p');",
    "  if (p && /^[A-Za-z0-9][A-Za-z0-9._-]*(\\/[A-Za-z0-9][A-Za-z0-9._-]*)*\\.(html|png|svg|csv|json|md)$/.test(p) && p.indexOf('..') < 0) {",
    '    location.replace(p + location.hash);',
    '  }',
    '})();',
    '</script>',
  ];
  const fenced = artifacts.match(/```html\n([\s\S]*?)\n\s*```/);
  assert.ok(fenced, 'the index instruction carries the router as an html block');
  assert.deepEqual(fenced[1].split('\n').map((line) => line.replace(/^  /, '')), router);
  assert.doesNotMatch(fenced[1], /__sign/, 'the router forwards no other query parameter');
  assert.match(artifacts, /right after\s+`<body>`/);
  assert.match(artifacts, /keep it whenever you re-upload the index/);
  assert.match(artifacts, /`hf repo create someone\/pages --repo-type space --space-sdk static --private`/,
    'visibility stays as configured');

  // The linking rule covers EVERY Space — this instance, am-dev-*, demos —
  // so it is its own section, not part of the artifacts one.
  const linkRule = (doc) => {
    const start = doc.indexOf('\n## Linking a Space for the operator');
    assert.ok(start >= 0, 'the generated skill has the Space-linking rule');
    const rest = doc.slice(start + 1);
    const body = rest.slice(0, rest.indexOf('\n## ', 1) < 0 ? undefined : rest.indexOf('\n## ', 1));
    assert.match(body, /Hub page `https:\/\/huggingface\.co\/spaces\/<owner>\/<name>`/);
    assert.match(body, /\*\*never\*\* the direct `https:\/\/<owner>-<name>\.hf\.space` or `\*\.static\.hf\.space` URL/);
    assert.match(body, /`am-dev-\*`/);
    assert.match(body, /programmatic access with a token \(curl, health checks\)/);
    return body;
  };
  linkRule(text);

  // …and it is there with artifacts switched off, when no artifacts section is.
  server.kill('SIGTERM');
  await new Promise((resolve) => (server.exitCode != null ? resolve() : server.once('exit', resolve)));
  // A fresh data tree: the generated skill is a managed file, and the first
  // boot's ownership record would rightly stop it being recreated in place.
  const dataDir2 = path.join(TMP, 'data-no-artifacts');
  const generated2 = path.join(dataDir2, 'workspaces', 'skills', 'environment.md');
  fs.mkdirSync(dataDir2, { recursive: true });
  fs.writeFileSync(path.join(dataDir2, 'am-config.json'), JSON.stringify({ artifacts: { enabled: false } }));
  second = spawn(process.execPath, ['src/index.js'], { env: { ...env, DATA_DIR: dataDir2 }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output2 = '';
  second.stdout.on('data', (chunk) => { output2 += chunk; });
  second.stderr.on('data', (chunk) => { output2 += chunk; });
  for (let i = 0; i < 600 && !fs.existsSync(generated2); i++) {
    if (second.exitCode != null) throw new Error(`server exited ${second.exitCode}: ${output2.slice(-2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(generated2), `environment skill was not generated on the second boot: ${output2.slice(-300)}`);
  const withoutArtifacts = fs.readFileSync(generated2, 'utf8');
  assert.doesNotMatch(withoutArtifacts, /## Publishing results as web pages/);
  linkRule(withoutArtifacts);

  const docs = fs.readFileSync(path.resolve('..', 'docs', 'api-audit-log.md'), 'utf8');
  assert.match(docs, /full non-secret\s+request, prompt, file-write, result and error content/);
  assert.match(docs, /not an export-safe artifact/);
  assert.match(docs, /existing JSONL bytes and backups are not inspected, rewritten/);
  console.log('audit-instructions: generated and long-form policy describe retained, filtered, prospective private logs');
  console.log('env-skill: every dispatch section arms the watch and owns the result');
  console.log('env-skill: artifact pages are linked through the Hub page, with the ?p= router in the index');
  console.log('env-skill: every Space link for the operator is its Hub page, with artifacts on or off');
} finally {
  second?.kill('SIGTERM');
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  fs.rmSync(TMP, { recursive: true, force: true });
}
