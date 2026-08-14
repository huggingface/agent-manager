#!/usr/bin/env bash
# Get every open Codex rollout onto the bucket as a CLOSED object, before a
# deploy replaces the container.
#
#   scripts/migrate-open-rollouts.sh                # snapshot, upload, verify
#   scripts/migrate-open-rollouts.sh --dry-run      # report, touch nothing
#   scripts/migrate-open-rollouts.sh --restore      # boot side: reconcile
#
# WHY THIS EXISTS
#
# Codex appends to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl and
# holds that descriptor open for the whole life of a resumed session. That path
# is a symlink onto the /data bucket (entrypoint.sh), which is FUSE over object
# storage, and the mount's streaming writer can hold the entire open epoch in
# memory until close. Reads inside this container see the buffer, so the file
# looks complete from here. The OBJECT does not have it.
#
# Measured on prod, 2026-08-13, three live Codex sessions:
#
#     rollout-2026-08-05T14-33-11-…   local 9 671 486 B   object     767 B
#     rollout-2026-08-07T15-30-46-…   local 8 051 317 B   object     767 B
#     rollout-2026-08-13T14-09-11-…   local   971 492 B   object  absent
#
# 767 bytes is the session header written at open. Everything after it exists
# only in this container. Kill the container and ~18 MB of conversation across
# three agents is gone — which is exactly the loss mode PR #25 fixes, and
# exactly what deploying that fix would trigger one last time on the way in.
#
# So: copy the writer's own view out through the bucket API (HTTP, not the
# mount), verify it landed, and only then let the deploy proceed.
#
# WHAT IT DOES NOT DO
#
# It does not stop, signal, or touch the Codex processes. It reads. A rollout is
# append-only JSONL, so a snapshot taken while the writer runs is a valid prefix
# of the session — we trim a partial trailing line and record how many bytes
# that cost. Losing the last half-written line is not the failure mode anyone is
# worried about here.
#
# It does not write the canonical path. If it did, the dying writer could flush
# its 767-byte view back over a full copy — the clobber this is meant to
# prevent. Copies go to a separate migration prefix, and --restore reconciles
# them on the way up, once no writer holds the file.
set -euo pipefail

MODE=snapshot
DRY=0
for a in "$@"; do
  case "$a" in
    --restore)  MODE=restore ;;
    --dry-run)  DRY=1 ;;
    -h|--help)  sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

[ -n "${HF_TOKEN:-}" ] || { echo "HF_TOKEN is not set" >&2; exit 1; }

DATA_DIR="${DATA_DIR:-/data}"
CODEX_DURABLE="${CODEX_DURABLE:-$DATA_DIR/state/codex}"
# The dev deploy script names a Space's bucket "<space>-data"; prod follows the
# same rule (lvwerra/agent-manager -> lvwerra/agent-manager-data). Override with
# AM_BUCKET when running against something else.
BUCKET="${AM_BUCKET:-${SPACE_ID:?SPACE_ID unset and AM_BUCKET not given}-data}"
# Staging is local POSIX disk, never the bucket: the whole point is to hold a
# closed byte-exact copy somewhere the FUSE writer has no opinion about.
STAGE="${AM_LOCAL:-/tmp}/rollout-migration"

export CODEX_DURABLE BUCKET STAGE MODE DRY

python3 - <<'PY'
import hashlib, json, os, re, shutil, sys, time
from pathlib import Path

from huggingface_hub import (
    download_bucket_files,
    list_bucket_tree,
    sync_bucket,
)

TOKEN   = os.environ["HF_TOKEN"]
BUCKET  = os.environ["BUCKET"]
DURABLE = Path(os.environ["CODEX_DURABLE"])
STAGE   = Path(os.environ["STAGE"])
DRY     = os.environ["DRY"] == "1"
RESTORE = os.environ["MODE"] == "restore"

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
PREFIX   = "state/codex/migration"          # remote home for closed copies
ROLLOUT  = re.compile(r"/sessions/.*/rollout-[^/]+\.jsonl$")


def remote_of(p: Path) -> str:
    """Bucket key for a path under the mount: /data/state/x -> state/x."""
    return str(p.relative_to(DATA_DIR))


