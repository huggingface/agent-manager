// The sync-fs tripwire: it must name the caller of a slow call without ever
// changing what that call does. Run with: node test/slowfs.test.mjs
//
// Timing is deliberately not asserted on — a test needing a real 50ms stat would
// want a FUSE mount or a sleep, and both are flaky. The threshold drops to ~0
// instead, so every call is "slow" and the same path runs: wrap, time, attribute.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slowfs-'));
const FILE = path.join(TMP, 'hello.txt');
fs.writeFileSync(FILE, 'contents\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}  want ${want}`}`);
};

const { installSlowFsProbe } = await import('../src/slowfs.js');

console.log('disabled unless a positive threshold is set');
const untouched = fs.statSync;
check('0 disables', installSlowFsProbe({ thresholdMs: 0 }), false);
check('negative disables', installSlowFsProbe({ thresholdMs: -1 }), false);
check('NaN disables', installSlowFsProbe({ thresholdMs: Number('nope') }), false);
check('fs left unwrapped when disabled', fs.statSync, untouched);

// Capture the warnings rather than exporting state from the module purely to
// be tested: the log line IS the product here.
const logs = [];
const realWarn = console.warn;
console.warn = (...a) => { logs.push(a.join(' ')); };

check('installs', installSlowFsProbe({ thresholdMs: 0.0000001 }), true);

console.log('\ninstalled: every sync call still behaves exactly as before');
check('readFileSync returns content', fs.readFileSync(FILE, 'utf8'), 'contents\n');
check('existsSync true', fs.existsSync(FILE), true);
check('existsSync false', fs.existsSync(path.join(TMP, 'nope')), false);
check('statSync size', fs.statSync(FILE).size, 9);
check('readdirSync finds the file', fs.readdirSync(TMP).includes('hello.txt'), true);
// Wrapping replaces the function object, so properties hanging off it (notably
// realpathSync.native) would vanish without the Object.assign.
check('realpathSync.native survives wrapping', typeof fs.realpathSync.native, 'function');

// A wrapper that swallowed errors would be worse than the bug it hunts.
let threw = null;
try { fs.readFileSync(path.join(TMP, 'missing'), 'utf8'); } catch (e) { threw = e.code; }
check('errors still propagate', threw, 'ENOENT');

console.log('\nit attributes the call to the caller, not to itself');
const joined = logs.join('\n');
check('something was logged', logs.length > 0, true);
check('names this test file', joined.includes('slowfs.test.mjs'), true);
check('does not blame slowfs.js', joined.includes('slowfs.js'), false);
check('names the method', joined.includes('readFileSync'), true);

console.log('\na stalled mount must not become a log storm');
logs.length = 0;
for (let i = 0; i < 5; i++) fs.existsSync(FILE); // one line => one call site
check('repeats collapse to a single line', logs.filter((l) => l.includes('existsSync')).length, 1);

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
