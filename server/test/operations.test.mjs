import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-operations-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { operationMiddleware, readOperations } = await import('../src/operations.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const middleware = operationMiddleware({
  resolveOrigin: (raw) => raw === 'operator'
    ? { id: 'operator', type: 'operator', name: 'test operator' }
    : raw === 'agent-1' ? { id: raw, type: 'agent', name: 'agent one', cli: 'codex' } : null,
  // Stands in for the manager's store: a session exists until something deletes
  // it. A resolver that always answers would hide the case this has to cover.
  resolveTarget: (req) => {
    const id = (req.path.match(/^\/api\/(?:agents|sessions)\/([^/]+)/) || [])[1];
    if (!id) return null;
    const known = sessions.get(id);
    return known ? { id, ...known } : { id };
  },
});

// The fake store the resolver reads. Handlers below delete from it mid-request,
// which is what the real delete route does before it answers.
const sessions = new Map([
  ['s-target', { name: 'name of s-target', cli: 'claude' }],
  ['s-42', { name: 'name of s-42', cli: 'claude' }],
  ['s-doomed', { name: 'deleted-agent', cli: 'codex' }],
]);

class Response extends EventEmitter {
  statusCode = 200;
  body = undefined;
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.emit('finish'); return this; }
}

const invoke = ({ method = 'POST', path: reqPath, query = {}, headers = {}, body }, handler) => {
  const req = { method, path: reqPath, query, headers, body };
  const res = new Response();
  middleware(req, res, () => handler(req, res));
  return res;
};

