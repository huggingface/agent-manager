#!/bin/sh
# Copy a real agent's memory into the seed so the lab's two sessions boot with
# genuine context. Deliberately not committed: this repo is public.
#
#   ./seed/populate.sh <path-to-agent-memory-dir>
#   ./seed/populate.sh                     # uses $LAB_SEED_MEMORY
set -e
SRC="${1:-$LAB_SEED_MEMORY}"
[ -n "$SRC" ] || { echo "usage: $0 <path-to-agent-memory-dir>  (or set \$LAB_SEED_MEMORY)" >&2; exit 2; }
[ -d "$SRC" ] || { echo "no memory dir at $SRC" >&2; exit 1; }
DEST="$(cd "$(dirname "$0")" && pwd)/memory"
mkdir -p "$DEST"
cp "$SRC"/*.md "$DEST"/
echo "seeded $(ls -1 "$DEST"/*.md | wc -l | tr -d ' ') memory files into $DEST"
