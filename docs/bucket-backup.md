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

Both happen inside one **HF Job** that this app launches and forgets, so the
copying runs on the Hub: a backup costs this Space one API call, never reads
`/data` (whose cold walk runs to minutes), and cannot wedge the event loop that
pumps the terminals. It does cost the *operator* — each run bills an HF Job
(cpu-basic) and both copies occupy Hub storage, which §7 states plainly before
anyone switches it on. It needs an `HF_TOKEN` (§1.6). Nothing here deletes from
the bucket, ever.

## 1. Decisions (locked)

1. **One dumb loop: if it is on and due, launch a Job.** Every five minutes the
   app asks whether the last run started more than an interval ago; if so it
   launches one detached Job and forgets it. No cron, no catch-up queue, no
   reconciliation. "Due" is derived from a timestamp on disk, so it behaves
   correctly across restarts.

   The cost is that backups only fire while the app is up. That is a smaller loss
   than it sounds — the bucket only changes when agents are running, which means
   when the Space is up — and `hf jobs scheduled` (a cron on the Hub, which does
   fire while the Space sleeps) is a contained change if that stops being true.
   It was built and verified working; it was dropped to keep the PoC simple.
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
6. **It requires `HF_TOKEN` in the environment.** There is no way to launch a Job
   or write to the Hub without one, so with no token the feature reports itself
   unavailable — one reason string, shared by the timer and the settings row —
   rather than failing every interval into the logs.
7. **Off until the operator turns it on.** It copies this machine's contents into
   other Hub resources; that is a deliberate act. Once on: 1h, 3h or 24h.
8. **Never prune the mirror.** A file deleted in `/data` stays in the bucket
   mirror. An `rm -rf` in a workspace is precisely the accident being insured
   against, and a mirror that faithfully reproduces the deletion insures against
   nothing. The dataset gets `--delete "*"` so its *newest* commit matches the
   bucket, while every earlier commit keeps the deleted file recoverable — the
   best of both.
9. **The skip list applies to the history, not the mirror.** `hf cp` cannot
   filter (§3.9), and making the mirror filterable would cost the server-side copy
   that makes it nearly free. The dataset is where thousands of env files actually
   hurt — every one of them gets hashed on every run — so that is where they are
   skipped.
10. **Skip tokens are folder names, expanded server-side.** A bare name becomes
   both `name/**` and `**/name/**`, because the second does not imply the first
   (§3.8). Tokens are validated to hold no whitespace or shell characters: they
   cross into the Job as one space-joined env var and the shell splits them back
   apart, so the charset is what makes that split exact.
11. **Restore is a documented script, not a button** (§8).

## 2. What we already have

- **The bucket id, already discovered.** `visibility.js` reads
  `GET /api/spaces/{id}` → `runtime.volumes[]`, keeping entries with
  `type === 'bucket'`. Verified on two Spaces:
  `{source: 'lvwerra/agent-manager-data', mountPath: '/data'}`.
- **`hf` CLI 1.25.1 in the image**, with `buckets`, `cp` and `jobs run`.
  `share.js` already shells out to `hf` with this token — no new auth path, and
  `index.js` already treats a missing `HF_TOKEN` as a feature-disabled state
  (`canRelaunch`), which is the pattern §1.6 follows.
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

Flipped the destination dataset to public and launched a run:

```
refusing to back up: dataset lvwerra/… is not private
Job failed with exit code: 1
```

The dataset received **no new commit**. This is the one control standing between
the operator's saved logins and the public internet, so it is verified rather
than assumed.

### 3.8 Excluding folders: `--exclude` works, and the glob rule surprises

`hf upload` takes repeatable `--exclude` globs, and they do what you want — but
**`**/env/**` does not match a top-level `env/`**:

| patterns | `env/` at root | `sub/env/` |
|---|---|---|
| `**/env/**` | **kept** | excluded |
| `env/**` + `**/env/**` | excluded | excluded |

So a bare folder token has to become two patterns. With only the `**/` form the
copy at the bucket root still goes up, which is exactly the case an operator means
when they type `node_modules`.

What it saves, measured on an 805-file tree (800 of them a `.venv`):

| | files hashed | wall |
|---|---|---|
| no excludes | 805 | **7 s** |
| `.venv` excluded | 5 | **1 s** |

