import { ApiError } from './api-errors.js';
// Session and group lookup by human-typed names — the roster's `?group=`
// filter, the spawn route's `group=` target, the cron "which session runs this
// job" lookup.
//
// Names here are things people and agents type: `?group=hunter` for a group the
// operator called "Hunter", a cron pointing at "Reviewer" when the pane was
// renamed "reviewer". An exact comparison turned every one of those into a
// silent empty result (or, for crons, a duplicate session spawned beside the
// one it was meant to reuse). Both sides of every comparison go through
// normalizeName() so the rule lives in one place: trim, fold case, and NFC so
// a composed "é" matches a decomposed one.

export function normalizeName(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFC').trim().toLocaleLowerCase('en');
}

/** True when both are non-blank and equal after normalizeName(). */
export const sameName = (a, b) => {
  const left = normalizeName(a);
  return left !== '' && left === normalizeName(b);
};

/** Preserve exact targets; refuse ambiguous normalized names instead of guessing. */
export function findByName(items, name) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  const exact = items.filter((item) => item?.name === name);
  if (exact.length === 1) return exact[0];
  const matches = items.filter((item) => normalizeName(item && item.name) === wanted);
  if (matches.length > 1) throw new Error(`ambiguous name '${name}'; use an exact unique name`);
  return matches[0] || null;
}

/** Sessions of the group called `group` (case-insensitive); no filter = all rows. */
export function filterAgentsByGroup(rows, group) {
  const wanted = normalizeName(group);
  if (!wanted) return rows;
  return rows.filter((row) => normalizeName(row.group) === wanted);
}

// Conversation activity is independent of screen changes, import and creation.
const timestamp = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : 0;
export function conversationActivity(d) {
  const prompt = timestamp(d?.lastPromptTs);
  const answer = timestamp(d?.lastAnswerTs ?? d?.lastAssistantTs);
  const last = Math.max(prompt, answer);
  return {lastPromptAt: prompt ? new Date(prompt).toISOString() : null,
    lastAnswerAt: answer ? new Date(answer).toISOString() : null,
    lastActivityAt: last ? new Date(last).toISOString() : null,
    activityKind: last ? (answer >= prompt ? 'answer' : 'prompt') : null};
}
export function agentListOptions(q, {cliExists = () => true} = {}) {
  const bad = field => {throw new ApiError(400, 'invalid-input', `Invalid agent filter: ${field}`);};
  const allowed = new Set(['from','self','group','state','cli','active_within_minutes','include_archived','limit','sort']);
  for (const [k,v] of Object.entries(q)) if (!allowed.has(k) || typeof v !== 'string') bad(k);
  const csv = key => {
    if (q[key] === undefined) return null;
    const values = q[key].split(',').map(v=>v.trim());
    if (values.some(v=>!v)) bad(key);
    return new Set(values);
  };
  const states = csv('state'), clis = csv('cli');
  if (states && [...states].some(v=>!['working','waiting','idle','stopped','unknown'].includes(v))) bad('state');
  if (clis && [...clis].some(v=>!cliExists(v))) bad('cli');
  const integer = (key,min,max) => {
    if (q[key] === undefined) return null;
    const n = Number(q[key]);
    if (!/^\d+$/.test(q[key]) || !Number.isSafeInteger(n) || n<min || n>max) bad(key);
    return n;
  };
  const group = q.group === undefined ? null : q.group.trim();
  if (group !== null && (!group || group.length>120)) bad('group');
  if (q.include_archived !== undefined && !['true','false'].includes(q.include_archived)) bad('include_archived');
  const sort = q.sort || null;
  if (sort !== null && !['recent_conversation','recent_answer','recent_prompt','created','name'].includes(sort)) bad('sort');
  return {group,states,clis,minutes:integer('active_within_minutes',0,52560000),limit:integer('limit',1,1000),
    includeArchived:q.include_archived==='true',sort};
}
export function filterAgentRows(rows, options, now = Date.now()) {
  let result = filterAgentsByGroup(rows, options.group).filter(row =>
    (options.includeArchived || !row.archivedAt) &&
    (!options.states || options.states.has(row.state)) &&
    (!options.clis || options.clis.has(row.cli)) &&
    (options.minutes === null || (row.lastActivityAt && Date.parse(row.lastActivityAt) >= now-options.minutes*60000)));
  const key = {recent_conversation:'lastActivityAt',recent_answer:'lastAnswerAt',recent_prompt:'lastPromptAt',created:'createdAt'}[options.sort];
  if (key) result.sort((a,b)=>(Date.parse(b[key])||0)-(Date.parse(a[key])||0)||a.id.localeCompare(b.id));
  else if (options.sort === 'name') result.sort((a,b)=>normalizeName(a.name).localeCompare(normalizeName(b.name))||a.id.localeCompare(b.id));
  return options.limit === null ? result : result.slice(0,options.limit);
}
