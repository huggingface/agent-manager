# Bucket backup — design

The bucket is the only thing in this system that cannot be rebuilt. The image is
in the Dockerfile, the app is on GitHub, the CLIs reinstall on a factory reboot —
but `/data` holds the workspaces agents have been working in, their transcripts,
the session list, and the operator's config. A deleted Space, a detached volume,
or an `rm -rf` in the wrong workspace takes all of it.

This is a periodic mirror of the bucket into **private Hub storage**, on an
interval the operator sets alongside `archive` (Settings → hourly by default once
enabled). Nothing here deletes from the bucket, ever.

The bucket is itself a Hub resource, so the copy happens **entirely Hub-side**:
no walk of the FUSE mount, no download, no re-upload. §3 is the evidence, and it
is what makes an hourly cadence cheap enough to be boring.

## 1. Decisions (locked)

1. **Destination is a private bucket, not a dataset repo.** Not a preference —
   bucket→repo copy is refused by the Hub today (§3.1). The bucket destination is
   also the better fit: server-side copy, and no git history to grow forever.
   The Hub's own docs recommend buckets for rolling backups for exactly that
   reason.
2. **The copy is server-side, by Xet hash.** `hf cp hf://buckets/<src>/ hf://buckets/<dst>/`
   moves hashes, not bytes: 13,482 real files in 20 s (§3.2). The app makes API
   calls; it does not read `/data`.
3. **Everything is copied, credentials included.** Operator's call, and the
   mechanism agrees: server-side copy has no include/exclude, so per-prefix
   surgery would mean giving up the fast path. A restored Space comes back
   signed-in.
4. **The destination must be private, and that is a hard gate.** The mirror
   contains live OAuth tokens for every agent, the Web Push private key, and
   `session-secret` (§4). The backup refuses to run against a non-private
   destination — checked on every run, not just at creation. Same instinct as
   `visibility.js`, which locks the app when the Space or bucket is public.
5. **Off until the operator turns it on.** It copies the contents of their
   machine into another Hub resource; that is a deliberate act. Once on, hourly.
6. **Never prune the destination.** A file deleted in `/data` stays in the
   mirror. That is what makes this a backup rather than a synchroniser — an
   `rm -rf` in a workspace is precisely the accident we are insuring against, and
   a mirror that faithfully reproduces the deletion insures against nothing.
7. **Restore is a documented script, not a button** (§9). Restoring over a live
   bucket is destructive and only the operator knows which side should win.

## 2. What we already have

- **The bucket id, already discovered.** `visibility.js` reads
  `GET /api/spaces/{id}` → `runtime.volumes[]` and keeps the entries with
  `type === 'bucket'`. Verified on two Spaces: `{source: 'lvwerra/agent-manager-data', mountPath: '/data'}`.
  The feature needs no new discovery.
- **`hf` CLI 1.25.1 in the image**, with `hf buckets create/cp/list/info/rm`.
  `share.js` already shells out to `hf` with this token, so there is no new auth
  path.
- `am-config.json` + `GET/PUT /api/config` + a whitelisted enum, rendered as a
  segmented control in `SettingsView.tsx`. `archive.after` is the precedent the
  operator asked for; `backup` is another key in the same object.
- `share.js`'s rule that heavy work happens in a child process. Less critical
  here — `hf cp` *is* a subprocess and the work is on the Hub — but the timer
  still spawns rather than blocks.

## 3. Verified Hub behaviour

All measured against the real Hub with `hf` 1.25.1, on this Space's own buckets.

### 3.1 Bucket → dataset repo is not possible today

```
$ hf cp hf://buckets/lvwerra/am-dev-2-data/sessions.json \
        hf://datasets/lvwerra/am-backup-probe2/sessions.json
Error: Invalid value. Bucket-to-repo copy is not supported.
```

The client raises it (`hf_api.py`: `if destination_uri.is_repo: if source_uri.is_bucket: raise`),
and the CLI source attributes it to a **server limitation**. The Hub docs say so
twice, in the same words:

> Note that transferring data the other way from a bucket to a repository
> (model, dataset, Space) without reuploading is **not yet available, but is on
> the roadmap**.

Supported directions today: local→repo, local→bucket, repo→repo, repo→bucket,
bucket→bucket. Server-side copies also require source and destination in the
**same storage region**.

**So "back up to a dataset, Hub-side" is not available.** It is on the roadmap,
which makes this worth re-checking later: if it lands, §11.2 becomes a two-line
change of destination type and the design is otherwise untouched.

### 3.2 Bucket → bucket is server-side, recursive, and fast

| case | files | wall |
|---|---|---|
| whole small bucket (`am-dev-2-data`) | 49 | **1 s** |
| `state/` of the production bucket, cold | 13,482 | **20 s** |
| the same copy again | 13,482 | **18 s** |

