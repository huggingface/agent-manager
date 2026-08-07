// Which group a spawned agent joins.
//
// POST /api/agents used to drop `groupId` on the floor: an agent spawning a peer
// got it into the right FOLDER but loose in the sidebar, outside the group it was
// meant to work in. The route now resolves a group the same way it resolves a
// path — inherit the caller's, unless told otherwise.
// Run with: node test/spawn-group.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-group-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const groups = await import('../src/groups.js');
groups.init();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}  want ${want}`}`);
};

const cowrite = groups.create('Co-write');
const other = groups.create('RL-wiki-llm');
const CALLER = 'caller-1';       // a grouped agent doing the spawning
const LONER = 'loner-1';         // an agent that belongs to no group
groups.attach(cowrite.id, CALLER);

console.log('\nomitted group: the new agent lands beside the caller');
check('inherits the caller group', groups.resolveSpawnGroup(undefined, CALLER).groupId, cowrite.id);
check('blank is the same as omitted', groups.resolveSpawnGroup('   ', CALLER).groupId, cowrite.id);
check('no error on the happy path', groups.resolveSpawnGroup(undefined, CALLER).error, undefined);

console.log('\nan ungrouped caller spawns an ungrouped peer, not a crash');
check('loner inherits nothing', groups.resolveSpawnGroup(undefined, LONER).groupId, null);
check('loner is not an error', groups.resolveSpawnGroup(undefined, LONER).error, undefined);
check('unknown caller id is treated as ungrouped',
  groups.resolveSpawnGroup(undefined, 'never-existed').groupId, null);

console.log('\nnaming a group: by display name (what the roster shows) or by id');
check('by name', groups.resolveSpawnGroup('RL-wiki-llm', CALLER).groupId, other.id);
check('by name, case-insensitively', groups.resolveSpawnGroup('rl-WIKI-llm', CALLER).groupId, other.id);
check('by name, padded', groups.resolveSpawnGroup('  Co-write  ', CALLER).groupId, cowrite.id);
check('by id', groups.resolveSpawnGroup(other.id, CALLER).groupId, other.id);

console.log('\nopting out is explicit, because omitted already means "inherit"');
check('none', groups.resolveSpawnGroup('none', CALLER).groupId, null);
check('NONE', groups.resolveSpawnGroup('NONE', CALLER).groupId, null);
check('none is not an error', groups.resolveSpawnGroup('none', CALLER).error, undefined);

console.log('\na group that does not exist is refused, not created');
const bad = groups.resolveSpawnGroup('Cowrite', CALLER); // typo: no hyphen
check('no group id', bad.groupId, undefined);
check('names the bad value', bad.error.includes("'Cowrite'"), true);
check('lists the real groups', bad.error.includes('Co-write') && bad.error.includes('RL-wiki-llm'), true);
check('points at the opt-out', bad.error.includes('group=none'), true);
check('nothing was created', groups.list().length, 2);

console.log('\na non-string group is ignored rather than stringified');
// Express gives ?group=a&group=b as an array, and ?group[x]=1 as an object.
check('array falls back to inherit', groups.resolveSpawnGroup(['a', 'b'], CALLER).groupId, cowrite.id);
check('object falls back to inherit', groups.resolveSpawnGroup({ x: 1 }, CALLER).groupId, cowrite.id);

// The skill tells agents to create a group and then spawn into the id it
// returns, rather than the name. This is why: nothing dedupes group names.
console.log('\nduplicate names resolve to the first match; ids stay exact');
const dupe = groups.create('Co-write');
check('two groups can share a name', groups.list().filter((x) => x.name === 'Co-write').length, 2);
check('by name takes the first', groups.resolveSpawnGroup('Co-write', LONER).groupId, cowrite.id);
check('by id reaches the second', groups.resolveSpawnGroup(dupe.id, LONER).groupId, dupe.id);
groups.remove(dupe.id);

console.log('\nthe resolved id actually places the session (what the route then does)');
const spawned = 'spawned-1';
groups.attach(groups.resolveSpawnGroup(undefined, CALLER).groupId, spawned);
check('peer is in the caller group', groups.groupOf(spawned)?.id, cowrite.id);
check('caller is still there too', groups.groupOf(CALLER)?.id, cowrite.id);
check('and it survives a reload', (groups.init(), groups.groupOf(spawned)?.id), cowrite.id);

console.log('\nan ungrouped spawn is left for the sidebar to prepend');
check('null id means "no attach call"', groups.resolveSpawnGroup('none', CALLER).groupId, null);
check('the loner really is in no group', groups.groupOf(LONER), null);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
