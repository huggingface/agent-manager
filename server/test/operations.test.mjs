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
});

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
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