- A **trailing slash on both sides copies contents recursively**, preserving
  paths. All 49/49 files of the small bucket landed at the same relative paths.
- ~670 files/s. The production bucket is 102,691 files, so a **full mirror
  extrapolates to ≈2.5 minutes** — comfortably inside an hourly cadence, and it
  costs the Space no I/O at all.
- The repeat run is not cheaper (18 s vs 20 s): `cp` re-copies entries rather
  than diffing. Since no bytes move, this is a per-file metadata cost, not
  bandwidth. It also means there is no "nothing changed, do nothing" shortcut on
  this path — unlike the dataset path (§3.4).
- Only Xet-tracked files copy server-to-server; the docs note small non-Xet files
  are transparently downloaded and re-uploaded by the client. At 670 files/s over
  13k mixed small files, nothing suggests we hit that path meaningfully from a
  bucket source.

### 3.3 What buckets do not give us

- **No versioning.** Buckets are "non-versioned and mutable", overwrite-in-place,
  and deletions are "immediate and permanent". There is no history and no
  point-in-time recovery. See §10 — this is the real cost of the fast path.
- **No remote→remote sync**, so no `--delete` and no `--include/--exclude`
  between two buckets: `hf sync` raises "Remote to remote sync is not supported.
  One path must be local." Pruning, if ever wanted, is a separate
  `hf buckets rm --recursive`. Per §1.6 we do not want it.
- **`hf buckets info` lags.** Immediately after a verified 49-file copy it still
  reported `size: 0, total_files: 0`. It is eventually consistent — verify a copy
  with `hf buckets list -R`, never with `info`.
- Destination mtimes are **copy time**, not source time, so mtime cannot be used
  to reason about staleness of individual files.

### 3.4 The dataset-repo path, for comparison (§11.2)

Measured separately, uploading a local directory with `hf upload` (152 files, one
3 MB binary):

| case | wall | result |
|---|---|---|
| cold | 44 s | 1 commit |
| nothing changed | 10 s | **no commit** — "No files have been modified since last commit. Skipping to prevent empty commit." |
| one file changed | 10 s | 1 commit, only that file transferred |
| `--delete "*"`, one file deleted locally | 10 s | 1 commit, mirrored the deletion |
| `--delete "*"`, nothing changed | 10 s | no commit |

So `hf upload` is already an incremental, hash-checking mirror that produces no
empty commits, and files over a few MB land in LFS automatically. It is a good
mechanism — it just requires reading the mount, and it keeps every version
forever (§10).

## 4. What is in the bucket (measured)

The production bucket `lvwerra/agent-manager-data`: **11.4 GB, 102,691 files.**
Walking the mount directly:

| subtree | files |
|---|---|
| everything under `/data` | 89,681 |
| `workspaces/` | 58,356 |
| `state/` | 13,447 |
| `node_modules/` anywhere | 18,647 |
| `.git/` anywhere | 3,410 |

Cost of the mount-based alternative, for the record: a cold recursive walk ran
into minutes (`du -sh /data` did not finish in 300 s) while a warm walk of one
620 MB workspace took 1 s. The Hub-side path skips this entirely.

**Credential surface**, all of it included per §1.3 and the reason §1.4 is a hard
gate:

- `state/claude/.credentials.json`, `state/codex/auth.json`, `state/hermes/auth.json`
- `state/vapid.json` — this install's private Web Push key
- `session-secret` at the bucket root
- `home/` — agent dotfiles and whatever else lives in the home directory
- `secret-notes.json` — the operator's descriptions of injected secrets

## 5. The pipeline

```
timer (interval from am-config.json, unref'd)
  └─ skip if: disabled · already running · no HF_TOKEN
  └─ resolve source bucket id from runtime.volumes[]        (visibility.js)
  └─ resolve/create destination:  <ns>/<space>-backup  --private
  └─ HARD GATE: hf buckets info <dst> → private !== true  ⇒ refuse, surface why
  └─ spawn: hf cp hf://buckets/<src>/ hf://buckets/<dst>/latest/
  └─ verify with `hf buckets list <dst>/latest -R | wc -l`  (never `info`, §3.3)
  └─ persist { at, duration, files, error } to DATA_DIR/backup-state.json
```

Details that matter:

- **One at a time.** A run that overruns must not overlap the next; the timer
  checks a running flag and logs the skip.
- **Catch-up on boot, jittered** — a few minutes after start, not at boot when
  the CLIs are still installing.
- **A backup is a fuzzy snapshot.** Agents write while the copy runs, so the
  mirror is not point-in-time consistent. Acceptable here, and worth saying
  rather than glossing: it is a backup of a running machine.
- **Failures are logged, not retried.** The next hour is the retry; the last
  error surfaces in the status row so a silently broken backup becomes visible.
- **`latest/` prefix**, not a dated one — see §10 on why dated prefixes are a
  billing question rather than a free win.

## 6. Config and API

