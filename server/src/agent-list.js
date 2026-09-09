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
