// Real browser mutants, each in an isolated source copy; the fixture always
// launches a disposable backend with cleared harness homes and credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url));
const mutants = [
  ['deletion on opening', 'setConfirmDel(await api.getSkill(loaded.name));', 'await api.deleteSkill(loaded.name, loaded.revision);'],
  ['duplicate submission guard', 'if (working.current) return;', ''],
  ['failed save discards buffer', 'await api.saveSkill(loaded.name, content, loaded.revision)', "await api.saveSkill(loaded.name, content, loaded.revision).catch((e) => { setContent(''); throw e; })"],
  ['generated skill editable in the UI', "disabled={busy || loaded?.pending === 'delete' || loaded?.readOnly}", "disabled={busy || loaded?.pending === 'delete'}"],
];
let failed = 0;
for (const [name, from, to] of mutants) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-skills-ui-mutant-'));
  try {
    fs.mkdirSync(path.join(root, 'web/test'), { recursive: true });
    fs.cpSync(path.join(repo, 'web/src'), path.join(root, 'web/src'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'web/test/skills.browser.test.mjs'), path.join(root, 'web/test/skills.browser.test.mjs'));
    for (const dir of ['server', 'scripts', 'web/node_modules']) fs.symlinkSync(path.join(repo, dir), path.join(root, dir));
    const file = path.join(root, 'web/src/components/SkillsEditor.tsx');
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes(from)) throw new Error(`Mutation point missing: ${name}`);
    fs.writeFileSync(file, source.replace(from, to));
    const { AM_SKILLS_SCREENSHOTS, ...env } = process.env;
    const result = spawnSync(process.execPath, [path.join(root, 'web/test/skills.browser.test.mjs')], { env, encoding: 'utf8', timeout: 60000 });
    const killed = result.status !== 0 && /AssertionError|TimeoutError/.test(result.stderr);
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
    if (!killed) { failed++; console.log((result.stderr || result.stdout).slice(-1200)); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
