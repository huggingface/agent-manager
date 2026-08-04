# Bucket backup — design

The bucket is the only thing in this system that cannot be rebuilt. The image is
in the Dockerfile, the app is on GitHub, the CLIs reinstall on a factory reboot —
but `/data` holds the workspaces agents have been working in, their transcripts,
the session list, and the operator's config. A deleted Space, a detached volume,
or an `rm -rf` in the wrong workspace takes all of it.

Two copies, on an interval the operator sets alongside `archive`:

- a **private bucket**, overwritten each run — server-side, no bytes moved, and a
  restore from it is equally instant. This is the "get the Space back" copy.
- a **private dataset repo**, committed each run — the version history a bucket
  cannot give, because buckets are mutable and non-versioned. This is the "get
  yesterday's file back" copy.

Both run in a **scheduled HF Job**, so the work happens on the Hub: backups
continue while this Space is asleep, cost it no I/O, and never walk the FUSE
mount. Nothing here deletes from the bucket, ever.

## 1. Decisions (locked)

1. **The schedule lives on the Hub, not in this app.** `hf jobs scheduled run`
   takes a cron. The Space's only job is to make the Hub's schedule match the
   operator's config, and to report what the Hub says about it. A backup that
   only runs while the app is healthy is a backup that will be missing exactly
   when it is needed.
2. **Two destinations, because they are cheap at different things.** Bucket
   storage is accounted in *logical* bytes — two identical snapshots measured as
   exactly 2× (§3.5) — so dated bucket snapshots multiply cost. A git repo stores
   each distinct blob once and skips empty commits entirely, so an hour with no
   changes adds *nothing* (§3.4). History belongs in the dataset; instant restore
   belongs in the bucket.
3. **Everything is copied, credentials included.** Operator's call. A restored
   Space comes back signed-in. The mechanism agrees: server-side copy has no
   include/exclude, so exclusions would mean giving up the fast path.
4. **Both destinations must be private, re-checked inside the Job on every run.**
   The copy contains live agent OAuth tokens, the Web Push private key, and
   `session-secret` (§4). Creation-time privacy is not enough — a repo can be
   flipped public later — so the gate runs in the Job itself and aborts before
   anything is written. Verified to bite (§3.6).
5. **The source bucket is mounted read-only** (`:ro`) in the Job. A backup must
   not be able to write to the thing it is backing up.
6. **Off until the operator turns it on.** It copies this machine's contents into
   other Hub resources; that is a deliberate act. Once on, hourly.
7. **Never prune the mirror.** A file deleted in `/data` stays in the bucket
   mirror. An `rm -rf` in a workspace is precisely the accident being insured
   against, and a mirror that faithfully reproduces the deletion insures against
   nothing. The dataset gets `--delete "*"` so its *newest* commit matches the
   bucket, while every earlier commit keeps the deleted file recoverable — the
   best of both.
8. **Restore is a documented script, not a button** (§8).

## 2. What we already have

- **The bucket id, already discovered.** `visibility.js` reads
  `GET /api/spaces/{id}` → `runtime.volumes[]`, keeping entries with
  `type === 'bucket'`. Verified on two Spaces:
  `{source: 'lvwerra/agent-manager-data', mountPath: '/data'}`.
- **`hf` CLI 1.25.1 in the image**, with `buckets`, `cp`, `jobs scheduled`.
  `share.js` already shells out to `hf` with this token — no new auth path.
- `am-config.json` + `GET/PUT /api/config` + a whitelisted enum, rendered as a
  segmented control in `SettingsView.tsx`. `archive.after` is the precedent the
  operator asked for; `backup` is another key in the same object.

## 3. Verified Hub behaviour

All measured against the real Hub, on this Space's own buckets.

### 3.1 Bucket → dataset repo is not possible today

```
$ hf cp hf://buckets/lvwerra/am-dev-2-data/sessions.json \
        hf://datasets/lvwerra/…/sessions.json
Error: Invalid value. Bucket-to-repo copy is not supported.
```

The client raises it and the CLI source attributes it to a **server limitation**.
The Hub docs say so twice: transferring from a bucket to a repository without
reuploading is "not yet available, but is **on the roadmap**".

This is why §5 step 2 goes through a Job with the bucket mounted rather than a
server-side copy. If the roadmap item lands, step 2 collapses into one `hf cp`
and the rest of this design is untouched.

Supported today: local→repo, local→bucket, repo→repo, repo→bucket, bucket→bucket.
Server-side copies require source and destination in the **same storage region**.

### 3.2 Bucket → bucket is server-side, recursive, and fast

| case | files | wall |
|---|---|---|
| whole small bucket (`am-dev-2-data`) | 49 | **1 s** |
| `state/` of the production bucket, cold | 13,482 | **20 s** |
| the same copy again | 13,482 | **18 s** |

