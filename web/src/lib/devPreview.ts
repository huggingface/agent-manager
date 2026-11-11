import type { DevPreviewPr, DevPreviewRunning } from '../api';

const who = (p: DevPreviewPr) => {
  const role = p.permission ? `${p.permission} permission` : 'permission unknown';
  const where = `branch on ${p.headRepo || 'unknown repo'}`;
  return `#${p.number} by ${p.author || 'unknown'} (${role}), ${where}`;
};

/**
 * The one confirmation before a switch: who wrote the code, where it lives,
 * and plainly what running it grants. Main gets its own wording.
 */
export function switchConfirmText(prs: DevPreviewPr[]): string {
  if (!prs.length) return 'Switch this Space back to main (the image build)? The app server restarts, and so does every running agent.';
  return [
    `Run ${prs.length > 1 ? 'these PRs' : 'this PR'} on this Space?`,
    '',
    ...prs.map(who),
    '',
    'This code will run with this Space\'s secrets, bucket and agents: its install scripts and build as soon as you confirm, then as the app server itself. The app server restarts, and so does every running agent.',
  ].join('\n');
}

/** The part of GET /api/dev-preview/prs the comparison reads. */
export interface DevPreviewPrList { ok?: boolean; main?: { sha: string | null }; prs?: DevPreviewPr[] }

/**
 * What changed on GitHub since the running PR build was made, from a fresh PR
 * list. Running PR numbers, in running order:
 * - `newer`: still open, but the head moved;
 * - `closed`: no longer in the open list (merged or closed);
 * - `refused`: still open, but the server's rule now refuses it (`allowed: false`).
 * `mainMoved` is true only when both SHAs are known and differ.
 */
export interface DevPreviewFreshness { newer: number[]; mainMoved: boolean; closed: number[]; refused: number[] }

/**
 * Compare the running build with the PR list, so the Settings panel and the
 * sidebar row agree on whether "Pull latest" is offered. Null when there is
 * nothing to compare: main (or an unknown release) is running, or the list
 * did not load.
 */
export function compareRunning(running: DevPreviewRunning | null | undefined, list: DevPreviewPrList | null | undefined): DevPreviewFreshness | null {
  if (!running || running.kind !== 'prs' || !running.prs.length) return null;
  if (!list || list.ok === false || !Array.isArray(list.prs)) return null;
  const open = new Map(list.prs.map((p) => [p.number, p]));
  const out: DevPreviewFreshness = { newer: [], mainMoved: false, closed: [], refused: [] };
  for (const r of running.prs) {
    const now = open.get(r.number);
    if (!now) out.closed.push(r.number);
    else if (now.allowed === false) out.refused.push(r.number);
    else if (now.sha !== r.sha) out.newer.push(r.number);
  }
  const main = list.main?.sha;
  out.mainMoved = !!running.base && !!main && main !== running.base;
  return out;
}

/** "Pull latest" re-runs the switch for the running PRs; only worth it when something moved and every PR can still run. */
export const canPullLatest = (f: DevPreviewFreshness | null): f is DevPreviewFreshness =>
  !!f && !f.closed.length && !f.refused.length && (f.newer.length > 0 || f.mainMoved);

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The sidebar's short form: "#244 has new commits", "main has new commits", "#244 and main have new commits". */
export function newCommitsText(f: DevPreviewFreshness): string {
  const what = [...f.newer.map((n) => `#${n}`), ...(f.mainMoved ? ['main'] : [])];
  return `${list(what)} ${what.length > 1 ? 'have' : 'has'} new commits`;
}

/** "#244", "#244 and #190", "#244, #190 and #191". */
export const prList = (numbers: number[]): string => list(numbers.map((n) => `#${n}`));