try {
  console.log('\norigin enforcement');
  const missing = invoke({ path: '/api/groups', body: { name: 'nope' } }, () => {});
  check('a mutation without an origin is refused', missing.statusCode === 400, `status ${missing.statusCode}`);
  const unknown = invoke({ path: '/api/groups', query: { from: 'not-real' }, body: { name: 'nope' } }, () => {});
  check('an unknown origin is refused', unknown.statusCode === 400, `status ${unknown.statusCode}`);

  console.log('\nrecord successful manager operations');
  invoke({ path: '/api/groups', headers: { 'x-am-origin': 'operator' }, body: { name: 'taskforce' } },
    (req, res) => res.status(201).json({ id: 'g-1', name: req.body.name }));
  invoke({ path: '/api/sessions', query: { from: 'agent-1' }, body: { name: 'without-prompt', cli: 'codex', token: 'must-not-leak' } },
    (req, res) => res.status(201).json({ id: 's-without', ...req.body }));
  invoke({ path: '/api/sessions', query: { from: 'agent-1' }, body: { name: 'with-prompt', cli: 'claude', prompt: 'Investigate the flaky test.' } },
    (req, res) => res.status(201).json({ id: 's-with', ...req.body }));
  invoke({ path: '/api/agents', query: { from: 'agent-1', cli: 'codex' }, body: 'Review the implementation.' },
    (_req, res) => res.status(201).json({ id: 'spawned-1' }));
  let readNext = false;
  invoke({ method: 'GET', path: '/api/read' }, () => { readNext = true; });
  check('read-only calls bypass the audit middleware', readNext);

  const rows = readOperations(20).reverse();
  check('only state-changing accepted calls are recorded', rows.length === 4, `got ${rows.length}`);
  check('operator group creation keeps its origin', rows[0]?.origin?.id === 'operator');
  check('group name is reconstructable', rows[0]?.request?.name === 'taskforce');
  check('created group id is recorded', rows[0]?.result?.id === 'g-1');
  check('session creation without a prompt is distinguishable', !('prompt' in (rows[1]?.request || {})));
  check('credentials are redacted', rows[1]?.request?.token === '[redacted]');
  check('session creation with a prompt records presence and size',
    rows[2]?.request?.prompt?.present === true && rows[2]?.request?.prompt?.chars === 27);
  check('prompt content is not copied into the audit log', rows[2]?.request?.prompt?.sha256 && !JSON.stringify(rows[2]).includes('flaky test'));
  check('plain-text agent prompts are summarized too', rows[3]?.request?.present === true && rows[3]?.request?.chars === 26);
  check('origin is separate from the recorded query', rows[3]?.origin?.id === 'agent-1' && !('from' in (rows[3]?.query || {})));
  check('query parameters needed to replay the operation remain', rows[3]?.query?.cli === 'codex');

  // The one read this log cares about. A `wait` is how one agent watches
  // another, so it is the only GET recorded — and only when it RESOLVED, since
  // a wait that timed out is a polling artefact, not an event.
  console.log('\nthe wait that came back');
  const before = readOperations(50).length;
  invoke({ method: 'GET', path: '/api/agents/s-target/wait', query: { from: 'agent-1' } },
    (_req, res) => res.json({ id: 's-target', state: 'waiting', matched: true, waited: 143 }));
  invoke({ method: 'GET', path: '/api/agents/s-target/wait', query: { from: 'agent-1' } },
    (_req, res) => res.json({ id: 's-target', state: 'working', matched: false, timedOut: true }));
  invoke({ method: 'GET', path: '/api/agents/s-target/wait' },
    (_req, res) => res.json({ id: 's-target', state: 'idle', matched: true, waited: 4 }));
  let tailed = false;
  invoke({ method: 'GET', path: '/api/agents/s-target/tail' }, (_req, res) => { tailed = true; res.json({ text: '' }); });
  let rostered = false;
  invoke({ method: 'GET', path: '/api/agents' }, (_req, res) => { rostered = true; res.json({ agents: [] }); });

  const waits = readOperations(50).filter((r) => r.method === 'GET');
  check('a resolved wait is recorded', waits.length === 2, `${waits.length} GET rows`);
  check('a wait that only timed out is not', !waits.some((r) => r.result?.matched === false));
  check('tail is never logged — every open pane polls it', tailed && !waits.some((r) => r.path.endsWith('/tail')));
  check('nor is the roster, or any other read', rostered && readOperations(50).length === before + 2);

  // `wait` is documented read-only and every watch loop running today calls it
  // without ?from=. Refusing those would break them the moment this ships.
  const anonymous = waits.find((r) => !r.origin);
  check('an unattributed wait is accepted, not 400ed', !!anonymous);
  check('and still records who it was waiting ON', anonymous?.target?.id === 's-target');
  const attributed = waits.find((r) => r.origin?.id === 'agent-1');
  check('an attributed wait keeps both ends', attributed?.origin?.id === 'agent-1' && attributed?.target?.name === 'name of s-target');
  check('a wait is worth its duration, not just its timestamp', typeof attributed?.durationMs === 'number');

  console.log('\nwho it was done to');
  invoke({ path: '/api/sessions/s-42/input', query: { from: 'agent-1' }, body: { text: 'go' } },
    (_req, res) => res.json({ ok: true }));
  invoke({ path: '/api/sessions/ghost-9/input', query: { from: 'agent-1' }, body: { text: 'go' } },
    (_req, res) => res.status(404).json({ error: 'not found' }));
  const [ghost, named] = readOperations(2);
  check('the target name is resolved at write time, not read time', named?.target?.name === 'name of s-42');
  check('a target that no longer exists still records its id', ghost?.target?.id === 'ghost-9' && !ghost?.target?.name);

  console.log('\ndeleting the thing being audited');
  // The real route removes the session from the store and only then answers, so
  // a target resolved from the response handler finds nothing left. This is the
  // one operation where the roster can never fill the name back in afterwards.
  invoke({ method: 'DELETE', path: '/api/sessions/s-doomed', query: { from: 'operator' } },
    (_req, res) => { sessions.delete('s-doomed'); res.json({ ok: true }); });
  const [deleted] = readOperations(1);
  check('a delete keeps the name of what it deleted',
    deleted?.target?.name === 'deleted-agent' && deleted?.target?.cli === 'codex',
    JSON.stringify(deleted?.target));
  check('and the session really was gone before the response', !sessions.has('s-doomed'));
  invoke({ path: '/api/sessions/never-existed/input', query: { from: 'operator' }, body: { text: 'x' } },
    (_req, res) => res.json({ ok: true }));
  const [noSuchTarget] = readOperations(1);
  check('a genuinely unknown target is still recorded as a bare id',
    noSuchTarget?.target?.id === 'never-existed' && !noSuchTarget?.target?.name);

  console.log('\nchronology, when a wait outlives the calls it overlaps');
  // A record carries the time the request STARTED but is written when it
  // finishes. A wait blocks for up to 300s, so it is appended after calls that
  // began later — and `readOperations` used to just reverse the file.
  const slowWait = { method: 'GET', path: '/api/agents/s-target/wait', query: { from: 'agent-1' }, headers: {}, body: undefined };
  const waitRes = new Response();
  middleware(slowWait, waitRes, () => {});                   // starts first…
  await new Promise((r) => setTimeout(r, 25));
  invoke({ path: '/api/sessions/s-42/input', query: { from: 'agent-1' }, body: { text: 'meanwhile' } },
    (_req, res) => res.json({ ok: true }));                  // …a later call finishes first…
  await new Promise((r) => setTimeout(r, 25));
  waitRes.json({ id: 's-target', state: 'waiting', matched: true, waited: 0 });  // …and the wait resolves last

  const feed = readOperations(50);
  const iWait = feed.findIndex((r) => r.method === 'GET' && r.result?.waited === 0);
  const iMeanwhile = feed.findIndex((r) => r.request?.text?.chars === 9);
  check('the wait was appended last but is listed after the call it overlapped',
    iWait > iMeanwhile && iMeanwhile >= 0, `wait at ${iWait}, overlapping call at ${iMeanwhile}`);
  check('so every row is in order, newest first',
    feed.every((r, i) => i === 0 || feed[i - 1].at >= r.at));
  check('and the wait still carries how long it blocked',
    feed[iWait]?.durationMs >= 40, `${feed[iWait]?.durationMs}ms`);

  console.log('\nand the guard that has to keep holding');
  const stillRefused = invoke({ path: '/api/groups', body: { name: 'nope' } }, () => {});
  check('a mutating call with no origin is still refused', stillRefused.statusCode === 400);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
