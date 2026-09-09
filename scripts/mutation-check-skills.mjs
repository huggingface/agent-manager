// Each mutant gets a disposable service + unit suite. No working-tree edits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(path.join(repo, 'server/src/skills.js'), 'utf8');
const suite = fs.readFileSync(path.join(repo, 'server/test/skills.test.mjs'), 'utf8');
const mutations = [
  ['recreated skill identity', 'instance: nonce()', "instance: 'reused'"],
  ['generated deletion flag', 'if (load().disabledGenerated.includes(name))', 'if (false)'],
  ['create overwrite guard', 'if (create && (r || existing !== null))', 'if (false)'],
  ['normalized collision guard', 'if (other.toLowerCase() === name.toLowerCase() || otherId === id)', 'if (false)'],
  ['stale revision guard', 'if (snapshot(name, m).revision !== revision)', 'if (false)'],
  ['external installed-file guard', 'if (actual !== t.hash && actual !== r.pending?.targetHash && actual !== null)', 'if (false)'],
  ['unowned installation guard', 'if (actual !== null && (!adopt || actual !== expected))', 'if (false)'],
  ['manifest destination identity', "t.path !== path.join(t.root, r.id, 'SKILL.md')", 'false'],
  ['pre-existing directory ownership', 'if (t.dirOwned)', 'if (true)'],
  ['recursive directory deletion', 'io.unlinkSync(t.path);', 'io.rmSync(path.dirname(t.path), { recursive: true, force: true });'],
  ['pending deletion protection', /if \(m\.skills\[name\]\?\.pending\?\.kind === 'delete'\)|if \(r\?\.pending\?\.kind === 'delete'\)/g, 'if (false)'],
  ['temporary exclusive creation', 'fs.constants.O_EXCL | fs.constants.O_NOFOLLOW', 'fs.constants.O_TRUNC'],
];
let failed = 0;
for (const [name, from, to] of mutations) {
  if (!(from instanceof RegExp ? from.test(source) : source.includes(from))) throw new Error(`Mutation point missing: ${name}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-skills-mutant-'));
  try {
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(root, 'src/skills.js'), source.replace(from, to));
    fs.writeFileSync(path.join(root, 'test/skills.test.mjs'), suite);
    const run = spawnSync(process.execPath, [path.join(root, 'test/skills.test.mjs')], { encoding: 'utf8', timeout: 30000 });
    const killed = run.status !== 0 && /not ok/.test(run.stdout);
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
    if (!killed) { failed++; console.log((run.stderr || run.stdout).slice(-800)); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