Trailing slashes on both sides copy contents recursively, preserving paths
(49/49 landed). ~670 files/s, so the 102,691-file production bucket extrapolates
to **≈2.5 minutes**. The repeat is not cheaper — `cp` re-copies entries rather
than diffing — but no bytes move either way.

### 3.3 A Job can mount the live bucket read-only, while the Space has it

```
$ hf jobs run -v hf://buckets/lvwerra/am-dev-2-data:/live:ro python:3.12 \
    bash -c 'ls /live; find /live -type f | wc -l'
home  install.log  install.sh  order.json  sessions.json  state  workspaces
49
```

Concurrent mount is fine, which is what makes step 2 possible at all.

### 3.4 Upload from that mount into a private dataset

Inside the Job: `hf upload <ds> /live . --repo-type dataset --private --delete "*"`

- 49 files, **8.2 s**, dataset created **private: True**.
- Run again with nothing changed: *"No files have been modified since last commit.
  Skipping to prevent empty commit."* — **same commit sha, no new commit.**

So version history costs nothing on an idle hour, and only changed files transfer
on a busy one. This is the property that makes hourly history affordable.

### 3.5 Bucket storage is accounted in logical bytes

Two *identical* 13,482-file snapshots into one bucket reported
`size: 4,118,488,963, total_files: 26,966` — exactly double. Xet dedups the
chunks physically, but dedup-based *billing* is documented as an Enterprise
benefit, so dated bucket prefixes cannot be assumed free. Hence §1.2: history
goes in the dataset, and the bucket keeps exactly one copy.

Also: `hf buckets info` is **eventually consistent** — immediately after a
verified 49-file copy it still reported `size: 0`. Verify a copy with
`hf buckets list -R`, never with `info`.

### 3.6 The privacy gate refuses a public destination

Flipped the destination dataset to public and triggered the schedule:

```
refusing to back up: dataset lvwerra/… is not private
Job failed with exit code: 1
```

The dataset received **no new commit**. This is the one control standing between
the operator's saved logins and the public internet, so it is verified rather
than assumed.

### 3.7 Incidental

`pip install "huggingface_hub[cli]"` warns on 1.26.0 — *"does not provide the
extra 'cli'"* — which now ships the CLI in the base package. The job script
installs the plain package.

## 4. What is in the bucket (measured)

`lvwerra/agent-manager-data`: **11.4 GB, 102,691 files.** Walking the mount:
89,681 files under `/data`, of which `workspaces/` 58,356, `state/` 13,447,
`node_modules/` 18,647, `.git/` 3,410.

For the record, the cost this design avoids: a cold recursive walk of the mount
ran into minutes (`du -sh /data` did not finish in 300 s), while a warm walk of
one 620 MB workspace took 1 s.

**Credential surface**, all included per §1.3 and the reason §1.4 is a hard gate:

- `state/claude/.credentials.json`, `state/codex/auth.json`, `state/hermes/auth.json`
- `state/vapid.json` — this install's private Web Push key
- `session-secret` at the bucket root
- `home/` — agent dotfiles
- `secret-notes.json` — the operator's descriptions of injected secrets

## 5. The pipeline

One scheduled Job, `am-backup-<space>`, cron from the config:

```
hf jobs scheduled run "0 * * * *" --name am-backup-<space> \
  --secrets HF_TOKEN \
  -e AM_SOURCE=<live bucket> -e AM_MIRROR=<mirror bucket> -e AM_DATASET=<dataset> \
  -v hf://buckets/<live bucket>:/live:ro \
  --timeout 3000s python:3.12 bash -c '<script>'
```

The script:

1. **Gate** — abort unless the dataset and mirror bucket are private (§3.6).
2. **Mirror** — `hf cp hf://buckets/$AM_SOURCE/ hf://buckets/$AM_MIRROR/latest/`.
   Server-side; hashes move, not bytes.
3. **History** — `hf upload $AM_DATASET /live . --repo-type dataset --private
   --delete "*"`, reading the read-only mount.

Details that matter:

- **Values travel as env vars, never as shell text.** A repo id arrives from
  `PUT /api/config` and ends up in an argument list, so ids are validated against
  `^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$` and refused rather than escaped.
  There is no legitimate bucket called `; rm -rf /`. Tested.
- **`--timeout 3000s`** (50 min) is deliberately shorter than the shortest
  interval, so a hung run dies before the next one is due. Tested.
- **No update verb for a scheduled Job** — only run/delete — so any change to
  cron or destination is delete-then-create. The desired state is fingerprinted
  and compared, because missing a change means silently backing up to the old
  destination. Tested.
- **Reconcile is idempotent**: with nothing changed it is one list call and no
  writes. Runs on boot (12 s in, after bucket discovery) and after every config
  save.
