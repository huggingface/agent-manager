// Deploy upstream's TREE as one commit, instead of pushing its history.
//
// The updater used to clone the GitHub repo and `git push --force` it onto the
// Space's `main`. That stopped working the moment any commit anywhere in that
// history added a plain-git binary: HF's pre-receive hook scans every commit in
// the pushed range, and #154 added `docs/images/agent-manager.png` as an
// ordinary blob. #178 moved it to LFS, which fixes the working tree but not the
// history — the old commit is still in the range, so every Space is now stuck
// on "Request failed".
//
// Pushing one commit whose tree IS upstream's tree, parented on what the Space
// already has, puts exactly the same files in place with nothing historical in
// the range. It is also a fast-forward, so `--force` is no longer needed.
//
// LFS objects are a separate transfer and git only sends them from a pre-push
// hook, which a bare `git push` of a ref we built ourselves does not run. So
// they go first and explicitly: a tree full of pointers whose objects never
// arrived is a Space that builds against unreadable files.

/** Recorded in the deploy commit so `check` can tell what is deployed. */
export const UPSTREAM_MARKER = 'Upstream-Commit:';
const MARKER = new RegExp(`^${UPSTREAM_MARKER}\\s*([0-9a-f]{7,40})\\s*$`, 'm');

/** The upstream commit a deploy message names, or null for anything else. */
export function upstreamShaFromMessage(message) {
  return MARKER.exec(String(message || ''))?.[1] || null;
}

export function deployMessage(sha, branch) {
  return `Deploy upstream ${branch} as one commit\n\n`
    + `The files are upstream's tree verbatim. History is not copied, because a\n`
    + `single plain-git binary anywhere in it makes the whole push unacceptable.\n\n`
    + `${UPSTREAM_MARKER} ${sha}\n`;
}

/**
 * Is `latestSha` something this Space is not already running?
 *
 * `deployed` is the upstream commit the last tree deploy recorded; when there
 * is one it is the only honest comparison, because the Space's own HEAD sha is
 * its own and never equals upstream's again. Without one, the Space was
 * force-pushed upstream's history and its sha IS upstream's. Short forms are
 * allowed on either side so an abbreviated marker still matches.
 */
export function isBehind({ deployed, ownSha, latestSha }) {
  if (!latestSha) return false;
  if (deployed) return !latestSha.startsWith(deployed) && !deployed.startsWith(latestSha);
  return !!ownSha && ownSha !== latestSha;
}

/**
 * Which upstream commit to believe this Space is running.
 *
 * The local record is preferred, but only while it is about the commit the
 * Space is actually on: anything else pushing to the Space makes it a statement
 * about a tree that is no longer there. The marker in the Space's own history
 * is the fallback, and it is what a duplicated or restored Space has.
 */
export function deployedFrom({ record, marker, ownSha }) {
  return (record && ownSha && record.ownSha === ownSha) ? record.upstream : (marker || null);
}

/**
 * Run one update at a time, and release the latch whatever happens.
 *
 * The route used to set a module flag, then allocate a temp directory, and only
 * then enter its try/finally — so a tmp that is full or unwritable threw past
 * the release and every later update answered `busy` until the Space restarted.
 * Holding the latch here makes that unrepresentable: there is no statement
 * between taking it and the try that releases it.
 */
export async function exclusively(state, body) {
  if (state.busy) return { ok: false, reason: 'busy' };
  state.busy = true;
  try { return await body(); }
  finally { state.busy = false; }
}

const fail = (reason, detail) => ({ ok: false, reason, detail: detail ? String(detail).slice(0, 600) : undefined });

/**
 * @param git     (args, cwd) => Promise<string>, rejecting with a token-scrubbed
 *                Error. Injected so the caller owns scrubbing, and so a test can
 *                watch the order of operations.
 * @param record  (upstreamSha, ownSha) => void, called whenever upstream's tree
 *                is known to be in place — after a push AND when it already
 *                was. The second case is why this exists: upstream can move to
 *                a commit with an identical tree (a metadata-only change), and
 *                there is then nothing to push, so the marker in the Space's
 *                history still names the older commit and `check` would report
 *                "behind" forever. Pushing a commit just to move that marker
 *                would rebuild the Space — restarting the operator's running
 *                agents — for a byte-identical image, so it is written down
 *                instead.
 */
