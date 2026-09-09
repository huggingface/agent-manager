import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { DATA_DIR } from './config.js';

export const CRONS_FILE = path.join(DATA_DIR, 'crons.json');
const MAX_TIMER_MS = 2_147_000_000;
const VALID_STATES = new Set(['running', 'stopped']);

let jobs = [];
let fireJob = null;
const timers = new Map();

const cleanText = (value, field, max = 160) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} required`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
  return text;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function persist() {
  try {
    fs.mkdirSync(path.dirname(CRONS_FILE), { recursive: true });
    const tmp = `${CRONS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CRONS_FILE);
  } catch (e) {
    // A transient bucket/FUSE write must not take down the process that owns
    // every live terminal. Match the session store's failure posture.
    console.error('[crons.persist]', e && e.message);
  }
}

export function validateSchedule(value, id = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schedule required');
  const cron = cleanText(value.cron, 'schedule.cron', 120).replace(/\s+/g, ' ');
  if (cron.split(' ').length !== 5) throw new Error('schedule.cron must use the standard five fields: minute hour day month weekday');
  const tz = cleanText(value.tz, 'schedule.tz', 100);
  try {
    // Intl is the runtime authority for IANA zone names; cron-parser then
    // applies that zone (including DST) when it advances the expression.
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date());
    CronExpressionParser.parse(cron, { tz, hashSeed: id || 'agent-manager-cron' }).next();
  } catch (e) {
    throw new Error(`invalid schedule: ${e && e.message ? e.message : e}`);
  }
  return { cron, tz };
}

export function nextOccurrence(schedule, after = new Date(), id = '') {
  const valid = validateSchedule(schedule, id);
  return CronExpressionParser.parse(valid.cron, {
    currentDate: after,
    tz: valid.tz,
    hashSeed: id || 'agent-manager-cron',
  }).next().toISOString();
}

function normalizeInput(input, existing = null) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const merged = existing ? {
    ...existing,
    ...src,
    agent: src.agent === undefined ? existing.agent : src.agent,
    schedule: src.schedule === undefined ? existing.schedule : src.schedule,
  } : src;
  const agent = merged.agent;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) throw new Error('agent required');
  const state = merged.state === undefined ? 'running' : merged.state;
  if (!VALID_STATES.has(state)) throw new Error("state must be 'running' or 'stopped'");
  const id = existing?.id || `cron_${crypto.randomBytes(5).toString('hex')}`;
  return {
    ...(existing || {}),
    id,
    name: cleanText(merged.name, 'name'),
    agent: {
      name: cleanText(agent.name, 'agent.name'),
      cli: cleanText(agent.cli, 'agent.cli', 64),
    },
    prompt: cleanText(merged.prompt, 'prompt', 100_000),
    schedule: validateSchedule(merged.schedule, id),
    runOnRestart: merged.runOnRestart === true,
    state,
  };
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function armExisting(job) {
  clearTimer(job.id);
  if (!fireJob || job.state !== 'running' || !job.next) return;
  const target = Date.parse(job.next);
  if (!Number.isFinite(target)) return;
  const delay = target - Date.now();
  const timer = setTimeout(() => {
    timers.delete(job.id);
    const current = jobs.find((candidate) => candidate.id === job.id);
    if (!current || current.state !== 'running' || current.next !== job.next) return;
    if (Date.now() + 250 < target) {
      armExisting(current);
      return;
    }
    // Advance before dispatch. If delivery is slow, fails, or overlaps another
    // run, this occurrence is still consumed exactly once. Computing from now
    // deliberately skips times missed while the process was unavailable.
    current.next = nextOccurrence(current.schedule, new Date(Math.max(Date.now(), target)), current.id);
    persist();
    armExisting(current);
    Promise.resolve(fireJob(current.id, 'schedule')).catch((e) =>
      console.error('[crons.fire]', current.id, e && e.message));
  }, Math.max(0, Math.min(MAX_TIMER_MS, delay)));
  timer.unref?.();
  timers.set(job.id, timer);
}