def object_size(key: str):
    """Size of one bucket object, or None if there is no object.

    Deliberately NOT get_bucket_file_metadata(): on these xet-backed objects its
    .size is wrong. Measured 2026-08-13 against known-length uploads — a
    9 796 319 B rollout reported 767, a 2 329 B manifest reported 694 — while
    list_bucket_tree reported both correctly and download_bucket_files returned
    byte-exact content. Do not "simplify" this back to a metadata call: every
    number this script prints, and its entire safe/unsafe verdict, depends on
    the size being real.
    """
    parent, _, name = key.rpartition("/")
    for f in list_bucket_tree(BUCKET, parent, recursive=False, token=TOKEN):
        if Path(f.path).name == name:
            return getattr(f, "size", None)
    return None


def open_rollouts():
    """Every rollout held open for WRITING, with the writer's own file position.

    /proc is the only honest source here. An agent's rollout is identified by
    the descriptor a live Codex process holds, not by anything on disk: mtime
    on the mount is stale (it tracks the last object commit, not the last
    append), so a find -newermt sweep misses precisely the files at risk.
    """
    out = {}
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        fd_dir = pid_dir / "fd"
        try:
            fds = list(fd_dir.iterdir())
        except OSError:
            continue                        # not ours, or exited mid-scan
        for fd in fds:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if not ROLLOUT.search(target):
                continue
            try:
                info = (pid_dir / "fdinfo" / fd.name).read_text()
            except OSError:
                continue
            flags = pos = 0
            for line in info.splitlines():
                if line.startswith("flags:"):
                    flags = int(line.split()[1], 8)
                elif line.startswith("pos:"):
                    pos = int(line.split()[1])
            # O_RDONLY is 0 in the low two bits. Readers (the manager parsing a
            # trace, a repin hook) are not at risk and must not be snapshotted
            # at their seek position.
            if flags & 0o3 == 0:
                continue
            prev = out.get(target)
            if prev is None or pos > prev["pos"]:
                out[target] = {"pos": pos, "pid": int(pid_dir.name)}
    return out


def trim_to_last_record(raw: bytes):
    """Drop a half-written trailing line. Returns (kept, dropped, bad_lines)."""
    cut = raw.rfind(b"\n")
    kept, dropped = (raw[: cut + 1], len(raw) - cut - 1) if cut >= 0 else (b"", len(raw))
    bad = 0
    for line in kept.splitlines():
        if not line.strip():
            continue
        try:
            json.loads(line)
        except Exception:
            bad += 1
    return kept, dropped, bad