- **A backup is a fuzzy snapshot.** Agents write while it runs, so it is not
  point-in-time consistent. Acceptable for this purpose, and worth saying rather
  than glossing.

## 6. Config and API

```js
// am-config.json — validated with a whitelist, like archive.after
backup: {
  every: 'never' | 'hour' | '6h' | 'day',   // default 'never' (§1.6)
  mirror: '',                                // default <ns>/<space>-backup
  dataset: '',                               // default <ns>/<space>-backup
}
```

```
GET  /api/backup/status  → { every, source, mirror, dataset, defaults,
                             scheduled: { cron, suspended, lastRun, nextRun },
                             datasetPrivate, error }
POST /api/backup/run     → trigger the schedule now (or a one-off Job if off)
```

`status` reports the schedule as the **Hub** sees it, not as we last left it, and
re-reads the destination's privacy on every call.

## 7. Settings surface (phase 2)

```
Back up the bucket                            [ off | hourly | 6h | daily ]
  Copies your whole bucket — workspaces, history, saved logins — to private
  Hub storage: a bucket you can restore from instantly, and a dataset that
  keeps version history. The copy runs on the Hub, so it costs this Space
  nothing and continues while it sleeps.

  Mirror   [ lvwerra/agent-manager-backup ]            ● private
  History  [ lvwerra/agent-manager-backup ] (dataset)  ● private

  Last run: 12 minutes ago · next 15:00 · 102,691 files
  [ Back up now ]                          [ Open ↗ ]
```

The privacy dots are not decoration: they are the state of the §1.4 gate, and the
one thing an operator must be able to see at a glance about a copy of their
credentials.

## 8. Restore

The direction the Hub *does* support server-side, pleasingly:

```
hf cp hf://buckets/<mirror>/latest/ hf://buckets/<live>/       # instant, whole bucket
hf cp hf://datasets/<dataset>/      hf://buckets/<live>/       # from a version
```

repo→bucket is supported (§3.1), so restoring a specific commit's contents is
also server-side. Both are **documented but untested** (§10.5).

`scripts/restore-bucket.mjs` will wrap these with the guards that matter: refuse
a non-empty target unless `--force`, and print what would be overwritten first.
Not a button: restoring over a live bucket is destructive, and only the operator
knows which side should win.

## 9. Storage growth

- **Mirror**: one copy of current state, ~11.4 GB today. Plus §1.7 — files
  deleted in `/data` linger, so it is a high-water mark rather than a copy of
  now. Deliberate; prune manually with `hf buckets rm --recursive` against a
  reviewed list if it ever matters.
- **Dataset**: one blob per distinct file version. Idle hours add nothing at all
  (§3.4). The growth term is churny large files — append-only transcripts under
  `state/*/projects/`, and any SQLite an agent keeps — where each hour's version
  is stored forever. If that becomes the dominant cost, the options are
  `super_squash_history` (drops the past, keeps current) or excluding transcripts
  from the dataset step and letting session *sharing* own that data, since it
  already exports traces with redaction. Not decided (§10.4).

## 10. Risks and open questions

1. **A backup is a second copy of every credential.** §1.4's gate is the
   mitigation and it is verified (§3.6). Open: should the backup also refuse when
   the *Space* is public, as `visibility.js` does for the app?
2. **Region.** Server-side copy requires source and destination in the same
   storage region. The mirror is created without an explicit region so it lands
   in the default; a mismatch should be reported as its own error rather than a
   generic copy failure. Untested across regions.
3. **~2.5 min is extrapolated** from 13,482 files in 20 s; the full
   102,691-file copy has not been run end to end. Likewise the dataset step has
   only been measured on 49 files — 102,691 files through `hf upload` is the real
   unknown here, and the reason phase 1 records duration.
4. **Transcript churn in the dataset** (§9) is unbounded and undecided.
5. **Restore has never been exercised.** A backup that has not been restored once
   is a hypothesis. Phase 3 restores into a scratch Space for real.
6. **Sustained hourly Job volume** over weeks is unproven, as is the interaction
   with the Job quota on a free account.
7. **Bucket→repo is on the roadmap** (§3.1) — re-check before elaborating step 2.

## 11. Phasing

1. **Done** — config keys, Hub-side schedule reconciliation, the two-step Job,
   `GET /api/backup/status`, `POST /api/backup/run`, tests. Verified end to end
   against the Hub: schedule created, idempotent re-reconcile, trigger, both
   steps run, private dataset committed, and the privacy gate refusing a public
   destination.
2. **Settings UI** (§7) — interval, destinations, privacy dots, status, run-now.
3. **`scripts/restore-bucket.mjs` + docs, and one real restore** into a scratch
   Space (§10.5).
4. **Retention** — decide §9 for transcript churn.
