#!/usr/bin/env bash
# Deploy a branch of this repo to a throwaway dev Space with its own bucket.
#
#   scripts/deploy-dev-space.sh am-dev-2 [branch] [--no-wait]
#
# Idempotent: safe to re-run to redeploy. Creates the Space (private) and its
# bucket if missing, force-pushes <branch> as the Space's main, and rewrites the
# Space's README front-matter so the dashboard card says WHICH instance it is.
#
# Needs HF_TOKEN with write access to your namespace.
set -euo pipefail

NAME="${1:?usage: deploy-dev-space.sh <space-name> [branch] [--no-wait]}"
BRANCH="${2:-HEAD}"
WAIT=1
for a in "$@"; do [ "$a" = "--no-wait" ] && WAIT=0; done
[ -n "${HF_TOKEN:-}" ] || { echo "HF_TOKEN is not set" >&2; exit 1; }

OWNER="${HF_OWNER:-$(python3 -c "
import os
from huggingface_hub import HfApi
print(HfApi(token=os.environ['HF_TOKEN']).whoami()['name'])")}"
SPACE="$OWNER/$NAME"
BUCKET="$OWNER/$NAME-data"
HOST="$(echo "$SPACE" | tr '/' '-').hf.space"
SHA="$(git rev-parse --short "$BRANCH")"
REF="$(git rev-parse --abbrev-ref "$BRANCH" 2>/dev/null || echo detached)"

# git hooks live on the storage bucket, which cannot hold an exec bit, so git
# either skips them or (if a stray directory shadows one) refuses to commit.
# Point hooksPath at an empty dir for the duration.
HOOKS="$(mktemp -d)"; trap 'rm -rf "$HOOKS"' EXIT
git() { command git -c "core.hooksPath=$HOOKS" "$@"; }

echo "==> $SPACE  <-  $REF ($SHA)"

# 1. Space + bucket + mount. PRIVATE, always: this app authenticates nobody past
#    HF's edge, so a public instance is a shell for anyone who finds it.
python3 - "$SPACE" "$BUCKET" <<'PY'
import os, sys
from huggingface_hub import HfApi, create_bucket, Volume
space, bucket = sys.argv[1], sys.argv[2]
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo(space, repo_type="space", space_sdk="docker", private=True, exist_ok=True)
create_bucket(bucket, private=True, exist_ok=True, token=os.environ["HF_TOKEN"])
# Its own bucket: a dev instance must never mount prod's /data, or it inherits
# prod's sessions, workspaces and CLI credentials.
api.set_space_volumes(space, volumes=[Volume(type="bucket", source=bucket, mount_path="/data")])
print(f"    space+bucket ready, {bucket} mounted at /data")
PY

# 2. Push the branch AS main (Spaces build from main).
git remote remove "dev-$NAME" 2>/dev/null || true
git remote add "dev-$NAME" "https://$OWNER:$HF_TOKEN@huggingface.co/spaces/$SPACE"
# LFS objects first: without a working pre-push hook the pointer arrives with no
# object behind it and the Hub rejects the whole push.
git lfs push --all "dev-$NAME" 2>/dev/null || true
git push --force --quiet "dev-$NAME" "$BRANCH:refs/heads/main"
echo "    pushed $SHA -> $SPACE main"

# 3. Name the card so dev and prod are distinguishable at a glance on the
#    dashboard. Only on the Space — the repo's own README is left alone, so this
#    never renames production. The Dockerfile does not COPY README.md, so this
#    commit rebuilds nothing (all layers cached).
python3 - "$SPACE" "$NAME" "$REF" "$SHA" <<'PY'
import os, re, sys
from huggingface_hub import HfApi
space, name, ref, sha = sys.argv[1:5]
api = HfApi(token=os.environ["HF_TOKEN"])
md = open("README.md", encoding="utf-8").read()
fm = re.match(r"^---\n(.*?)\n---\n(.*)$", md, re.S)
if not fm:
    print("    !! README has no front-matter; card left as-is"); raise SystemExit(0)
head, body = fm.group(1), fm.group(2)
def setkey(h, k, v):
    pat = re.compile(rf"^{k}:.*$", re.M)
    return pat.sub(f"{k}: {v}", h) if pat.search(h) else f"{h}\n{k}: {v}"
head = setkey(head, "title", f"{name} (dev)")
head = setkey(head, "emoji", "🚧")
head = setkey(head, "colorFrom", "yellow")
head = setkey(head, "short_description", f"DEV instance · branch {ref} @ {sha} · own bucket, not prod data")
api.upload_file(
    path_or_fileobj=f"---\n{head}\n---\n{body}".encode(),
    path_in_repo="README.md", repo_id=space, repo_type="space",
    commit_message=f"dev card: {name} on {ref} @ {sha}",
)
print(f"    card set to '{name} (dev)' 🚧")
PY

[ "$WAIT" = "1" ] || { echo "==> not waiting; watch https://huggingface.co/spaces/$SPACE"; exit 0; }

# 4. Wait for the build, then prove the app answers (JSON, not HF's HTML 404).
echo "==> building (a first build is ~10-15 min; later ones reuse layers)"
for i in $(seq 1 120); do
  stage=$(curl -s -H "authorization: Bearer $HF_TOKEN" \
    "https://huggingface.co/api/spaces/$SPACE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runtime"]["stage"])')
  case "$stage" in
    RUNNING) echo "    RUNNING"; break;;
    *ERROR*) echo "    build failed: $stage — see https://huggingface.co/spaces/$SPACE" >&2; exit 1;;
    *) printf '\r    %s (%ds)' "$stage" $((i*20));;
  esac
  sleep 20
done
health=$(curl -s -m 30 -H "authorization: Bearer $HF_TOKEN" "https://$HOST/api/health")
echo "    /api/health -> $health"
case "$health" in
  *'"ok":true'*) echo "==> live: https://$HOST" ;;
  *) echo "    !! not answering JSON yet — an HTML body here means the token cannot see the Space" >&2; exit 1;;
esac
