// Session and group lookup by name is case-insensitive.
//
// `GET /api/agents?group=hunter` must find a group the operator named "Hunter",
// `POST /api/agents group=hunter` must land in it, and a cron pointing at
// "Reviewer" must reuse the existing "reviewer" session instead of spawning a
// second one. Every name comparison goes through normalizeName() (trim,
// case-fold, NFC) on both the query and the stored side.
// Run with: node test/agent-list.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { filterAgentsByGroup, findByName, normalizeName, sameName } from '../src/agent-list.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-list-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const groups = await import('../src/groups.js');
groups.init();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};
const ids = (rows) => rows.map((r) => r.id).join(',');

console.log('\nnormalizeName folds the things people type differently');
check('case', normalizeName('Hunter'), 'hunter');
check('outer whitespace', normalizeName('  Hunter '), 'hunter');
check('unicode case', normalizeName('ÉQUIPE'), 'équipe');
check('NFC vs NFD', normalizeName('Équipe'), normalizeName('Équipe'));
check('null is empty', normalizeName(null), '');
check('sameName never matches two blanks', sameName('  ', ''), false);
check('sameName ignores case', sameName('Hunter', 'HUNTER'), true);

const rows = [
  { id: 'a', name: 'Alpha', group: 'Hunter' },
  { id: 'b', name: 'Beta', group: 'hunter' },
  { id: 'c', name: 'Gamma', group: 'Co-write' },
  { id: 'd', name: 'Delta', group: null },
  { id: 'e', name: 'Épsilon', group: 'Équipe' },
];

console.log('\nroster group filter (GET /api/agents?group=)');
check('exact name still works', ids(filterAgentsByGroup(rows, 'Hunter')), 'a,b');
check('lower-case query finds the mixed-case group', ids(filterAgentsByGroup(rows, 'hunter')), 'a,b');
check('upper-case query too', ids(filterAgentsByGroup(rows, 'HUNTER')), 'a,b');
check('padded query is trimmed', ids(filterAgentsByGroup(rows, ' co-WRITE ')), 'c');
check('accented group, decomposed query', ids(filterAgentsByGroup(rows, 'équipe')), 'e');
check('unknown group is empty, not everything', ids(filterAgentsByGroup(rows, 'nope')), '');
check('no filter returns all', filterAgentsByGroup(rows, null).length, rows.length);
check('blank filter returns all', filterAgentsByGroup(rows, '  ').length, rows.length);
check('ungrouped rows never match a filter', ids(filterAgentsByGroup(rows, 'null')), '');

console.log('\nsession lookup by name (cron reuse)');
const sessions = [
  { id: 's1', name: 'Reviewer' },
  { id: 's2', name: 'daily digest' },
  { id: 's3', name: 'reviewer' },
];
check('exact match', findByName(sessions, 'Reviewer')?.id, 's1');
check('case-insensitive match', findByName(sessions, 'REVIEWER')?.id, 's1');
check('first match wins when two names collide by case', findByName(sessions, 'reviewer')?.id, 's1');
check('trimmed and folded', findByName(sessions, '  Daily Digest ')?.id, 's2');
check('unknown name is null', findByName(sessions, 'nobody'), null);
check('empty name never matches', findByName([{ id: 'x', name: '' }, ...sessions], ''), null);
check('undefined name is null, not a crash', findByName(sessions, undefined), null);
check('sessions without a name are skipped', findByName([{ id: 'n' }, ...sessions], 'reviewer')?.id, 's1');

console.log('\nspawn target group by name (POST /api/agents group=)');
const hunter = groups.create('Hunter');
const equipe = groups.create('Équipe');
check('exact', groups.resolveSpawnGroup('Hunter', 'x').groupId, hunter.id);
check('lower-case', groups.resolveSpawnGroup('hunter', 'x').groupId, hunter.id);
check('upper-case padded', groups.resolveSpawnGroup(' HUNTER ', 'x').groupId, hunter.id);
check('decomposed accent', groups.resolveSpawnGroup('équipe', 'x').groupId, equipe.id);
check('NONE still means ungrouped', groups.resolveSpawnGroup('NONE', 'x').groupId, null);
check('unknown is still an error', typeof groups.resolveSpawnGroup('nope', 'x').error, 'string');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
