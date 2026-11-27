import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JOB_SCRIPT, DEFAULT_EXCLUDE, parseBackupLogs } from '../src/backup.js';

function runJob(fail = false, source = 'ns/source', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-job-'));
  const work = path.join(dir, 'work');
  const fakeToken = 'hf_' + 'A'.repeat(34);
  fs.writeFileSync(path.join(dir, 'huggingface_hub.py'), `
import os, logging
from types import SimpleNamespace
class FakeError(ValueError):
 response = SimpleNamespace(status_code=403)
 request_id = "abcdef12-3456-7890-abcd-abcdef123456"
class HfApi:
 def bucket_info(self, *a): return SimpleNamespace(private=True)
 def dataset_info(self, *a): return SimpleNamespace(private=True)
 def create_repo(self, *a, **kw): pass
 def delete_bucket(self, *a, **kw):
  if not hasattr(self, 'created') and not kw.get('missing_ok'): raise RuntimeError('missing_ok required')
  print('DELETE ' + str(kw.get('missing_ok', False)))
 def create_bucket(self, *a, **kw): self.created = True; print('CREATE')
 def list_bucket_tree(self, *a, **kw):
  return [SimpleNamespace(path=p, size=1, xet_hash='hash') for p in ['repo/.git/config', 'repo/.git/objects/a', 'other/.git/HEAD', 'linked/.git', 'node_modules/pkg/.git/config', 'data/dump.bin', '.config/google-chrome-for-testing/Crash Reports/dump', 'x/Crashpad/dump'] + ${JSON.stringify(options.extraPaths || [])}]
 def batch_bucket_files(self, *a, **kw): print('COPY ' + ','.join(x[3] for x in kw['copy']))
 def sync_bucket(self, src, dest):
  if ${options.syncFail ? 'True' : 'False'}: raise RuntimeError('failed with ' + ${JSON.stringify(fakeToken)})
  os.makedirs(dest + '/data', exist_ok=True)
  if ${options.stale ? 'True' : 'False'}: open(dest + '/stale', 'w').write('stale')
  open(dest + '/data/dump.bin', 'wb').write(b'\\x00' + ${JSON.stringify(fakeToken)}.encode() + b'\\xff')
 def upload_folder(self, **kw):
  data = open(kw['folder_path'] + '/data/dump.bin', 'rb').read()
  print('BINARY ' + data.hex())
  if ${fail ? 'True' : 'False'}:
   logging.getLogger('huggingface_hub').warning('retry ' + ${JSON.stringify(fakeToken)})
   print('diagnostic ' + ${JSON.stringify(fakeToken)})
   raise FakeError(${JSON.stringify(options.errorMessage || 'Offending files: \"data/dump.bin\"')} + ' (token: ' + ${JSON.stringify(fakeToken)} + ')')
`);
  try {
    assert.ok(JOB_SCRIPT.includes('WORK = "/work"'));
    const script = JOB_SCRIPT.replace('WORK = "/work"', `WORK = ${JSON.stringify(work)}`)
      .replace('pip install -q "huggingface_hub[hf_xet]"', ':');
    const env = { ...process.env, PYTHONPATH: dir, AM_SOURCE: source, AM_DATASET: 'ns/dataset', AM_STAGING: 'ns/staging', AM_EXCLUDE: 'node_modules', HF_HUB_OFFLINE: '1', HF_HOME: dir };
    for (const key of Object.keys(env)) if (key.includes('TOKEN') || key.includes('SECRET')) delete env[key];
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    return { ...result, fakeToken };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the Job starts with empty staging, excludes Git and Chrome and scrubs binary bytes', () => {
  assert.ok(DEFAULT_EXCLUDE.includes('.config/google-chrome-for-testing'));
  const r = runJob();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('DELETE True') >= 0 && r.stdout.indexOf('DELETE True') < r.stdout.indexOf('CREATE'));
  const copy = r.stdout.split('\n').find(l => l.startsWith('COPY '));
  assert.equal(copy, 'COPY data/dump.bin');
  assert.match(r.stdout, /skipped 3 \.git folders; push or use git bundle/);
  assert.match(r.stdout, new RegExp('BINARY 00' + Buffer.from('[REDACTED-SECRET]' + '#'.repeat(r.fakeToken.length - 17)).toString('hex') + 'ff'));
  assert.doesNotMatch(r.stdout, /retry/);
  assert.equal(parseBackupLogs(r.stdout).gitFoldersSkipped, 3);
  assert.match(r.stdout, /scrub: altered data\/dump.bin/);
});

