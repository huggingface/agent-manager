# Phantom directories on the `/data` bucket mount

**Status:** root cause identified, reproduced on demand, **local repairs applied 2026-07-28**.
Upstream already has a fix in **open, unmerged** [`hf-mount` PR #207](https://github.com/huggingface/hf-mount/pull/207).
**Sources:** the `session-sharing` Claude session (transcript `edbfc11f-…`, lines 682–720,
751–776), plus `docs/fuse-phantom-directories-review.md` — a second-opinion review that
found PR #207 and diagnosed the Codex thread-store failure. Its corrections are folded in here.

## TL;DR

Any path on `/data` that is a **strict string prefix of a real bucket key** materializes as
a directory containing one child named after the first segment of that key (`home` or
`workspaces`). The path itself does not exist.

```
.git/hooks/pre-commit/workspaces      ← because  .git/hooks/pre-commit.sample  exists
home/.gemini/projects.json/home       ← because  projects.json.<uuid>.tmp      exists
home/.cache/claude/home               ← because  .cache/claude-cli-nodejs      exists
```

A negative lookup that should return `ENOENT` becomes a directory inode. This broke
`git commit` (git *skips* a missing hook but **execs** a directory — fatal) and the Gemini
CLI (`EISDIR` reading its registry). Both are repaired on this Space; see
[What was applied](#what-was-applied-2026-07-28).

It is **not** "FUSE turns an atomic write into a directory", which is what
`docs/session-sharing.md` §12 still claims. See [Corrections](#corrections).

## Environment

- `/data` is `hf-mount` FUSE, backing bucket **`thomwolf/agent-manager-data`**.
- Upstream source inspected at **v0.9.0 / `ff83aca`** (HEAD, 2026-07-28). Both faulty code
  paths are present there; the fix exists only on the unmerged PR #207 branch.

## Root cause: an API-contract mismatch

Framing matters here, because it decides where the durable fix belongs.

> **`hf-mount` consumes a raw object-key prefix API as though it guaranteed filesystem
> path-component boundaries.**

The bucket API's prefix behaviour is *not itself a defect* — filtering by raw object-key
prefix is ordinary object-storage semantics, and the Hub
[documents bucket listing as prefix filtering](https://huggingface.co/docs/huggingface_hub/guides/buckets#list-files).
The defect is that hf-mount never converts that response into strict filesystem
descendants before its virtual filesystem consumes it.

### Layer 1 — the API matches by string prefix

```
GET /api/buckets/<id>/tree/home/.gemini/projects.json
200 → home/.gemini/projects.json.9e7b39d7-…-.tmp
      home/.gemini/projects.json.bf9667fc-…-.tmp
```

`home/.gemini/projects.json` is not a key. A genuinely unmatched path correctly returns `[]`:

```
tree/workspaces/Agent-manager/.git/hooks/never-existed-aaa  → entries=0
tree/totally/bogus/path/xyz                                 → entries=0
```

### Layer 2 — hf-mount reads "non-empty listing" as "directory"

`src/virtual_fs/mod.rs:1373-1379`:

```rust
// The resolve endpoint returns 404 for directories, so a HEAD
// miss could still be a remotely-added dir. Targeted listing
// catches that; non-empty result means the dir exists.
if let Ok(entries) = self.hub_client.list_tree(&full_path).await
    && !entries.is_empty()
{
    return self.insert_dir(parent, name, &full_path);
}
```

Note the necessary boundary test is **strict descendants only**: at least one entry
beginning with `full_path + "/"`. An entry *equal to* `prefix` must not count as proof —
a key and a directory of the same name are different things in an object store.

### Layer 3 — the child name comes from a failed `strip_prefix`

`src/virtual_fs/mod.rs:826-842`, in `ensure_children_loaded`:

```rust
entry.path
    .strip_prefix(&prefix)
    .and_then(|p| p.strip_prefix('/'))
    .unwrap_or(&entry.path)      // ← keeps the FULL bucket key
```

Prefix-matched siblings never start with `prefix + "/"`, so both strips fail, the whole
bucket key survives, and the next line takes its first path segment as a subdirectory
name — `home` under `/data/home/…`, `workspaces` under `/data/workspaces/…`.

Upstream's own test mock modelled *path-component* matching rather than the real API's raw
prefix behaviour, which is why the tests never caught this.

## Upstream status

Reported and fixed three weeks before this investigation, by an HF engineer:

- [PR #207 — *fix: support object_store-based writers (Lance, Delta) on mounted buckets*](https://github.com/huggingface/hf-mount/pull/207)
  — **OPEN**, base `main`, created 2026-07-06, last updated 2026-07-07, not merged, not released.
- [`4f9b2a3`](https://github.com/huggingface/hf-mount/commit/4f9b2a307d71217ba812fec57836434a0d812589)
  *treat raw-prefix tree matches as non-children* — the targeted lookup only infers a
  directory from a strict descendant; `ensure_children_loaded` skips raw-prefix siblings.
- [`9f11e0d`](https://github.com/huggingface/hf-mount/commit/9f11e0d4adec7d045d42ac5bab2cbbc8b8dec662)
  *apply review cleanups* — moves the filter into `HubApiClient::list_tree()`, the boundary
  where S3 prefix semantics originate, so every consumer (including the previously
  unguarded `poll.rs`) inherits the strict-descendant contract.

The centralized approach in `9f11e0d` is the right shape. Until PR #207 merges and ships,
v0.9.0 and this mount remain affected.

**Note for searchers:** `gh search --repo … is:issue` will *not* find this — it excludes
pull requests. Search `is:pr` too.

## Reproduction

Deterministic enough to demo, read-only, ~5 seconds:

```sh
ls -la /data/home/.cach       # → DIRECTORY containing `home`   (prefix of home/.cache/…)
ls -la /data/sessions.jso     # → DIRECTORY                     (prefix of sessions.json)
ls -la /data/sessions.jsoZZ   # → ENOENT, correct               (prefix of nothing)
```

Timing is **not** fully deterministic: whether the targeted `list_tree` fallback runs at
all depends on parent-listing state, kernel caching, and hf-mount's negative cache. A path
that is a prefix of a real key is *eligible*; it does not always materialize immediately.

The phantoms are **synthesized inode entries, not stored objects** — consistent with
"empty directories are not persisted" on this bucket. Consequences:

- They contain no files, only the one synthesized child directory.
- `rmdir` clears them, but **only until the next lookup**, which re-synthesizes them —
  unless the triggering key is gone.
- They also disappear on their own when the inode cache evicts them.
- Inodes are small sequential counters (`/data`=1, `home`=3, `workspaces`=10), so these are
  genuine new nodes, not alias/hash collisions.

## Why this is high-severity, not cosmetic

Ordinary tooling generates vulnerable name pairs constantly:

- git ships `pre-commit.sample` while probing `pre-commit`
- atomic writers create `file.<uuid>.tmp` while readers probe `file`
- Node/TypeScript probe extensionless names before `.js` / `.d.ts`
- object-store writers (Lance, Delta — PR #207's motivating case) stage `1.manifest#1`
  while probing `1.manifest`

The evidence establishes application breakage and incorrect filesystem semantics. It does
**not** establish stored-object corruption, data loss, or a security vulnerability.

## Known sites on this Space

| Phantom path | Key it prefix-matches | Impact | Now |
|---|---|---|---|
| `.git/hooks/pre-commit` | `pre-commit.sample` | `git commit` fatal | **fixed** |
| `.git/hooks/prepare-commit-msg` | `prepare-commit-msg.sample` | same | **fixed** |
| `home/.gemini/projects.json` | `projects.json.<uuid>.tmp` ×2 | Gemini CLI dead | **fixed** |
| `home/.cache/claude` | `claude-cli-nodejs` | harmless | left alone |
| `home/.config/google-chrome` | `google-chrome-for-testing` | harmless | left alone |
| `node_modules/react/jsx-runtime` | `jsx-runtime.js` | transient | left alone |
| `node_modules/react-dom/client` | `client.js` | transient | left alone |
| `node_modules/@types/react-dom/client` | `client.d.ts` | transient | left alone |
| `node_modules/node` | `node-*` packages | transient | left alone |

## What was applied (2026-07-28)

These are **local workarounds**, not root-cause fixes — the root cause is upstream. Each
works by removing the triggering key or occupying the path so the listing fallback never runs.

1. **git** — deleted all 13 `.git/hooks/*.sample`, then `rmdir`'d the two cached phantoms.
   *Verified:* `git hook run pre-commit` → "cannot find a hook named pre-commit"; a real
   `git commit --allow-empty` succeeded and was rolled back.
2. **Gemini** — moved the two Jul-6 orphans to `~/.gemini/am-quarantine/` (both were just
   `{"projects": {}}`, nothing lost) and wrote a real `projects.json`.
   *Verified:* `gemini -p …` now reaches the auth check instead of dying on `EISDIR`.
3. **Codex thread store** — created `/data/state/codex/{sessions,db-backups,db-backups/am-quarantine}`
   each with a `.keep` file. *Verified:* `$CODEX_HOME/sessions` resolves, and `mkdir -p`
   of a dated rollout path (the exact failing operation) succeeds.
4. **`entrypoint.sh`** — so the above survives a restart:
   - new `keepdir()` — mkdir plus a `.keep` marker; used for the codex `sessions` /
     `db-backups` / `am-quarantine` dirs and the opencode/hermes durable dirs.
   - new `occupy_file()` — clears a directory-shaped entry and writes a default file;
     used for `~/.gemini/projects.json`.
   - `sh -n` clean; both helpers unit-tested in isolation (replaces a phantom dir, leaves
     an existing file untouched).

## The Codex thread-store failure (same family, different bug)

Full diagnosis in `fuse-phantom-directories-review.md`. Confirmed independently here:

```
dangling sessions symlink → rollout creation fails EEXIST → thread absent from
persistent storage → thread/read fails → branch-before-selected-prompt fails
```

`entrypoint.sh` created `$CODEX_DURABLE/sessions` **empty** and symlinked
`$CODEX_HOME/sessions` at it. Empty directories have no backing object key, so the
directory vanished and the symlink dangled; `mkdir` onto a dangling symlink reports
`File exists (os error 17)` — the opaque error in
[openai/codex#3733](https://github.com/openai/codex/issues/3733).

This is **not** the prefix bug. It shares only the root theme: *a bucket mount does not
preserve empty-directory state like a conventional filesystem.* The review missed that
`db-backups` and `db-backups/am-quarantine` had vanished for the same reason; all three
are repaired.

Transcripts written while the link was dangling were never persisted and are not
recoverable. A more robust design — keep all of `$CODEX_HOME` on local disk and copy
*completed* rollouts to the bucket, rather than exposing the live writer through a FUSE
symlink — is worth considering but is a bigger change than the `.keep` fix.

## Corrections

Recorded because they were stated confidently and are wrong.

1. **`docs/session-sharing.md` §12** — "the FUSE bucket turning an atomic write into a
   directory" reverses the causality. The orphaned temp files are the trigger; the
   directory is synthesized later by a prefix-matching lookup. *(Still unfixed in §12.)*
2. **"The mount strips exec bits."** It does not. A fresh file keeps `0755`, and `chmod +x`
   on an existing hook persists across a cold re-listing. The LFS hooks are `0644` because
   of how the repo was materialized — every tracked file shares the `Jul 26 19:10` timestamp.
3. **"`rmdir` fixes it."** Only until the next lookup, unless the triggering key is removed.
4. **"Not yet reported upstream."** Wrong — PR #207 predates this work by three weeks. The
   `is:issue` search filter hid it.
5. **"The Hub API is buggy."** Reframed: raw-prefix matching is the documented object-store
   contract; the defect is hf-mount not translating it into filesystem semantics.
6. **"Any strict string prefix materializes deterministically."** Too strong — see
   [Reproduction](#reproduction).
7. **"They are always empty."** They contain the synthesized `home`/`workspaces` child.

## Open items

- [ ] **LFS is silently inert.** `.gitattributes` has 36 LFS patterns; `filter.lfs.*`
      clean/smudge are active, but all four hooks are `0644` and git skips them silently —
      it now says so out loud: *"the '.git/hooks/post-commit' hook was ignored because it's
      not set as executable."* LFS **upload** happens in `pre-push`, so a push may land
      pointers whose blobs were never uploaded. **Not tested.** Fix:
      `chmod +x .git/hooks/{pre-push,post-commit,post-checkout,post-merge}`.
- [ ] Comment on PR #207 with this independent repro — it broadens the impact beyond
      Lance/Delta to git hooks and CLI config files, which may help it get merged.
- [ ] Fix `session-sharing.md` §12 (correction 1).
- [ ] Sweep other agent home dirs for `foo` / `foo.<ext>` pairs before they bite a
      different CLI.
- [ ] Consider moving Codex `sessions` fully to local disk with completed-rollout sync.

## Related, separately confirmed

- **Stale directory listings.** `server/src/share.js` was written, then `ls`, `find` and
  `node --check` all reported it missing; `git ls-files` showed 13 files in `server/src`
  while `ls` showed 10, `git status` clean throughout. Nothing lost — the readdir cache was
  stale and resolved seconds later. Hit again during today's repairs: a just-written
  `projects.json` was absent from `ls` but `stat`'d fine. **Rule: on this mount a "missing
  file" needs a retry before you believe it, and a clean `git status` is not proof the tree
  matches the index.** Matches [#160](https://github.com/huggingface/hf-mount/issues/160).
- **SQLite on the bucket.** [#103](https://github.com/huggingface/hf-mount/issues/103);
  already handled by `1dfb753` and the local-disk `$HOME` relocations in `entrypoint.sh`.