export async function deployUpstreamTree({ sourceUrl, branch = 'main', ownUrl, dir, git, record = () => {} }) {
  const one = (text) => String(text || '').trim();
  const head = `refs/heads/${branch}`;
  // A fresh, empty repo, and both sides fetched into it at depth 1 — never the
  // Space fetched into a full clone of upstream. HF's git server dies in that
  // negotiation (`fatal: expected 'acknowledgments'`) once the client holds the
  // whole GitHub history, and the old code read that failure as "the Space is
  // empty" and pushed a parentless commit, which HF then refused as
  // non-fast-forward. Only the two tips are needed: upstream's tree to deploy
  // and the Space's commit to stand on.
  try {
    await git(['init', '--quiet', dir]);
    await git(['remote', 'add', 'upstream', sourceUrl], dir);
    await git(['remote', 'add', 'own', ownUrl], dir);
  } catch (error) { return fail('init-failed', error.message); }

  // Whether the Space is empty is asked of the Space, not inferred from a fetch
  // that failed. No ref is the first deploy; a ref we then cannot fetch is an
  // error, because a deploy without its parent can only ever be refused.
  let advertised;
  try {
    advertised = one(await git(['ls-remote', 'own', head], dir)).split('\n')
      .map((line) => line.split(/\s+/)).find(([, name]) => name === head)?.[0] || null;
  } catch (error) { return fail('own-unreachable', error.message); }

  // The Space first, into the empty repo, so there is nothing to negotiate.
  let parent = null;
  if (advertised) {
    try {
      await git(['fetch', '--quiet', '--depth', '1', 'own', `+${head}:refs/remotes/own/${branch}`], dir);
      parent = one(await git(['rev-parse', `refs/remotes/own/${branch}`], dir)) || null;
    } catch (error) { return fail('own-fetch-failed', error.message); }
    if (!parent) return fail('own-fetch-failed', `${head} is advertised as ${advertised} but nothing was fetched`);
  }

  let upstream;
  let tree;
  try {
    await git(['fetch', '--quiet', '--depth', '1', 'upstream', `+${head}:refs/remotes/upstream/${branch}`], dir);
  } catch (error) { return fail('upstream-unreachable', error.message); }
  try {
    upstream = one(await git(['rev-parse', `refs/remotes/upstream/${branch}`], dir));
    tree = one(await git(['rev-parse', `${upstream}^{tree}`], dir));
  } catch (error) { return fail('upstream-unreadable', error.message); }

  if (parent) {
    try {
      if (one(await git(['rev-parse', `${parent}^{tree}`], dir)) === tree) {
        record(upstream, parent);
        return { ok: true, upToDate: true, from: parent, to: upstream };
      }
    } catch (error) { return fail('own-unreadable', error.message); }
  }

  let commit;
  try {
    commit = one(await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', deployMessage(upstream, branch)], dir));
  } catch (error) { return fail('commit-failed', error.message); }

  // Refuse to push something that is not what we meant to push. An empty
  // deploy would also be a lie in the Space's history.
  try {
    if (one(await git(['rev-parse', `${commit}^{tree}`], dir)) !== tree) return fail('tree-mismatch', commit);
  } catch (error) { return fail('commit-unreadable', error.message); }
  if (!commit || commit === parent) return fail('empty-deploy');

  const ref = 'refs/heads/am-deploy';
  try {
    await git(['update-ref', ref, commit], dir);
  } catch (error) { return fail('ref-failed', error.message); }

  // Only when the tree actually carries pointers: on a repo with no LFS files
  // this is a no-op worth skipping rather than a transfer worth failing on.
  //
  // But a scan that FAILED is not a scan that found nothing. Swallowing it into
  // "no pointers" pushed the ref anyway, which is the one outcome this whole
  // step exists to prevent — a tree of pointers on a Space whose objects were
  // never sent. If we cannot tell, we do not push.
  let pointers;
  try { pointers = one(await git(['lfs', 'ls-files', '-n', commit], dir)); }
  catch (error) { return fail('lfs-scan-failed', error.message); }
  if (pointers) {
    // Nothing was checked out, so no smudge filter ever downloaded the objects:
    // they are fetched from upstream for exactly this tree, then sent on.
    try {
      await git(['lfs', 'fetch', 'upstream', upstream], dir);
    } catch (error) { return fail('lfs-fetch-failed', error.message); }
    try {
      await git(['lfs', 'push', 'own', ref], dir);
    } catch (error) { return fail('lfs-push-failed', error.message); }
  }

  try {
    await git(['push', 'own', `${ref}:refs/heads/${branch}`], dir);
  } catch (error) { return fail('push-rejected', error.message); }

  record(upstream, commit);
  return { ok: true, from: parent, to: upstream, commit, lfs: !!pointers };
}
