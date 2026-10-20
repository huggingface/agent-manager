// shareSession() against a fake Hub: the order of Hub calls, and what happens to
// the dataset at every point a share can fail.
//
// The property under test: a gated share's trace is never readable by a
// logged-out client — not between steps, and not after any failure. The fake
// Hub tracks exactly that (`anonymousCouldRead`): a repo holding the trace that
// is neither gated nor private. It also checks that a share never writes into a
// repo it did not just create, and that a redaction hit blocks before the Hub is
// touched at all. The bundle is built by the real exporter from a synthetic
// transcript.
//   node --test test/share-publish.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-share-publish-'));
const CLAUDE = path.join(TMP, 'claude');
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
fs.mkdirSync(path.join(CLAUDE, 'projects', 'p'), { recursive: true });
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.HOME = path.join(TMP, 'home');
process.env.HF_TOKEN = 'test-token-not-real';
const { shareSession } = await import('../src/share.js');
const { apiErrorHandler, ApiError } = await import('../src/api-errors.js');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const transcript = (text) => fs.writeFileSync(path.join(CLAUDE, 'projects', 'p', `${UUID}.jsonl`), [
  { type: 'user', cwd: '/w', message: { role: 'user', content: text }, timestamp: '2026-01-01T00:00:00Z' },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n');
const SESSION = { id: 's1', name: 'Fix Acme payroll leak', cli: 'claude', sessionUuid: UUID };

const err = (status, message) => Object.assign(new Error(`HF ${status}: ${message}`), { status });

/**
 * A Hub with just enough state to judge a share. `fail` names methods that
 * throw; `lie` makes a call "succeed" without taking effect.
 */
function fakeHub({ fail = {}, lie = {}, ungateOnUpload = false, dropUpload = false, onInfo, beforeCommit } = {}) {
  const repos = new Map();
  let serial = 0;
  const fresh = (created) => ({ _id: `id${++serial}`, sha: `sha${serial}`, private: false, gated: false,
    files: ['.gitattributes'], uploaded: {}, created });
  let infoCalls = 0;
  const calls = [];
  const state = { anonymousCouldRead: false, wroteToExisting: false, uploadedWhileUngated: false };
  const check = () => {
    for (const r of repos.values()) {
      if (r.files.some((f) => f.endsWith('.jsonl')) && !r.private && r.gated !== 'manual') state.anonymousCouldRead = true;
    }
  };
  const get = (repo) => { const r = repos.get(repo); if (!r) throw err(404, 'Repository not found'); return r; };
  const maybeFail = (name, ...args) => {
    const f = fail[name];
    if (typeof f === 'function') { const e = f(...args); if (e) throw e; } else if (f) throw err(500, `${name} broke`);
  };
  const h = {
    repos, calls, state,
    whoami: async () => ({ name: 'tester' }),
    info: async (repo) => {
      calls.push(['info', repo]);
      if (onInfo) onInfo(++infoCalls, repo, h);
      maybeFail('info', repo);
      const r = get(repo);
      return { id: repo, _id: r._id, private: r.private, gated: r.gated, sha: r.sha, siblings: r.files.map((rfilename) => ({ rfilename })) };
    },
    createRepo: async (repo) => {
      calls.push(['create', repo]);
      maybeFail('createRepo', repo);
      if (repos.has(repo)) throw err(409, 'You already created this dataset repo');
      repos.set(repo, fresh(true));
    },
    setGated: async (repo) => {
      calls.push(['gate', repo]);
      maybeFail('setGated', repo);
      if (!lie.setGated) get(repo).gated = 'manual';
    },
    setPrivate: async (repo) => {
      calls.push(['private', repo]);
      maybeFail('setPrivate', repo);
      if (!lie.setPrivate) get(repo).private = true;
    },
    deleteRepo: async (repo) => {
      calls.push(['delete', repo]);
      maybeFail('deleteRepo', repo);
      if (!lie.deleteRepo) repos.delete(repo);
    },
    // Modelled on the Hub commit API: never creates a repo (404 if missing), and
    // refuses a commit whose parent is not the current head.
    upload: async (repo, dir, { parentCommit } = {}) => {
      calls.push(['upload', repo, parentCommit]);
      if (beforeCommit) beforeCommit(repo, h);
      const r = get(repo);
      if (parentCommit && parentCommit !== r.sha) throw err(412, 'parent commit is not the head of main');
      if (!r.created) state.wroteToExisting = true;
      if (r.gated !== 'manual') state.uploadedWhileUngated = true;
      const walk = (d, pre = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]);
      const files = walk(dir);
      // A failed upload can still leave some files behind.
      if (fail.upload) { r.files.push(files.find((f) => f.endsWith('.jsonl'))); check(); throw err(500, 'upload broke'); }
      if (!dropUpload) for (const f of files) { r.files.push(f); r.uploaded[f] = fs.readFileSync(path.join(dir, f), 'utf8'); }
      r.sha = `${r.sha}+commit`;
      if (ungateOnUpload) r.gated = false;
      check();
    },
    grant: async (repo, user) => {
      calls.push(['grant', repo, user]);
      maybeFail('grant', repo, user);
      if (get(repo).gated !== 'manual') throw err(400, 'not gated');
    },
    sleep: async () => {},
  };
  // Re-check exposure after every mutating call.
  for (const k of ['setGated', 'setPrivate', 'deleteRepo', 'grant']) {
    const f = h[k];
    h[k] = async (...a) => { try { return await f(...a); } finally { check(); } };
  }
  // Someone else's repo appears under the same name.
  h.replace = (repo) => { repos.set(repo, fresh(false)); };
  return h;
}

const share = (h, opts = {}) => shareSession(SESSION, { visibility: 'gated', hub: h, verifyDelayMs: 0, ...opts });
const kinds = (h) => h.calls.map((c) => c[0]);
const rejectsWith = async (p, code, outcome, extra = () => {}) => {
  let caught;
  await assert.rejects(p, (e) => { caught = e; return true; });
  assert.equal(caught.code, code, caught.message);
  if (outcome) assert.equal(caught.data.share.outcome, outcome, caught.message);
  extra(caught);
  return caught;
};

test('gated: created empty, gated and verified BEFORE the upload; never anonymously readable', async () => {
  transcript('please fix the parser');
  const h = fakeHub();
  const out = await share(h, { grantTo: ['alice', 'bob'] });
  const k = kinds(h);
  assert.deepEqual(k.slice(0, 5), ['create', 'gate', 'info', 'info', 'upload'], k.join(' '));
  assert.equal(h.calls.find((c) => c[0] === 'upload')[2], 'sha1', 'the commit is bound to the verified head');
  assert.ok(k.indexOf('grant') > k.indexOf('upload'));
  assert.equal(k.at(-1), 'info', 'ends with a final check');
  assert.equal(h.state.uploadedWhileUngated, false);
  assert.equal(h.state.anonymousCouldRead, false);
  assert.deepEqual(out.granted, ['alice', 'bob']);
  assert.equal(out.visibility, 'gated');
  assert.equal(out.url, `https://huggingface.co/datasets/${out.repo}`);
});

test('gated: nothing public is built from the session (repo name, card title, file names)', async () => {
  transcript('please fix the parser');
  const h = fakeHub();
  const out = await share(h);
  assert.match(out.repo, /^tester\/am-session-[0-9a-f]{10}$/);
  assert.equal(out.trace, 'trace.jsonl');
  const r = h.repos.get(out.repo);
  const names = Object.keys(r.uploaded).sort();
  assert.deepEqual(names, ['README.md', 'meta/briefing.md', 'meta/manifest.json', 'meta/redaction.json', 'trace.jsonl']);
  const card = r.uploaded['README.md'];
  for (const leak of ['acme', 'payroll', UUID.slice(0, 8), 's1']) {
    assert.ok(!names.join(' ').toLowerCase().includes(leak), `file list carries ${leak}`);
    assert.ok(!out.repo.toLowerCase().includes(leak), `repo name carries ${leak}`);
  }
  assert.ok(!/acme|payroll/i.test(card), 'card carries the session name');
  assert.match(card, /pretty_name: "Agent Manager session"/);
  assert.match(card, /repo name, this card and the file list are public/);
});

test('every share gets a fresh repo; nothing is ever reused', async () => {
  transcript('hello');
  const h = fakeHub();
  const a = await share(h);
  const b = await share(h);
  const c = await share(h, { visibility: 'public' });
  const d = await share(h, { visibility: 'public' });
  assert.equal(new Set([a.repo, b.repo, c.repo, d.repo]).size, 4);
  assert.ok(!a.repo.includes(UUID.slice(0, 6)) && !c.repo.includes(UUID.slice(0, 6)), 'suffix is not the session id');
  assert.match(c.repo, /^tester\/am-session-fix-acme-payroll-leak-[0-9a-f]{10}$/);
  assert.equal(c.trace, `${UUID}.jsonl`, 'a public share keeps the native name');
});

test('a name that already exists is refused, and the existing repo is not touched', async () => {
  transcript('hello');
  for (const visibility of ['gated', 'public']) {
    const h = fakeHub();
    // Every name "exists": the Hub refuses the create.
    h.createRepo = async (repo) => { h.calls.push(['create', repo]); throw err(409, 'You already created this dataset repo'); };
    await rejectsWith(share(h, { visibility }), 'share-name-taken', 'not-created',
      (e) => assert.match(e.message, /already exists.*Nothing was uploaded/));
    assert.deepEqual(kinds(h), ['create'], `${visibility}: no gate, upload or delete on an existing repo`);
  }
});

test('create fails: nothing uploaded, nothing deleted', async () => {
  transcript('hello');
  const h = fakeHub({ fail: { createRepo: true } });
  await rejectsWith(share(h), 'share-create-failed', 'not-created');
  assert.deepEqual(kinds(h), ['create']);
});

test('gating fails: the empty repo is deleted, nothing uploaded', async () => {
  transcript('hello');
  for (const [label, opts] of [['gate call throws', { fail: { setGated: true } }],
                               ['gate call is ignored', { lie: { setGated: true } }],
                               ['read-back fails', {}]]) {
    const h = fakeHub(opts);
    if (label === 'read-back fails') { let n = 0; h.info = async (repo) => { h.calls.push(['info', repo]); if (n++ === 0) throw err(500, 'flaky'); throw err(404, 'gone'); }; }
    const e = await rejectsWith(share(h), 'share-gate-failed', 'deleted');
    assert.match(e.message, /empty dataset was deleted\. Nothing was uploaded/, label);
    assert.ok(!kinds(h).includes('upload'), `${label}: uploaded anyway`);
    assert.ok(kinds(h).includes('delete'), label);
    assert.equal(h.repos.size, 0, label);
  }
});

test('gating fails and the delete fails too: says an empty repo is left, still nothing uploaded', async () => {
  transcript('hello');
  const h = fakeHub({ fail: { setGated: true, deleteRepo: true } });
  const e = await rejectsWith(share(h), 'share-gate-failed', 'left-empty');
  assert.match(e.message, /Nothing was uploaded, but an empty dataset is left at https:\/\/huggingface\.co\/datasets\/tester\/am-session-/);
  assert.ok(!kinds(h).includes('upload'));
});

test('upload fails: rolled back to private', async () => {
  transcript('hello');
  const h = fakeHub({ fail: { upload: true } });
  const e = await rejectsWith(share(h), 'share-rolled-back', 'made-private');
  assert.equal(e.data.share.stage, 'upload');
  assert.match(e.message, /upload failed\. The dataset was made private/);
  const [r] = h.repos.values();
  assert.equal(r.private, true);
  assert.equal(h.state.anonymousCouldRead, false);
});

test('upload fails, private fails: rolled back by deleting', async () => {
  transcript('hello');
  for (const opts of [{ fail: { upload: true, setPrivate: true } }, { fail: { upload: true }, lie: { setPrivate: true } }]) {
    const h = fakeHub(opts);
    const e = await rejectsWith(share(h), 'share-rolled-back', 'deleted');
    assert.match(e.message, /The dataset was deleted/);
    assert.equal(h.repos.size, 0);
  }
});

test('rollback fails entirely: the error says the trace may be public, and where', async () => {
  transcript('hello');
  const h = fakeHub({ fail: { upload: true, setPrivate: true, deleteRepo: true } });
  const e = await rejectsWith(share(h), 'share-exposed', 'exposed');
  assert.match(e.message, /^This trace may be public at https:\/\/huggingface\.co\/datasets\/tester\/am-session-[0-9a-f]{10} — check it now\./);
  assert.equal(e.data.share.url, e.message.match(/(https:\S+)/)[1]);
});

test('a grant fails: rolled back, naming the user; "already has access" is fine', async () => {
  transcript('hello');
  const h = fakeHub({ fail: { grant: (_r, user) => (user === 'nosuchuser' ? err(404, 'user not found') : null) } });
  const e = await rejectsWith(share(h, { grantTo: ['alice', 'nosuchuser'] }), 'share-rolled-back', 'made-private');
  assert.equal(e.data.share.stage, 'grant');
  assert.match(e.message, /could not be granted to nosuchuser/);

  const ok = fakeHub({ fail: { grant: () => err(400, 'user already has access') } });
  const out = await share(ok, { grantTo: ['alice'] });
  assert.deepEqual(out.granted, ['alice']);
});

test('final check fails: rolled back', async () => {
  transcript('hello');
  const lost = fakeHub({ ungateOnUpload: true });
  const e1 = await rejectsWith(share(lost), 'share-rolled-back', 'made-private');
  assert.equal(e1.data.share.stage, 'verify');
  assert.match(e1.message, /no longer gated/);

  const missing = fakeHub({ dropUpload: true });
  const e2 = await rejectsWith(share(missing), 'share-rolled-back', 'made-private');
  assert.match(e2.message, /uploaded trace was not found/);

  const pub = fakeHub({ dropUpload: true });
  const e3 = await rejectsWith(share(pub, { visibility: 'public' }), 'share-rolled-back', 'made-private');
  assert.equal(e3.data.share.stage, 'verify');
});

test('repo disappears between the last check and the commit: no bytes land anywhere', async () => {
  transcript('hello');
  for (const visibility of ['gated', 'public']) {
    const h = fakeHub({ beforeCommit: (repo, hub) => hub.repos.delete(repo) });
    const e = await rejectsWith(share(h, { visibility }), 'share-rolled-back', 'deleted');
    assert.match(e.message, /no longer exists/);
    assert.equal(h.repos.size, 0, `${visibility}: the upload created a repo`);
    assert.ok(!kinds(h).includes('private') && !kinds(h).includes('delete'));
  }
});

test('repo replaced between the last check and the commit: the commit is refused, the other repo untouched', async () => {
  transcript('hello');
  for (const visibility of ['gated', 'public']) {
    const h = fakeHub({ beforeCommit: (repo, hub) => hub.replace(repo) });
    const e = await rejectsWith(share(h, { visibility }), 'share-rolled-back', 'not-uploaded');
    assert.match(e.message, /replaced by another one before the upload; nothing was written to it/);
    const [other] = h.repos.values();
    assert.deepEqual(other.files, ['.gitattributes'], `${visibility}: trace bytes reached the replacement`);
    assert.equal(other.private, false);
    assert.equal(h.state.wroteToExisting, false);
    assert.ok(!kinds(h).includes('private') && !kinds(h).includes('delete'), 'rollback touched a repo that is not ours');
  }
});

test('repo gone, replaced, ungated or not empty at the pre-upload check: nothing uploaded', async () => {
  transcript('hello');
  // Gated flow: info #1 is the gate verify, #2 the pre-upload check. Public: #1 bind, #2 check.
  const cases = [
    ['gone', (n, repo, hub) => { if (n === 2) hub.repos.delete(repo); }, 'not-uploaded', /disappeared before the upload/],
    ['replaced', (n, repo, hub) => { if (n === 2) hub.replace(repo); }, 'not-uploaded', /could not be confirmed.*no other dataset was touched/],
    ['ungated', (n, repo, hub) => { if (n === 2) hub.repos.get(repo).gated = false; }, 'deleted', /changed before the upload\. Nothing was uploaded, and the dataset was deleted/],
    ['not empty', (n, repo, hub) => { if (n === 2) hub.repos.get(repo).files.push('x.jsonl'); }, 'deleted', /changed before the upload/],
  ];
  for (const [label, onInfo, outcome, msg] of cases) {
    const h = fakeHub({ onInfo });
    const e = await rejectsWith(share(h), 'share-bind-failed', outcome);
    assert.match(e.message, msg, label);
    assert.ok(!kinds(h).includes('upload'), `${label}: uploaded anyway`);
    if (outcome === 'not-uploaded') assert.ok(!kinds(h).includes('delete'), `${label}: deleted a repo that is not ours`);
  }
});

test('public upload fails: rolled back the same way', async () => {
  transcript('hello');
  const h = fakeHub({ fail: { upload: true } });
  await rejectsWith(share(h, { visibility: 'public' }), 'share-rolled-back', 'made-private');
  assert.deepEqual(kinds(h).slice(0, 4), ['create', 'info', 'info', 'upload'], 'public: no gate step');
});

test('a secret blocks a GATED share too, before the Hub is touched', async () => {
  const pat = ['github', '_pat_', '11ABCDEFG0', 'x'.repeat(12), '_', 'y'.repeat(59)].join('');
  transcript(`my token is ${pat}`);
  for (const visibility of ['gated', 'public']) {
    const h = fakeHub();
    const e = await rejectsWith(share(h, { visibility }), 'redaction-blocked', null);
    assert.equal(e.statusCode, 409);
    assert.ok(e.data.hits['github-token'] >= 1, 'trace and briefing both hit');
    assert.deepEqual(h.calls, [], `${visibility}: the Hub was called`);
  }
  // An email is redacted but does not block.
  transcript('mail me at someone@example.com');
  const out = await share(fakeHub());
  assert.ok(out.redaction.email >= 1);
});

test('the API envelope carries the share outcome to the UI', () => {
  let sent;
  const res = { writableEnded: false, destroyed: false, headersSent: false, removeHeader() {},
    status(c) { this.code = c; return this; }, json(b) { sent = b; } };
  const share = { stage: 'upload', outcome: 'exposed', url: 'X' };
  apiErrorHandler(new ApiError(424, 'share-exposed', 'This trace may be public at X', { share }),
    { path: '/api/sessions/s1/share' }, res, () => {});
  assert.equal(res.code, 424);
  assert.deepEqual(sent, { share, error: 'This trace may be public at X', code: 'share-exposed' });
});