That is local disk; the Job reads a FUSE mount, which is slower, so the real
saving is larger than this.

**The list ships prepopulated.** An install that has never set one gets
`node_modules`, `.venv`, `venv`, `__pycache__`, `.cache`, `.npm`, `.pnpm-store`,
`.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.ipynb_checkpoints`, `.next`,
`.turbo` — every one of them rebuilt on demand by a package manager or toolchain.

The names came from walking this Space's own bucket, not from taste. Across 24
workspace folders: 11 `node_modules`, 6 `.venv`, 4 `.cache`, plus a `$HOME/.cache`
holding `ms-playwright`, `google-chrome-for-testing-headless`, `huggingface`, `uv`
and the `claude-cli-nodejs` transcripts of §3.10.

Two things that survey found are deliberately **not** in the default:

- **`.git` — 11 of them, the most common folder in the bucket.** Rank candidates
  by size or count and it comes out on top; it is also the one thing you would
  most want back. Never default it.
- **`dist`, `build`, `target`** — regenerable in most repos, a hand-written source
  folder in enough of them. A default that silently drops work is worse than one
  that copies some junk, so these are opt-in.

An absent key and an empty list mean different things: `undefined` is "never
asked" and takes the default, `[]` is a list the operator emptied on purpose and
stays empty. Without that split, clearing the field in Settings would refill
itself on the next read. Note the consequence for an **existing** install whose
config predates this: it has no key, so it picks the default up and its next run
skips those folders. Nothing already backed up is lost — newly excluded files drop
out of the newest commit but stay in the dataset's history, retrievable from the
revision that last held them.

### 3.9 The server-side mirror cannot filter

`hf cp` has no `--include/--exclude` at all, and `hf sync` refuses remote→remote
("One path must be local"). So the skip list applies to the **dataset history
only** — the mirror is a whole-bucket server-side copy or nothing.

It could be filtered: inside the Job the bucket is mounted at `/live`, so
`hf buckets sync /live hf://buckets/<mirror>/latest --exclude … --delete` is a
*local*→remote sync and does support patterns. It would also throw away the
property that makes the mirror nearly free — no bytes move, hashes only, 13,482
files in 20 s — and make it read and re-upload 11.4 GB instead. Not worth it for
files nobody wanted anyway. §10.9.

### 3.10 What actually fails on a real bucket

This Space's backups had been failing for a day before anyone noticed, which is
the whole reason §7.1 exists. Two separate causes, from the Job logs:

**The Hub refuses `.cache/` paths.** The mirror step succeeds, then:

```
✓ Copied
Error: Invalid value. Invalid `path_in_repo` in CommitOperation:
cannot update files under a '.cache/' folder
(path: 'home/.cache/claude-cli-nodejs/…/2026-07-09T08-43-35-094Z.jsonl')
```

A bucket with an agent cache under `home/.cache/` can therefore *never* produce a
dataset commit. `lvwerra/agent-manager-backup` held exactly one commit — "initial
commit" — for a day of hourly runs.

**The walk does not fit the job.** Failed runs show `Job timeout` after 1h33m to
2h7m, against a `--timeout 3000s` (50 min) we asked for — so that flag is not
being honoured either, and something around 1h30m is. Successful runs on a
49-file bucket take 14–17 s; this bucket is 102,691 files on a FUSE mount.

Excluding `.cache`, `node_modules`, `.venv` and `__pycache__` was **still running
after 40 minutes** with no "Found N files" line, i.e. still walking. So exclusions
fix the `.cache` rejection but may not fix the walk: `hf upload` appears to
enumerate the tree before filtering it. Unresolved — §10.10.

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

One detached Job per interval, `am-backup-<space>`:

```
hf jobs run --detach --name am-backup-<space> \
  --secrets HF_TOKEN \
  -e AM_SOURCE=<live bucket> -e AM_MIRROR=<mirror bucket> -e AM_DATASET=<dataset> \
  -v hf://buckets/<live bucket>:/live:ro \
  --flavor cpu-basic --timeout 3000s python:3.12 bash -c '<script>'
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
- **`--flavor cpu-basic` is pinned, not inherited.** The operator pays for every
  run, the work is API calls and file hashing, and a change to the Hub's default
  flavour must not be able to quietly make hourly backups more expensive. Tested.
- **Runs never overlap.** Before launching, the previous Job's stage is checked;
  a first backup of a large bucket can outlast an interval, and two concurrent
  uploads to one dataset would race. Skipping is logged, not silent.
- **The config is re-read every tick**, so changing the interval takes effect
  without restarting anything.
- **A backup is a fuzzy snapshot.** Agents write while it runs, so it is not
  point-in-time consistent. Acceptable for this purpose, and worth saying rather
  than glossing.

## 6. Config and API

```js
// am-config.json — validated with a whitelist, like archive.after
backup: {
  every: 'never' | '1h' | '3h' | '24h',   // default 'never' (§1.7)
  mirror: '',                              // default <ns>/<space>-backup
  dataset: '',                             // default <ns>/<space>-backup
  exclude: [],                             // folder tokens kept out of the history
}
```

```
GET  /api/backup/status  → { every, source, mirror, dataset, defaults, hasToken,
                             canRunNow, running, unavailable,
                             exclude, excludePatterns,
                             last: { at, jobId, stage }, nextDue,
                             datasetPrivate, error }
POST /api/backup/run     → launch one Job now (works with the schedule off)
```

**On demand does not require a schedule.** `unavailable` is why the *timer* is
quiet — it includes "switched off" — while `canRunNow` ignores the interval
entirely, because taking one backup before a risky change is the main reason to
want a button. Both derive from one function, so the row and the timer can never
disagree.

`POST /api/backup/run` refuses while a run is in flight ("a backup is already
running"): two Jobs uploading to one dataset would race. The route returns the
reason in the body and the client surfaces it, rather than swallowing it for a
bare status code.

`status` re-reads the last Job's stage from the **Hub** and the destination's
privacy on every call, rather than reporting what we last remembered.

## 7. Settings surface

```
Back up the bucket                              [ off | 1h | 3h | 24h ]
  Copies your whole bucket — workspaces, history, saved logins — to private
  Hub storage: a bucket you can restore from instantly, and a dataset that
  keeps version history. Nothing is ever deleted from your bucket.

  Each run is an HF Job billed to your account — cpu-basic, $0.01 per hour
  of runtime, so a few minutes per backup — plus Hub storage for both
  copies. Every 1h means 24 runs a day.

  Backup dataset    lvwerra/am-dev-2-backup     -> the dataset page
  Mirror bucket     lvwerra/am-dev-2-backup     -> the bucket page
  Backup jobs       am-backup-am-dev-2          -> every run of this Space's backup
  Last updated      4 Aug 19:35                 -- a timestamp, never a stage

  Skip these folders — type a name and press Enter
  [ node_modules × ] [ .venv × ] [ add another…            ]

  [ Back up now ]        <- available whenever there is a token, schedule or not;
                            reads "Backing up..." and is disabled while one runs
