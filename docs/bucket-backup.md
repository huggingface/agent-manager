# Bucket backup — design

The bucket is the only thing in this system that cannot be rebuilt. The image is
in the Dockerfile, the app is on GitHub, the CLIs reinstall on a factory reboot —
but `/data` holds the workspaces agents have been working in, their transcripts,
the session list, and the operator's config. A deleted Space, a detached volume,
or an `rm -rf` in the wrong workspace takes all of it.

This is a periodic mirror of the bucket into a **private dataset repo**, so that
losing the Space costs an afternoon instead of everything.

Interval is an operator setting alongside `archive` (Settings → hourly by default
once enabled). Nothing here deletes from the bucket, ever.

## 1. Decisions (locked)

1. **A mirrored file tree, not a tarball.** The dataset holds the bucket's files
   at their own paths. A tarball would be a fresh multi-gigabyte LFS blob every
   hour, stored forever (§3, §10). A tree dedupes: only changed files transfer,
   and an hour with no changes produces *no commit at all* (§3).
2. **One private dataset per Space**, `<namespace>/am-bucket-<space-name>`.
   Created `--private`, and the backup **refuses to run** if the repo is not
   private — the same instinct as `visibility.js`, which locks the whole app when
   the Space or bucket is public.
3. **Agent credentials are excluded by default.** The bucket contains live OAuth
   credentials (§4). A backup exists to save *work*, and a restore can re-login.
   Copying live tokens into a Hub repo multiplies the blast radius of that repo
   for no gain the operator asked for. Opt-in toggle, worded plainly.
4. **The walk and the upload run in a child process.** Same hard rule as
   `share.js` §1: this app has wedged once on synchronous work, and a background
   task that fires every hour must never be the next cause.
5. **Off until the operator turns it on.** It writes the contents of their
   machine to their Hub account; that is a deliberate act, not a default. Once
   on, the interval defaults to hourly.
6. **Restore is a documented script, not a button.** Restoring over a live
   bucket is destructive and situational (§9). v1 gives `scripts/restore-bucket.mjs`
   and instructions; the app does not offer one-click restore.

## 2. What we already have

- `share.js` publishes a dataset repo already: `hf repo create --type dataset`,
  `hf upload`, then `hfApi()` for settings/access. Same CLI, same token, same
  namespace resolution (`shareNamespace()`). The backup reuses that shape and
  needs no new Hub plumbing.
- `am-config.json` + `GET/PUT /api/config` + a whitelisted enum, rendered as a
  segmented control in `SettingsView.tsx`. `archive.after` is exactly the
  precedent the operator asked for; `backup` is another key in the same object.
- `watchdog.js` for the "periodic work that must not wedge the loop" pattern, and
  `tracked()`/`PHASE` if the backup ever touches the main thread.
- `scripts/share-session.mjs` as the model for a heavy child-process worker that
  is *also* runnable by hand — the property that makes it debuggable.

## 3. Verified Hub behaviour

Measured against a throwaway private dataset (`hf` **1.25.1**, since deleted);
152 files including one 3 MB binary.

| case | wall | result |
|---|---|---|
| cold upload (152 files, 3 MB) | 44 s | 1 commit |
| re-run, nothing changed | 10 s | **no commit** — "No files have been modified since last commit. Skipping to prevent empty commit." |
| re-run, one small file changed | 10 s | 1 commit, only that file transferred |
| re-run with `--delete "*"`, one file deleted locally | 10 s | 1 commit, the file is gone from the repo |
| re-run with `--delete "*"`, nothing changed | 10 s | **no commit** |

What this buys us, and why the whole design leans on it:

- **`hf upload <repo> <dir> . --repo-type dataset` is already an incremental
  mirror.** It hash-checks every file and transfers only what differs. We do not
  need to track state, diff trees, or remember what we sent last hour.
- **An idle hour is free and invisible.** No empty commits means hourly backups
  do not produce 8,760 junk commits a year; the history is a list of real
  changes. This survives `--delete "*"`, so mirroring deletions costs nothing
  when nothing was deleted.
- **`--delete "*"` matches nested paths**, so one flag makes the dataset a true
  mirror rather than an append-only pile of files the operator once had.
- Files over a few MB land in **LFS** automatically (the 3 MB binary did) — no
  `.gitattributes` work on our side.
