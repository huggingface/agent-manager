import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// backupHealth reads DATA_DIR/backup-state.json, so point DATA_DIR at a temp dir
// before the module resolves it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-health-'));
process.env.DATA_DIR = dir;
process.env.AM_BACKUP_SOURCE = 'ns/bucket';
process.env.HF_TOKEN = 'hf_test';
const { backupHealth, EVERY_MS } = await import('../src/backup.js');

const state = (o) => fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify(o));
const HOUR = EVERY_MS['1h'];

test('silence when the feature is off, whatever the state says', () => {
  state({ lastFailure: { at: Date.now(), jobId: 'j', stage: 'ERROR' }, failures: 9 });
  assert.equal(backupHealth({ backup: { every: 'never' } }), null);
  assert.equal(backupHealth({}), null);
  assert.equal(backupHealth(undefined), null);
});

test('silence when the last run succeeded — the normal case shows nothing', () => {
  state({ lastSuccessAt: Date.now() - 60_000, failures: 0, lastFailure: null });
  assert.equal(backupHealth({ backup: { every: '1h' } }), null);
});

test('a failed run surfaces, with the reason and the count', () => {
  state({
    failures: 3,
    lastSuccessAt: Date.now() - 60_000,
    lastFailure: { at: 1785900000000, jobId: 'j1', stage: 'ERROR', message: 'Job timeout', reason: "cannot update files under a '.cache/' folder" },
  });
  const h = backupHealth({ backup: { every: '1h' } });
  assert.equal(h.failing, true);
  assert.equal(h.failures, 3);
  assert.equal(h.jobId, 'j1');
  assert.equal(h.message, 'Job timeout');
  assert.match(h.reason, /\.cache/);
  assert.match(h.jobsUrl, /^https:\/\/huggingface\.co\/settings\/jobs\?label=/);
});

// The failure mode this feature exists for: nothing is erroring, because nothing
// is running. Looks perfectly healthy without a staleness check.
test('a silent stall surfaces as stale, not as failing', () => {
  state({ lastSuccessAt: Date.now() - HOUR * 4, failures: 0, lastFailure: null });
  const h = backupHealth({ backup: { every: '1h' } });
  assert.ok(h, 'four hours with no success on an hourly schedule must not read as healthy');
  assert.equal(h.stale, true);
  assert.equal(h.failing, false);

  // Within tolerance: a couple of missed ticks is not an alarm.
  state({ lastSuccessAt: Date.now() - HOUR * 2, failures: 0, lastFailure: null });
  assert.equal(backupHealth({ backup: { every: '1h' } }), null);
});

test('never having succeeded goes stale from when it was switched on', () => {
  // Armed long ago, no success ever — this Space's actual situation.
  state({ firstArmedAt: Date.now() - HOUR * 10, failures: 0, lastFailure: null });
  const h = backupHealth({ backup: { every: '1h' } });
  assert.equal(h.stale, true);
  assert.equal(h.lastSuccessAt, null);
  // Just armed: give it a chance before complaining.
  state({ firstArmedAt: Date.now(), failures: 0, lastFailure: null });
  assert.equal(backupHealth({ backup: { every: '1h' } }), null);
});

test('the staleness window scales with the interval', () => {
  state({ lastSuccessAt: Date.now() - HOUR * 4, failures: 0, lastFailure: null });
  // 4h is stale hourly, but nowhere near stale on a daily schedule.
  assert.ok(backupHealth({ backup: { every: '1h' } }));
  assert.equal(backupHealth({ backup: { every: '24h' } }), null);
});

test('an empty state file is not a problem', () => {
  state({});
  assert.equal(backupHealth({ backup: { every: '1h' } }), null);
});