```

**A table, not a sentence.** Three destinations and a timestamp are things you
scan. It reuses the `.kv` block the Space section already uses, so it looks like
the rest of the dashboard rather than like a new invention.

**Both repos are named, because they default to the same id string** — one a
dataset, one a bucket. A single unlabelled name told you which only by luck. The
dataset row carries the privacy state, since that is what the gate checks.

**The jobs link is static.** Every run is launched with `--name am-backup-<space>`,
which the Hub keeps as a `name=` label, so
`/settings/jobs?label=name%3Dam-backup-<space>` lists them all — past, running and
failed. Strictly better than linking the latest job id: no state to track, and the
page you land on shows a failure in context. A test pins the launch name and the
filter to the same value so they cannot drift.

**The skip field is a token field**, because that is what the data is: a short
list of folder names, each independently removable. Enter or comma commits,
Backspace on an empty box takes the last one back. The status API also reports the
expanded globs — a skip list nobody can see the expansion of is one nobody can
debug, and §3.8 is why the expansion is not obvious.

**No stage in the table.** It read `(running)` for runs that had long finished,
because `stage || 'RUNNING'` invented an answer whenever the Hub did not give one.
The state a Job is in belongs on the jobs page linked above; the row reports only
when it last ran. Two fixes behind that:

- **Active stages are enumerated, not terminal ones.** `SCHEDULING`/`RUNNING` mean
  in flight; anything else — including an unrecognised stage or no answer at all —
  counts as finished. The old way round meant an unknown answer read as "running",
  which both lied and would have blocked every later backup behind a job that no
  longer exists.
- **The Job id is parsed format-agnostically.** The image installs
  `huggingface_hub` unpinned, so the CLI in a Space is not the one on a dev
  machine, and a differing launch output silently left `jobId: null` — which
  disabled overlap detection and left nothing to poll. `parseJobId` accepts
  `id=<id>`, a bare id, or one inside a job URL, and logs the raw output when it
  still cannot find one.

**Links inherit the text colour**, with a dotted underline that goes solid and
accent on hover — the same restraint as `.trace-hint a`. Default-blue anchors were
the one thing in the row that did not look like this app.

**The cost is the operator's, so the row says whose.** "It costs this Space
nothing" was true and beside the point: the Space is not who pays. What matters
before switching this on is that each run bills an HF Job and both copies occupy
Hub storage, so the row states the tier, the rate, and how many runs an interval
implies.

**Unavailable has to look unavailable.** With no token, only *off* is selectable
and a warning box says why — that backing up needs a write-scoped `HF_TOKEN`
secret (§1.6) which this Space does not have. `disabled` alone only stops the
click: `.seg button` had no `:disabled` style, so a dead control still rendered as
a live one. Fixed in `styles.css`, which also fixes every other segmented control
in the app.

The privacy dots are not decoration: they are the state of the §1.4 gate, and the
one thing an operator must be able to see at a glance about a copy of their
credentials.

## 7.1 Making failure visible

A backup that fails quietly is worse than no backup, because the operator stops
thinking about it. Nothing wrote a failure down before: the settings row learned of
one only if somebody happened to open it, and `/api/backup/status` asked the Hub
live rather than remembering.

- **The timer records how each run ended**, once per job id, into
  `backup-state.json`: stage, the platform's message, and one line of reason
  lifted from the Job's own logs. That is where "cannot update files under a
  '.cache/' folder" comes from — the platform only says `Job timeout`, which tells
  an operator nothing about what to do.
- **`/api/info` carries a health object**, or null when all is well. It is read
  from state, never the Hub, because every open tab polls that route every 15
  seconds. Withheld while the Space is public, like `secrets`.
- **A strip above the stage**, on every view, not dismissible — a dismissed
  warning is silence again, and silence is the failure mode. It shows the reason,
  links to the filtered jobs list, and opens Settings.
- **Staleness counts as unwell.** Three intervals with no successful run raises the
  strip even when nothing errored. A timer that never fires, or a token that went
  bad, leaves an operator exactly as wrongly confident as a failing run — and looks
  perfectly healthy without this check.

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

### 10.9 The mirror still holds what the history skips

Excluded folders stay in the bucket mirror (§3.9), so they still occupy its
storage, and a restore from the mirror brings them back. That is arguably right —
the mirror exists to put a Space back exactly as it was — but it means "skip" means
"skip in the history", and the settings copy says so rather than implying more.

### 10.10 The walk may not fit any job

Failed runs on this bucket are killed around 1h30m (§3.10), and `--timeout 3000s`
is not honoured. Excluding the obvious noise did not visibly shorten the walk in a
40-minute observation, which suggests `hf upload` enumerates before it filters. If
that holds, the fix is not a longer list of exclusions but a different step 2 —
uploading a subtree at a time, or letting the mirror be the only whole-bucket copy
and giving the dataset a narrower job (sessions, config, transcripts) rather than
everything. Undecided, and the reason §7.1 matters in the meantime: the operator
should be told it is broken even while it stays broken.

## 11. Phasing

1. **Done (this PR)** — config keys, the interval loop, the two-step Job, the
   token gate, `GET /api/backup/status`, `POST /api/backup/run`, the settings row,
   and tests. Verified end to end against the real Hub on a small bucket: off and
   no-token skip with a reason, first tick launches, the next tick correctly says
   "not due", the Job completes, and the private dataset gets its commit. The
   privacy gate was verified by breaking it — public destination, run aborts with
   exit 1, no commit.
2. **A real run against the production bucket** — 11.4 GB / 102,691 files. Every
   number for that scale is still extrapolated (§10.3); this is the next thing to
   learn, and cheap to learn.
3. **`scripts/restore-bucket.mjs` + docs, and one real restore** into a scratch
   Space (§10.5). Until this runs, the feature is a hypothesis.
4. **Retention** — decide §9 for transcript churn.
