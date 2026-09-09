import { ApiError, invalid } from './api-errors.js';
import { validateSchedule } from './crons.js';

const object = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, 'must be an object');
  return value;
};
const text = (value, field, { empty = false, max = Infinity } = {}) => {
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  if (!empty && !value.trim()) throw invalid(field, 'must not be empty');
  if (value.length > max) throw invalid(field, `must be at most ${max} characters`);
};
const boolean = (value, field) => { if (typeof value !== 'boolean') throw invalid(field, 'must be true or false'); };
const number = (value, field, min, max, integer = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    throw invalid(field, `must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
};
const oneOf = (value, field, values) => { if (!values.includes(value)) throw invalid(field, `must be one of: ${values.join(', ')}`); };
const strings = (value, field) => {
  if (!Array.isArray(value)) throw invalid(field, 'must be an array of strings');
  value.forEach((item) => text(item, field));
};
const optional = (body, key, check = text, ...args) => {
  if (body[key] !== undefined) check(body[key], key, ...args);
};
const treeRef = (value, field) => {
  text(value, field);
  if (!/^[sg]:[^\s:]+$/.test(value)) throw invalid(field, 'must be a session or group reference');
};
const pathText = (value, field) => {
  text(value, field, { empty: true });
  if (value.includes('\0')) throw invalid(field, 'must not contain null characters');
};
const fileName = (value, field) => {
  text(value, field, { max: 200 });
  if (/[\\/\0]/.test(value) || ['.', '..'].includes(value.trim())) throw invalid(field, 'must be a single file name');
};

// Unknown fields keep the endpoint's old behavior (ignored, or preserved by
// its own service). Validate recognized fields, never strip an input object.
export function createValidator({ cliExists, sessionExists, groupExists }) {
  const cli = (value, field) => { text(value, field); if (!cliExists(value)) throw invalid(field, 'unknown CLI'); };
  const exists = (value, field, lookup) => { text(value, field); if (!lookup(value)) throw invalid(field, 'does not exist'); };
  const liveRef = (value, field) => {
    treeRef(value, field);
    if (!(value.startsWith('s:') ? sessionExists(value.slice(2)) : groupExists(value.slice(2)))) throw invalid(field, 'does not exist');
  };
  return (req, route) => {
    const q = req.query;
    // Express's extended query parser produces arrays/objects for duplicates
    // and bracket notation. None of the current routes accepts either form.
    for (const [key, value] of Object.entries(q)) {
      if (typeof value !== 'string') throw invalid('query', 'parameters must have one scalar value');
      if (value.includes('\0')) throw invalid('query', 'must not contain null characters');
    }
    for (const value of Object.values(req.params)) {
      if (value.includes('\0')) throw invalid('path', 'must not contain null characters');
    }
    const queryNumber = (key, min, max = Number.MAX_SAFE_INTEGER) => {
      if (q[key] === undefined) return;
      if (!/^\d+$/.test(q[key])) throw invalid(key, 'must be an integer');
      number(Number(q[key]), key, min, max);
    };
    if (route === '/api/operations') queryNumber('limit', 1, 1000);
    if (route === '/api/usage') {
      optional(q, 'provider', oneOf, ['', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'gemini']);
      optional(q, 'debug', oneOf, ['0', '1']);
    }
    if (route.endsWith('/tail')) queryNumber('lines', 1); // existing clients request >2000; capture still clamps
    if (route.endsWith('/wait')) {
      queryNumber('timeout', 1, 300); queryNumber('settle', 0, 60);
      if (q.state !== undefined) q.state.split(',').forEach((s) => oneOf(s.trim(), 'state', ['waiting', 'idle', 'stopped', 'working', 'input-required']));
    }
    if (route.includes('/remote') || route.startsWith('/api/remote/')) {
      queryNumber('since', 0); queryNumber('wait', 5, 1800);
      optional(q, 'agent', oneOf, ['0', '1']);
    }
    const trace = route.startsWith('/api/trace/:id') || route.endsWith('/trace') || route.endsWith('/subagents/:agentId');
    if (trace) {
      for (const key of ['offset', 'before', 'after']) queryNumber(key, 0);
      // Preserve the existing domain clamps for page/window sizes, but reject
      // nonnumeric, negative, fractional and unsafe values before any reads.
      for (const key of ['bytes', 'min']) queryNumber(key, 0);
      queryNumber('limit', 1);
      optional(q, 'v', oneOf, ['1', '2']);
      optional(q, 'generation', text, { max: 64 });
      if (['summary', 'tail', 'before', 'after'].filter((key) => q[key] !== undefined).length > 1) throw invalid('query', 'choose one trace window or summary');
    }
    if (route === '/api/next-name') cli(q.cli, 'cli');
    optional(q, 'trigger', oneOf, ['manual', 'schedule', 'restart']);
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return;

    const raw = route === '/api/sessions/:id/attachments' || route === '/api/files/:id/upload';
    if (raw) {
      if (route.endsWith('/upload')) fileName(q.name, 'name');
      return;
    }
    const plain = route === '/api/skills/:name' || route === '/api/files/:id/write';
    if (plain) {
      // body-parser leaves {} for a zero-byte body. An empty text replacement
      // is valid; a parsed JSON object is not an empty text replacement.
      if (!/application\/json/i.test(req.headers['content-type'] || '') && !req.headers['transfer-encoding']
        && (!req.headers['content-length'] || req.headers['content-length'] === '0')) req.body = '';
      text(req.body, 'body', { empty: true }); return;
    }
    const prompt = route === '/api/agents' || route === '/api/agents/:id/prompt' || route === '/api/agents/:id/stop' || route === '/api/remote/:name/messages';
    const mediaType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    // req.is() returns null for zero-byte bodies, even with a JSON content
    // type. Bodyless commands remain valid with or without that header.
    const hasBody = req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0;
    if (!prompt && ((mediaType && mediaType !== 'application/json') || (!mediaType && hasBody))) {
      throw new ApiError(415, 'unsupported-media-type', 'Use application/json for this request.');
    }
    const b = prompt && typeof req.body === 'string' ? {} : object(req.body === undefined ? {} : req.body, 'body');
    if (prompt) {
      optional(b, 'from'); optional(b, route === '/api/agents' ? 'prompt' : 'text', text, { empty: true });
      if (route === '/api/agents') { cli(q.cli, 'cli'); optional(q, 'name', text, { empty: true }); optional(q, 'path', pathText); }
      return; // sender, availability, self-target and nonempty prompt checks remain in the route
    }
    if (route === '/api/config') {
      for (const key of ['artifacts', 'jobs', 'archive', 'revive', 'backup']) optional(b, key, object);
      if (b.artifacts) { optional(b.artifacts, 'enabled', boolean); optional(b.artifacts, 'space', text, { empty: true }); optional(b.artifacts, 'visibility', oneOf, ['public', 'private']); }
      if (b.jobs) optional(b.jobs, 'askAboveUsd', number, 0, Number.MAX_SAFE_INTEGER, false);
      if (b.archive) optional(b.archive, 'after', oneOf, ['week', 'month', 'never']);
      if (b.revive) { optional(b.revive, 'enabled', boolean); optional(b.revive, 'days', oneOf, [1, 3, 7]); }
      if (b.backup) { optional(b.backup, 'every', oneOf, ['never', '1h', '3h', '24h']); optional(b.backup, 'dataset', text, { empty: true }); optional(b.backup, 'exclude', strings); }
    } else if (route === '/api/secrets') {
      optional(b, 'notes', object);
      for (const value of Object.values(b.notes || {})) text(value, 'notes entry', { empty: true });
    } else if (route === '/api/sessions') {
      cli(b.cli, 'cli'); optional(b, 'name', text, { empty: true }); optional(b, 'prompt', text, { empty: true }); optional(b, 'path', pathText);
      if (b.groupId !== undefined) exists(b.groupId, 'groupId', groupExists);
    } else if (route === '/api/sessions/:id') {
      text(b.name, 'name');
    } else if (route === '/api/groups' || route === '/api/groups/:id') {
      optional(b, 'name', text, { empty: route === '/api/groups' });
      optional(b, 'sessionIds', strings);
      b.sessionIds?.forEach((id) => exists(id, 'sessionIds', sessionExists));
      if (b.layout !== undefined && b.layout !== null) {
        object(b.layout, 'layout'); number(b.layout.cols, 'layout.cols', 1, 3); number(b.layout.rows, 'layout.rows', 1, 3);
      }
    } else if (route === '/api/move') {
      liveRef(b.ref, 'ref'); object(b.to, 'to'); oneOf(b.to.kind, 'to.kind', ['into', 'pair', 'before', 'after']);
      if (b.to.kind === 'into') exists(b.to.groupId, 'to.groupId', groupExists);
      else if (b.to.kind === 'pair') exists(b.to.sessionId, 'to.sessionId', sessionExists);
      else liveRef(b.to.ref, 'to.ref');
    } else if (route === '/api/overview/hidden') {
      treeRef(b.ref, 'ref'); boolean(b.hidden, 'hidden');
    } else if (route === '/api/demo') boolean(b.active, 'active');
    else if (route === '/api/sessions/:id/remote/paused') boolean(b.paused, 'paused');
    else if (route === '/api/sessions/:id/input' || route === '/api/sessions/:id/attachments/insert') {
      optional(b, 'text', text, { empty: true }); optional(b, 'attachmentIds', strings);
    } else if (route === '/api/remote/:name/hello') {
      for (const key of ['harness', 'cwd', 'host']) optional(b, key, text, { empty: true });
    } else if (route === '/api/push/subscribe') {
      object(b.subscription, 'subscription'); text(b.subscription.endpoint, 'subscription.endpoint');
      object(b.subscription.keys, 'subscription.keys'); text(b.subscription.keys.p256dh, 'subscription.keys.p256dh'); text(b.subscription.keys.auth, 'subscription.keys.auth');
    } else if (route === '/api/push/unsubscribe') text(b.endpoint, 'endpoint');
    else if (route === '/api/notify') { text(b.body, 'body'); optional(b, 'title', text, { empty: true }); optional(b, 'url', text, { empty: true }); }
    else if (route.startsWith('/api/files/')) {
      optional(b, 'path', pathText);
      if (route.endsWith('/move')) pathText(b.to, 'to'); else fileName(b.name, 'name');
    } else if (route === '/api/sessions/:id/share') {
      optional(b, 'visibility', oneOf, ['public', 'gated']); optional(b, 'name', text, { empty: true }); optional(b, 'grantTo', strings);
    } else if (route === '/api/share/access') {
      text(b.repo, 'repo'); optional(b, 'grant', strings); optional(b, 'revoke', strings);
    } else if (route === '/api/trace/import') text(b.repo, 'repo');
    else if (route === '/api/trace/:id/source') { optional(b, 'kind', oneOf, ['session', 'bundle']); text(b.ref, 'ref'); }
    else if (route === '/api/crons' || route === '/api/crons/:id') {
      const create = route === '/api/crons';
      for (const key of ['name', 'prompt']) {
        if (create || b[key] !== undefined) text(b[key], key, { max: key === 'prompt' ? 100_000 : 160 });
      }
      if (create || b.agent !== undefined) { object(b.agent, 'agent'); text(b.agent.name, 'agent.name', { max: 160 }); cli(b.agent.cli, 'agent.cli'); }
      if (create || b.schedule !== undefined) validateSchedule(b.schedule);
      optional(b, 'runOnRestart', boolean); optional(b, 'state', oneOf, ['running', 'stopped']);
    }
  };
}