def snapshot():
    live = open_rollouts()
    if not live:
        print("no Codex rollout is open for writing — nothing to migrate")
        return 0

    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    run_dir = STAGE / run_id
    entries, concerns = [], 0

    print(f"==> {len(live)} open rollout(s); bucket {BUCKET}")
    for path, fd in sorted(live.items()):
        p = Path(path)
        raw = p.read_bytes()                # the writer's view, buffer included
        kept, dropped, bad = trim_to_last_record(raw)
        digest = hashlib.sha256(kept).hexdigest()

        remote_size = object_size(remote_of(p))

        at_risk = len(kept) - (remote_size or 0)
        staged = run_dir / remote_of(p)
        if not DRY:
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(kept)

        entries.append({
            "path": str(p),
            "remote": remote_of(p),
            "pid": fd["pid"],
            "writer_pos": fd["pos"],
            "bytes": len(kept),
            "sha256": digest,
            "partial_tail_dropped": dropped,
            "invalid_lines": bad,
            "object_bytes_before": remote_size,
            "bytes_at_risk": at_risk,
        })
        if bad:
            concerns += 1
        flag = f"  !! {bad} unparseable line(s)" if bad else ""
        print(f"    {p.name}")
        print(f"      local {len(kept):>10}  object {str(remote_size):>10}"
              f"  at risk {at_risk:>10}  dropped {dropped}{flag}")

    if DRY:
        print("==> --dry-run: nothing staged, nothing uploaded")
        return 0

    manifest = {
        "run_id": run_id,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bucket": BUCKET,
        "space": os.environ.get("SPACE_ID"),
        "entries": entries,
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    dest = f"hf://buckets/{BUCKET}/{PREFIX}/{run_id}"
    print(f"==> uploading {run_dir} -> {dest}")
    sync_bucket(source=str(run_dir), dest=dest, token=TOKEN, quiet=True)

    # Verify by reading the objects back, not by trusting the writer. A copy
    # nobody checked is the same bet we are trying to get off.
    print("==> verifying")
    for e in entries:
        key = f"{PREFIX}/{run_id}/{e['remote']}"
        size = object_size(key)
        if size is None:
            print(f"    !! {e['remote']}: no object after upload")
            concerns += 1
            continue
        if size != e["bytes"]:
            print(f"    !! {e['remote']}: object {size} B, staged {e['bytes']} B")
            concerns += 1
            continue
        check = run_dir / "verify" / e["remote"]
        check.parent.mkdir(parents=True, exist_ok=True)
        download_bucket_files(BUCKET, [(key, str(check))], token=TOKEN)
        got = hashlib.sha256(check.read_bytes()).hexdigest()
        if got != e["sha256"]:
            print(f"    !! {e['remote']}: sha256 mismatch on readback")
            concerns += 1
        else:
            print(f"    ok {Path(e['remote']).name}  {e['bytes']} B  {got[:12]}")
        check.unlink(missing_ok=True)
    shutil.rmtree(run_dir / "verify", ignore_errors=True)

    print(f"==> run {run_id} at hf://buckets/{BUCKET}/{PREFIX}/{run_id}")
    if concerns:
        print(f"!!  {concerns} problem(s) — do NOT restart until these are understood",
              file=sys.stderr)
        return 1
    print("==> every open rollout is a verified closed object; safe to deploy")
    return 0


def restore():
    """Boot side. Put back anything the dying writer failed to flush.

    Runs before agents start, when no descriptor is held. A migrated copy is
    only ever restored when it is strictly longer than what is on the canonical
    path, so a container that shut down cleanly — and therefore flushed a
    complete rollout — is left completely alone.
    """
    runs = sorted(
        {Path(f.path).parts[3] for f in list_bucket_tree(BUCKET, PREFIX, recursive=True, token=TOKEN)
         if Path(f.path).name == "manifest.json"}
    )
    if not runs:
        print("no migration runs on the bucket — nothing to restore")
        return 0

    run_id = runs[-1]
    local_manifest = STAGE / f"manifest-{run_id}.json"
    local_manifest.parent.mkdir(parents=True, exist_ok=True)
    download_bucket_files(BUCKET, [(f"{PREFIX}/{run_id}/manifest.json", str(local_manifest))],
                          token=TOKEN)
    manifest = json.loads(local_manifest.read_text())
    print(f"==> newest migration run {run_id}, {len(manifest['entries'])} rollout(s)")

    restored = failed = 0
    for e in manifest["entries"]:
        target = Path(e["path"])
        have = target.stat().st_size if target.exists() else 0
        if have >= e["bytes"]:
            print(f"    skip {target.name}: on disk {have} B >= migrated {e['bytes']} B")
            continue
        if DRY:
            print(f"    would restore {target.name}: {have} B -> {e['bytes']} B")
            restored += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = STAGE / "restore" / e["remote"]
        tmp.parent.mkdir(parents=True, exist_ok=True)
        download_bucket_files(BUCKET, [(f"{PREFIX}/{run_id}/{e['remote']}", str(tmp))],
                              token=TOKEN)
        if hashlib.sha256(tmp.read_bytes()).hexdigest() != e["sha256"]:
            print(f"    !! {target.name}: migrated copy fails its own checksum; left alone")
            failed += 1
            continue
        # Stage locally, then one close()d copy onto the mount. Never stream a
        # download straight through FUSE — that is the write pattern this whole
        # script exists to work around.
        shutil.copyfile(tmp, target)
        tmp.unlink(missing_ok=True)
        print(f"    restored {target.name}: {have} B -> {e['bytes']} B")
        restored += 1

    shutil.rmtree(STAGE / "restore", ignore_errors=True)
    print(f"==> {restored} restored, {failed} failed")
    return 1 if failed else 0


sys.exit(restore() if RESTORE else snapshot())
PY