- `upload-large-folder` is **deprecated** in 1.25.1 in favour of `hf upload`.

## 4. What is actually in the bucket (measured)

On this Space's bucket, walked directly:

| subtree | files |
|---|---|
| everything under `/data` | **89,681** |
| `workspaces/` | 58,356 |
| `state/` | 13,447 |
| — of which `state/claude/projects/` (transcripts) | 767 |
| `node_modules/` anywhere | 18,647 |
| `.git/` anywhere | 3,410 |

Two costs that shape the design:

- **The FUSE walk is the expensive part, and it is cache-dependent.** A cold
  recursive walk of the whole bucket ran into minutes — `du -sh /data` did not
  finish inside 300 s — while a warm walk of one 620 MB workspace took 1 s. So
  the first backup after a boot is slow and later ones are cheap, which is
  survivable hourly but *only* off the event loop (§1.4).
- **Live credentials are in there**, which is the single most consequential fact
  in this document:
  - `state/claude/.credentials.json`
  - `state/codex/auth.json`
  - `state/hermes/auth.json`
  - `state/vapid.json` — this install's private Web Push key
  - `secret-notes.json` — the operator's descriptions of injected secrets

  A dataset holding those is a credential store with a Hub URL. Hence §1.3.

## 5. What gets excluded

Default exclusions, in two classes.

**Regenerable bulk** — costs upload time and storage, restores by rebuilding:

```
**/node_modules/**    **/.venv/**        **/__pycache__/**   **/*.pyc
**/dist/**            **/build/**        **/target/**        **/.next/**
**/.cache/**          **/.pytest_cache/**
```

`node_modules` alone is 18,647 files — 21% of the bucket's file count for
content that `npm ci` reproduces.

**Credentials and keys** — excluded unless the operator opts in:

```
state/*/.credentials.json   state/*/auth.json   state/*/.env
state/vapid.json            **/.git-credentials
```

**Deliberately kept:** `.git` directories. Git objects are immutable and
content-addressed, which makes them the *ideal* case for a deduping mirror —
each object uploads once, forever. And branches, stashes, and unpushed commits
are exactly the work a backup is for. 3,410 files is cheap.

Whatever is skipped gets **counted and logged** in the backup status (§7). A
backup that silently omits things reads as "you are covered" when you are not.

## 6. The pipeline

```
hourly timer (main thread, unref'd)
  └─ skip if: disabled · already running · repo not private · no HF_TOKEN
  └─ spawn scripts/backup-bucket.mjs          ← child process, per §1.4
        ├─ walk DATA_DIR applying the exclusion globs
        ├─ hf upload <repo> <staged> . --repo-type dataset --delete "*"
        │     (hash-check → transfer only what changed → skip empty commits)
        └─ print a JSON report on stdout
  └─ persist the report to DATA_DIR/backup-state.json
```

Details that matter:

- **The staged tree.** `hf upload` takes a directory, and we need exclusions
  applied — so the script builds a staging tree of **hardlinks** into a temp dir
  (no copy, no extra bytes) and uploads that. Hardlinks across the FUSE mount
  need verifying on the real Space; if they fail, fall back to `--exclude` globs
  passed straight to `hf upload` (it supports them) and skip staging entirely.
  **Open — the fallback is the safer default until measured (§12).**
- **One at a time.** A run that overruns the hour must not overlap the next; the
  timer checks a running flag and logs the skip.
- **Catch-up on boot, jittered.** If the last backup is older than the interval,
  run one a few minutes after boot — not at boot, when the CLIs are installing
  and the walk is coldest.
- **A backup is a fuzzy snapshot.** Agents are writing while we read. Files may
  be captured mid-write and the tree is not a point-in-time image. That is
  acceptable for this purpose and must be *said*, not glossed: it is a backup of
  a running machine, not a database snapshot.
- **Failures are logged, not retried.** The next hour is the retry. The last
  error is surfaced in the status row so a silently broken backup becomes
  visible.

## 7. Settings surface

One new block in `SettingsView.tsx`, matching `archive`:

```
Back up the bucket                                   [ off | hourly | 6h | daily ]
  Mirrors your workspaces and session history to a private dataset so
  a lost Space is recoverable. Nothing is ever deleted from the bucket.

  Dataset   [ lvwerra/am-bucket-am-dev-2        ]  (private)
  Include agent credentials                                    [ off | on ]
    Off: the backup skips saved logins, so a restored Space asks you to
    sign in again. On: your live agent tokens are copied to the dataset.

  Last backup: 12 minutes ago · 1.2 GB · 34 files changed · skipped 18,647
  [ Back up now ]                                    [ Open dataset ↗ ]
```

The status line is load-bearing: a backup nobody can see the state of is a
backup nobody trusts.

## 8. Config and API

```js
// am-config.json — validated with a whitelist, like archive.after
backup: {
  every: 'never' | 'hour' | '6h' | 'day',   // default 'never' (§1.5)
  repo: '',                                  // default <ns>/am-bucket-<space>
  includeCredentials: false,                 // §1.3
}
```

```
GET  /api/backup/status   → { every, repo, private, running, last: {...}, error }
POST /api/backup/run      → kick one now (same path as the timer)
```

`GET/PUT /api/config` gains the `backup` key. No new auth surface: both routes
sit behind the same visibility gate as everything else.

## 9. Restore

`scripts/restore-bucket.mjs <repo> <target>`:

```
hf download <repo> --repo-type dataset --local-dir <target>
```

then re-create what was excluded — `npm ci` where a `package-lock.json` came
back, re-login for each agent. Documented, not automated, because restoring onto
a bucket that already has content is destructive and only the operator knows
which side should win.

The reason this stays a script: a "Restore" button that overwrites a live bucket
is a footgun aimed at the one thing this feature exists to protect.

## 10. Storage growth

The mirror's cost over time is **the sum of every distinct version of every
file**, because git keeps history. The hazard is not the big files, it is the
*churny* big files: anything multi-MB that changes every hour is a new LFS object
every hour, kept forever.

Known churn: agent transcripts under `state/*/projects/` (append-only JSONL, so
every hour is a new full copy of a growing file) and any SQLite database an agent
keeps. 767 transcript files today, but they only grow.

Options, in preference order — **not yet decided (§12)**:

1. Accept it, and surface the dataset's size in the status row so growth is
   visible before it is a problem.
2. Squash history periodically (`super_squash_history`), keeping the mirror
   current and dropping the past — a mirror, not an archive.
3. Exclude transcripts from the hourly pass and let session *sharing* (which
   already exports traces properly, with redaction) own that data.

Option 3 is tempting and probably right long-term: two features backing up the
same transcripts, one of them without redaction, is a smell.

## 11. Risks and open questions

1. **The credential decision (§1.3) is the one to review first.** Default-off is
   my recommendation. Note that "off" makes a restored Space need re-login for
   every agent, which is a real cost the operator may prefer to trade away.
2. **A backup dataset is a new blast radius.** Even excluding credentials, the
   workspaces contain whatever agents wrote — source, data, notes. The
   private-repo check (§1.2) is a hard gate, not a warning, for that reason.
   Should we also refuse when the *Space* is public, as `visibility.js` does?
3. **Hardlink staging across FUSE is unverified** (§6). Fallback is `--exclude`
   globs, which is simpler; possibly skip staging in v1 entirely.
4. **Cold-walk cost on a much larger bucket.** 89,681 files walks fine warm; the
   cold case ran to minutes here. A bucket 10× this size may not fit an hourly
   cadence, so the status row should show duration and the timer should log when
   a run overruns its interval.
5. **Hub rate limits / commit volume** are untested at a sustained hourly cadence
   over weeks. Expected fine — no-op hours make no commits at all — but unproven.
6. **Two backups of one thing.** §10 option 3; worth settling before both exist.
7. **Restore has never been exercised.** A backup that has not been restored once
   is a hypothesis. Phase 3 should include an actual restore into a scratch Space.

## 12. Phasing

1. **Config + scheduler + `scripts/backup-bucket.mjs` + status API.** Headless,
   driven by `POST /api/backup/run`. Prove the incremental mirror on a real
   bucket and measure the cold walk.
2. **Settings UI** (§7) — the interval control, dataset field, credential
   toggle, status line, "Back up now".
3. **`scripts/restore-bucket.mjs` + docs, and one real restore** into a scratch
   Space. Until this runs, the feature is unproven (§11.7).
4. **Retention** — decide §10, implement squash or transcript exclusion.