test('the source bucket cannot be deleted when configured as staging', () => {
  const r = runJob(false, 'NS/STAGING');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /staging bucket is the source bucket/);
  assert.doesNotMatch(r.stdout, /DELETE|CREATE/);
});

test('the Job and recorded reason never echo a token from a Hub rejection', () => {
  const r = runJob(true);
  assert.equal(r.status, 1);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(r.fakeToken));
  assert.doesNotMatch(r.stderr, /Traceback|retry/);
  const details = parseBackupLogs(r.stdout);
  assert.equal(details.reason, 'refusing to commit: type=FakeError status=403 request_id=abcdef12-3456-7890-abcd-abcdef123456 paths=1 data/dump.bin');
  assert.ok(!JSON.stringify(details).includes(r.fakeToken));
  assert.equal(parseBackupLogs('BadRequestError: ' + r.fakeToken).reason, null);
});

test('a failed Job records only its safe refusal and skipped folder count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-state-'));
  const fakeToken = 'hf_' + 'A'.repeat(34);
  const logs = `BadRequestError: ${fakeToken}\nscope: skipped 2 .git folders; push or use git bundle for local-only work\nrefusing to commit: data/dump.bin\n`;
  try {
  fs.writeFileSync(path.join(dir, 'hf'), `#!/bin/sh\nif [ "$2" = inspect ]; then echo '{"status":{"stage":"ERROR","message":"Job failed"}}'; else printf '%s' '${logs}'; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ jobId: 'job1', startedAt: Date.now() }));
  const code = `import { tick } from ${JSON.stringify(new URL('../src/backup.js', import.meta.url).href)}; await tick({backup:{every:'never'}});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, DATA_DIR: dir, HF_TOKEN: 'fake', AM_BACKUP_SOURCE: 'ns/source' } });
  assert.equal(r.status, 0, r.stderr);
  const state = fs.readFileSync(path.join(dir, 'backup-state.json'), 'utf8');
  assert.equal(JSON.parse(state).lastFailure.reason, 'refusing to commit: data/dump.bin');
  assert.equal(JSON.parse(state).gitFoldersSkipped, 2);
  assert.ok(!state.includes(fakeToken));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('unexpected staging files stop the commit', () => {
  const r = runJob(false, 'ns/source', { stale: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refusing to commit: staging contained unexpected files/);
  assert.doesNotMatch(r.stdout, /BINARY/);
});

test('controlled backup refusals survive parsing, arbitrary text does not', () => {
  for (const line of ['refusing to back up: staging bucket is the source bucket',
    'refusing to back up: bucket ns/source is not private',
    'refusing to back up: dataset ns/dataset is not private',
    'refusing to back up: step=sync type=OSError status=403 request_id=unknown']) {
    assert.equal(parseBackupLogs(line).reason, line);
  }
  assert.equal(parseBackupLogs('refusing to back up: secret stuff').reason, null);
});

test('completed outcomes expose Git count, preserve it on early failures, and guard the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-outcome-'));
  try {
    fs.writeFileSync(path.join(dir, 'hf'), `#!/bin/sh
if [ "$2" = inspect ]; then echo '{"status":{"stage":"'"$FAKE_STAGE"'"}}';
elif [ "$2" = logs ]; then printf '%s\\n' "$FAKE_LOG";
else echo '{"private":true}'; fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ jobId: 'one', startedAt: Date.now(), gitFoldersSkipped: 9 }));
    const moduleUrl = JSON.stringify(new URL('../src/backup.js', import.meta.url).href);
    const code = `globalThis.fetch = async () => ({ok:true,text:async()=>'{"name":"ns"}'});
const {tick,backupStatus,runBackupNow}=await import(${moduleUrl});
await tick({backup:{every:'never'}});
const status=await backupStatus({backup:{every:'never',dataset:'ns/dataset',staging:'ns/staging'}});
console.log(JSON.stringify({count:status.gitFoldersSkipped}));
try { await runBackupNow({backup:{dataset:'ns/dataset',staging:'NS/SOURCE'}}); process.exit(2); }
catch(e) { if(e.statusCode!==400) throw e; }`;
    const env = { ...process.env, PATH: dir + ':' + process.env.PATH, DATA_DIR: dir, HF_TOKEN: 'fake', AM_BACKUP_SOURCE: 'ns/source', FAKE_STAGE: 'COMPLETED', FAKE_LOG: 'scope: skipped 3 .git folders; push or use git bundle for local-only work' };
    let r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"count":3/);
    fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ jobId: 'two', startedAt: Date.now(), gitFoldersSkipped: 3 }));
    env.FAKE_STAGE = 'ERROR'; env.FAKE_LOG = 'failure before scope';
    r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"count":3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('an unexpected failure reports a controlled step and exception without a traceback or token', () => {
  const r = runJob(false, 'ns/source', { syncFail: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refusing to back up: step=sync type=RuntimeError status=unknown request_id=unknown/);
  assert.doesNotMatch(r.stdout, /Traceback/);
  assert.ok(!r.stdout.includes(r.fakeToken));
  assert.match(parseBackupLogs(r.stdout).reason, /step=sync/);
});

test('literal-first patterns preserve boundary matches for all secret types', () => {
  const start = JOB_SCRIPT.indexOf('    AFT = ');
  const end = JOB_SCRIPT.indexOf('    def safe_path', start);
  assert.ok(start >= 0 && end > start);
  const patterns = JOB_SCRIPT.slice(start, end).replace(/^    /gm, '');
  const code = `import re, random
${patterns}
old = [r'(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9_-])', r'(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])', r'(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])', r'(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_-])', r'(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{16}(?![A-Za-z0-9_-])', r'(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])']
secrets = ['hf_'+'A'*34, 'sk-'+'B'*20, 'sk-ant-'+'C'*24, 'ghp_'+'D'*36, 'AKIA'+'E'*16, 'AIza'+'F'*35]
for (_, new), prior in zip(SECRETS, old):
 for token in secrets:
  for before in ['', 'x', '-', '_', '/', ' ']:
   for after in ['', 'x', '-', '_', '/', ' ']:
    data=(before+token+after).encode()
    assert [m.span() for m in new.finditer(data)] == [m.span() for m in re.compile(prior.encode()).finditer(data)]
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { PATH: process.env.PATH, HF_HUB_OFFLINE: '1' } });
  assert.equal(r.status, 0, r.stderr);
});


test('offending paths are whole, ordered, escaped and counted', () => {
  const extraPaths = ['install.sh', 'workspaces/x/install.sh', 'main', 'odd/(ü)+@,file', 'five', 'six', 'seven'];
  const errorMessage = 'refs/heads/main "workspaces/x/install.sh" "odd/(ü)+@,file" "data/dump.bin" "five" "six" "seven"';
  const r = runJob(true, 'ns/source', { extraPaths, errorMessage });
  assert.equal(r.status, 1);
  const reason = parseBackupLogs(r.stdout).reason;
  assert.match(reason, /paths=6 workspaces\/x\/install.sh, odd\/\(\\xfc\)\+@,file, data\/dump.bin, five, six \(\+1 more\)/);
  assert.doesNotMatch(reason, /paths=7/);
  assert.ok(!reason.includes(r.fakeToken));
});

test('the shell wrapper redacts install errors and preserves their failure status', () => {
  const token = 'hf_' + 'A'.repeat(34);
  const script = `pip() { printf '%s\\n' "$1" "${token}"; return 1; }\n` + JOB_SCRIPT;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(token));
  assert.match(r.stdout, /refusing to back up: step=install type=InstallError/);
  assert.match(parseBackupLogs(r.stdout).reason, /step=install/);
});
