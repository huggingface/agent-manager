import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-crons-unit-'));
process.env.DATA_DIR = root;
const crons = await import('../src/crons.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('timezone is part of the calculation, including seasonal offsets', () => {
  const schedule = { cron: '0 9 * * *', tz: 'Europe/Zurich' };
  assert.equal(crons.nextOccurrence(schedule, new Date('2026-08-19T21:30:00Z'), 'daily'), '2026-08-20T07:00:00.000Z');
  assert.equal(crons.nextOccurrence(schedule, new Date('2027-01-02T10:00:00Z'), 'daily'), '2027-01-03T08:00:00.000Z');
});

test('only five-field cron and real IANA timezones are accepted', () => {
  assert.throws(() => crons.validateSchedule({ cron: '0 0 9 * * *', tz: 'UTC' }), /five fields/);
  assert.throws(() => crons.validateSchedule({ cron: '0 9 * * *', tz: 'Moon\/Tranquility' }), /invalid schedule/);
  assert.throws(() => crons.validateSchedule({ cron: '70 9 * * *', tz: 'UTC' }), /invalid schedule/);
});

test('jobs persist, stop without deletion, resume from now, and never replay stale next times', () => {
  crons.init(new Date('2026-08-19T12:00:00Z'));
  const job = crons.create({
    name: 'daily index',
    agent: { name: 'indexer', cli: 'claude' },
    prompt: 'Refresh the index.',
    schedule: { cron: '0 9 * * *', tz: 'UTC' },
    runOnRestart: true,
  }, new Date('2026-08-19T12:00:00Z'));
  assert.equal(job.next, '2026-08-20T09:00:00.000Z');
  assert.ok(fs.existsSync(path.join(root, 'crons.json')));

  const stopped = crons.update(job.id, { state: 'stopped' }, new Date('2026-08-19T13:00:00Z'));
  assert.equal(stopped.next, null);
  assert.equal(stopped.prompt, 'Refresh the index.');
  assert.equal(crons.list().length, 1);

  const resumed = crons.update(job.id, { state: 'running' }, new Date('2026-08-21T10:00:00Z'));
  assert.equal(resumed.next, '2026-08-22T09:00:00.000Z');

  // Loading after downtime ignores the persisted Aug 22 occurrence and moves
  // directly to the next future one. Missed occurrences are not catch-up work.
  crons.init(new Date('2026-08-25T10:00:00Z'));
  assert.equal(crons.get(job.id).next, '2026-08-26T09:00:00.000Z');
});

test('run on restart fires once for enabled running jobs, not stopped ones', async () => {
  const running = crons.get(crons.list()[0].id);
  assert.equal(running.runOnRestart, true);
  const stopped = crons.create({
    name: 'off', agent: { name: 'off-agent', cli: 'codex' }, prompt: 'No.',
    schedule: { cron: '0 * * * *', tz: 'UTC' }, runOnRestart: true, state: 'stopped',
  });
  const fired = [];
  crons.startScheduler((id, trigger) => { fired.push({ id, trigger }); }, { restartDelayMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fired, [{ id: running.id, trigger: 'restart' }]);
  assert.equal(crons.get(stopped.id).state, 'stopped');
});

test('an older overlapping delivery cannot overwrite the newer last run', () => {
  const id = crons.list()[0].id;
  crons.recordLast(id, { at: '2026-08-25T12:02:00.000Z', status: 'ok', durationMs: 20 });
  crons.recordLast(id, { at: '2026-08-25T12:01:00.000Z', status: 'failed', durationMs: 80_000, error: 'late failure' });
  assert.equal(crons.get(id).last.status, 'ok');
  assert.equal(crons.get(id).last.at, '2026-08-25T12:02:00.000Z');
});

test('run on restart coalesces with a schedule due in the same startup window', () => {
  for (const job of crons.list()) crons.remove(job.id);
  const boot = Date.parse('2026-08-19T21:54:57.600Z'); // 2.4s before the minute
  crons.init(new Date(boot));
  const job = crons.create({
    name: 'minute boundary', agent: { name: 'boundary', cli: 'claude' }, prompt: 'Once.',
    schedule: { cron: '* * * * *', tz: 'UTC' }, runOnRestart: true,
  }, new Date(boot));
  assert.equal(Date.parse(job.next) - boot, 2_400);

  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = boot;
  let serial = 0;
  const queued = [];
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0) => {
    const timer = { id: ++serial, at: now + Number(delay), callback, canceled: false, unref() {} };
    queued.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { if (timer) timer.canceled = true; };
  const fires = [];
  try {
    crons.startScheduler((id, trigger) => { fires.push({ id, trigger, at: now }); }, { restartDelayMs: 1_500 });
    const end = boot + 2_500;
    while (true) {
      const due = queued.filter((timer) => !timer.canceled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.canceled = true;
      now = due.at;
      due.callback();
    }
    assert.deepEqual(fires, [{ id: job.id, trigger: 'schedule', at: boot + 2_400 }]);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