function resetNext(job, now = new Date()) {
  job.next = job.state === 'running' ? nextOccurrence(job.schedule, now, job.id) : null;
}

export function init(now = new Date()) {
  for (const id of timers.keys()) clearTimer(id);
  fireJob = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CRONS_FILE, 'utf8'));
    jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    jobs = [];
  }
  const valid = [];
  for (const raw of jobs) {
    try {
      const job = normalizeInput(raw, raw && raw.id ? raw : null);
      job.createdAt = raw.createdAt || now.toISOString();
      job.updatedAt = raw.updatedAt || job.createdAt;
      if (raw.last && typeof raw.last === 'object') job.last = raw.last;
      resetNext(job, now); // stale persisted times are never replayed
      valid.push(job);
    } catch (e) {
      console.error('[crons.load]', raw && raw.id, e && e.message);
    }
  }
  jobs = valid;
  persist();
  return list();
}

export function list() {
  return jobs.map(clone);
}

export function get(id) {
  const job = jobs.find((candidate) => candidate.id === id);
  return job ? clone(job) : null;
}

export function create(input, now = new Date()) {
  const job = normalizeInput(input);
  job.createdAt = now.toISOString();
  job.updatedAt = job.createdAt;
  resetNext(job, now);
  jobs.push(job);
  persist();
  armExisting(job);
  return clone(job);
}

export function update(id, patch, now = new Date()) {
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return null;
  const before = jobs[index];
  const job = normalizeInput(patch, before);
  job.updatedAt = now.toISOString();
  const scheduleChanged = job.schedule.cron !== before.schedule.cron || job.schedule.tz !== before.schedule.tz;
  const resumed = before.state !== 'running' && job.state === 'running';
  if (job.state !== 'running') job.next = null;
  else if (scheduleChanged || resumed || !before.next) resetNext(job, now);
  jobs[index] = job;
  persist();
  armExisting(job);
  return clone(job);
}

export function remove(id) {
  const before = jobs.length;
  jobs = jobs.filter((job) => job.id !== id);
  if (jobs.length === before) return false;
  clearTimer(id);
  persist();
  return true;
}

export function recordLast(id, last) {
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) return null; // deleting a firing job must not recreate it
  // Overlap is allowed. Completion order therefore need not be start order;
  // never let an older, slower delivery replace the genuinely latest fire.
  if (job.last && Date.parse(job.last.at) > Date.parse(last.at)) return clone(job);
  job.last = clone(last);
  persist();
  return clone(job);
}

export function startScheduler(handler, { restartDelayMs = 1_500 } = {}) {
  fireJob = handler;
  const restartAt = Date.now() + restartDelayMs;
  // Capture the boot-time occurrence before arming it. By the restart callback
  // it may already have fired and advanced `next`, which would hide the very
  // collision this check prevents.
  const restartJobs = jobs
    .filter((job) => job.state === 'running' && job.runOnRestart)
    .map((job) => ({ id: job.id, scheduledAt: Date.parse(job.next) }));
  for (const job of jobs) armExisting(job);
  if (restartJobs.length) {
    const timer = setTimeout(() => {
      for (const { id, scheduledAt } of restartJobs) {
        const current = jobs.find((job) => job.id === id);
        if (!current || current.state !== 'running' || !current.runOnRestart) continue;
        // One boot intent must not become two prompts. A scheduled occurrence
        // within one restart-delay of the planned restart fire substitutes for
        // it; this is startup de-duplication, not an overlap guard for ordinary
        // runs. Use the captured time so this still holds if schedule fired first.
        if (Number.isFinite(scheduledAt) && Math.abs(scheduledAt - restartAt) <= restartDelayMs) continue;
        Promise.resolve(fireJob(id, 'restart')).catch((e) =>
          console.error('[crons.restart]', id, e && e.message));
      }
    }, restartDelayMs);
    timer.unref?.();
  }
}