```js
// am-config.json — validated with a whitelist, like archive.after
backup: {
  every: 'never' | 'hour' | '6h' | 'day',   // default 'never' (§1.5)
  bucket: '',                                // default <ns>/<space>-backup
}
```

```
GET  /api/backup/status  → { every, bucket, private, running, last: {...}, error }
POST /api/backup/run     → kick one now (same path as the timer)
```

`GET/PUT /api/config` gains the `backup` key. No new auth surface: both routes
sit behind the existing visibility gate.

## 7. Settings surface

One block in `SettingsView.tsx`, matching `archive`:

```
Back up the bucket                            [ off | hourly | 6h | daily ]
  Copies everything on your bucket — workspaces, history, saved logins —
  to a second private bucket on the Hub. The copy happens on the Hub, so
  it costs this Space nothing. Nothing is ever deleted from your bucket,
  and files you delete stay in the backup.

  Backup bucket  [ lvwerra/agent-manager-backup ]   ● private

  Last backup: 12 minutes ago · 102,691 files · 2m 28s
  [ Back up now ]                            [ Open bucket ↗ ]
```

The privacy dot is not decoration: it is the state of the §1.4 gate, and the one
thing an operator must be able to see at a glance about a copy of their
credentials.

## 8. Restore

Restore is the direction the Hub *does* support Hub-side, which is a pleasant
asymmetry: `hf cp hf://buckets/<backup>/latest/ hf://buckets/<live>/` puts the
data back without anything being downloaded — and the same copy works into a
*fresh* Space's bucket, which is the real disaster case.

`scripts/restore-bucket.mjs <backup-bucket> <target-bucket>` wraps that with the
guards that matter: refuse when the target is non-empty unless `--force`, and
print what would be overwritten first. Documented, not a button, per §1.7.

## 9. Storage growth

A bucket mirror costs **the current footprint, once** — 11.4 GB today, whatever
it is tomorrow. There is no history to accumulate, which is exactly why the Hub
docs recommend buckets over dataset repos for rolling backups: with git, deleting
a file frees nothing.

The one growth term is §1.6: files deleted in `/data` linger in the mirror
forever. Deliberate, and cheap — but it means the mirror is a high-water mark of
everything the bucket has ever held, not a copy of what it holds now. If that
ever gets expensive, prune with `hf buckets rm --recursive` against a reviewed
list; never automatically.

**Pseudo-versioning is possible but unpriced.** Copying to a dated prefix each
run (`latest/` → `2026-08-04T13/`) would give point-in-time recovery, and Xet
chunk dedup means unchanged content is not stored twice. But the docs say
dedup-based *billing* is an Enterprise benefit, so on other plans dated prefixes
may bill as full copies. Not doing it until the billing is confirmed (§11.4).

## 10. Risks and open questions

1. **No point-in-time recovery is the real trade.** This design protects against
   deletion (§1.6) and against losing the Space, but not against *corruption*: a
   file damaged in place propagates on the next copy and the good version is gone
   forever. The dataset path (§3.4) is the one that gives history. If corruption
   matters more than cost, the answer is both — hourly bucket mirror plus an
   occasional versioned dataset snapshot from the mount, which is §11.2 and is
   deliberately not in v1.
2. **A backup bucket is a second copy of every credential.** §1.4's gate is the
   mitigation, and it must be re-checked every run — a bucket can be flipped to
   public after creation. Open: should the backup also refuse when the *Space* is
   public, as `visibility.js` does for the app?
3. **Region.** Server-side copy requires source and destination in the same
   storage region. Untested across regions — the destination should be created
   without an explicit region so it lands in the default, and a region mismatch
   should be reported as its own error rather than a generic copy failure.
4. **Dated-prefix billing** (§9) is unconfirmed.
5. **~2.5 min is extrapolated**, from 13,482 files in 20 s. The full 102,691-file
   copy has not been run end to end. If it is much worse than linear, hourly on a
   large bucket needs revisiting — hence duration in the status row.
6. **Sustained hourly API volume** over weeks is unproven.
7. **Restore has never been exercised.** A backup that has not been restored once
   is a hypothesis. Phase 3 restores into a scratch Space for real.
8. **Bucket→repo is on the roadmap** (§3.1). Re-check before building anything
   elaborate on the mount-based path.

## 11. Phasing

1. **Config + timer + the copy + status API.** Headless, driven by
   `POST /api/backup/run`; run one full 102,691-file copy and record the real
   duration (§10.5).
2. **Settings UI** (§7) — interval, destination, the privacy dot, status line,
   "Back up now".
3. **`scripts/restore-bucket.mjs` + docs, and one real restore** into a scratch
   Space. Until this runs, the feature is unproven (§10.7).
4. **Optional versioned snapshots** — the §3.4 dataset path at a slow cadence,
   for point-in-time recovery (§10.1), or dated prefixes if §9's billing turns
   out to be favourable.
