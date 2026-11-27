import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JOB_SCRIPT, DEFAULT_EXCLUDE, parseBackupLogs } from '../src/backup.js';

function runJob(fail = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-job-'));
  const work = path.join(dir, 'work');
  const fakeToken = 'hf_' + 'A'.repeat(34);
  fs.writeFileSync(path.join(dir, 'huggingface_hub.py'), `
import os, logging
from types import SimpleNamespace
class HfApi:
 def bucket_info(self, *a): return SimpleNamespace(private=True)
 def dataset_info(self, *a): return SimpleNamespace(private=True)
 def create_repo(self, *a, **kw): pass
 def delete_bucket(self, *a, **kw): print('DELETE ' + str(kw.get('missing_ok', False)))
 def create_bucket(self, *a, **kw): print('CREATE')
 def list_bucket_tree(self, *a, **kw):
  return [SimpleNamespace(path=p, size=1, xet_hash='hash') for p in ['repo/.git/config', 'repo/.git/objects/a', 'other/.git/HEAD', 'data/dump.bin', '.config/google-chrome-for-testing/dump']]
 def batch_bucket_files(self, *a, **kw): print('COPY ' + ','.join(x[3] for x in kw['copy']))
 def sync_bucket(self, src, dest):
  os.makedirs(dest + '/data', exist_ok=True)
  open(dest + '/data/dump.bin', 'wb').write(b'\\x00' + ${JSON.stringify(fakeToken)}.encode() + b'\\xff')
 def upload_folder(self, **kw):
  data = open(kw['folder_path'] + '/data/dump.bin', 'rb').read()
  print('BINARY ' + data.hex())
  if ${fail ? 'True' : 'False'}:
   logging.getLogger('huggingface_hub').warning('retry ' + ${JSON.stringify(fakeToken)})
   raise ValueError('Offending files: data/dump.bin (token: ' + ${JSON.stringify(fakeToken)} + ')')
`);
  const script = JOB_SCRIPT.split("python - <<'EOPY'\n")[1].split('\nEOPY')[0].replace('WORK = "/work"', `WORK = ${JSON.stringify(work)}`);
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: dir, AM_SOURCE: 'ns/source', AM_DATASET: 'ns/dataset', AM_STAGING: 'ns/staging', AM_EXCLUDE: '.config/google-chrome-for-testing' } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, fakeToken };
}

test('the Job starts with empty staging, excludes Git and Chrome and scrubs binary bytes', () => {
  assert.ok(DEFAULT_EXCLUDE.includes('.config/google-chrome-for-testing'));
  const r = runJob();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('DELETE True') < r.stdout.indexOf('CREATE'));
  const copy = r.stdout.split('\n').find(l => l.startsWith('COPY '));
  assert.equal(copy, 'COPY data/dump.bin');
  assert.match(r.stdout, /skipped 2 \.git folders; push or use git bundle/);
  assert.match(r.stdout, new RegExp('BINARY 00' + '58'.repeat(r.fakeToken.length) + 'ff'));
  assert.doesNotMatch(r.stdout, /retry/);
  assert.equal(parseBackupLogs(r.stdout).gitFoldersSkipped, 2);
});

test('the Job and recorded reason never echo a token from a Hub rejection', () => {
  const r = runJob(true);
  assert.equal(r.status, 1);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(r.fakeToken));
  assert.doesNotMatch(r.stderr, /Traceback|retry/);
  const details = parseBackupLogs(r.stdout + '\n' + r.stderr);
  assert.equal(details.reason, 'refusing to commit: data/dump.bin');
  assert.ok(!JSON.stringify(details).includes(r.fakeToken));
  assert.equal(parseBackupLogs('BadRequestError: ' + r.fakeToken).reason, null);
});

test('a failed Job records only its safe refusal and skipped folder count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-state-'));
  const fakeToken = 'hf_' + 'A'.repeat(34);
  const logs = `BadRequestError: ${fakeToken}\nscope: skipped 2 .git folders; push or use git bundle for local-only work\nrefusing to commit: data/dump.bin\n`;
  fs.writeFileSync(path.join(dir, 'hf'), `#!/bin/sh\nif [ "$2" = inspect ]; then echo '{"status":{"stage":"ERROR","message":"Job failed"}}'; else printf '%s' '${logs}'; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify({ jobId: 'job1', startedAt: Date.now() }));
  const code = `import { tick } from ${JSON.stringify(new URL('../src/backup.js', import.meta.url).href)}; await tick({backup:{every:'never'}});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, DATA_DIR: dir, HF_TOKEN: 'fake', AM_BACKUP_SOURCE: 'ns/source' } });
  assert.equal(r.status, 0, r.stderr);
  const state = fs.readFileSync(path.join(dir, 'backup-state.json'), 'utf8');
  assert.equal(JSON.parse(state).lastFailure.reason, 'refusing to commit: data/dump.bin');
  assert.equal(JSON.parse(state).gitFoldersSkipped, 2);
  assert.ok(!state.includes(fakeToken));
  fs.rmSync(dir, { recursive: true, force: true });
});
