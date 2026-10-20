#!/usr/bin/env python3
"""Spin up your own PRIVATE Agent Manager Space from the public template.

    pip install -U huggingface_hub
    hf auth login          # or: huggingface-cli login
    python setup.py [your-username/agent-manager] [your-username/agent-manager-data]

The script creates a private Storage Bucket and mounts it read-write at /data
while duplicating the Space. Open the new private Space only after that, then
log in to each agent inside its terminal (run `claude`, `codex`, ...).
"""
import sys
from huggingface_hub import HfApi, Volume, create_bucket

TEMPLATE = "lvwerra/agent-manager-template"

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else None  # optional "you/your-space"
    api = HfApi()
    if target and "/" in target:
        namespace, space_name = target.split("/", 1)
    else:
        namespace = api.whoami()["name"]
        space_name = target or TEMPLATE.rsplit("/", 1)[1]
    bucket_id = sys.argv[2] if len(sys.argv) > 2 else f"{namespace}/{space_name}-data"

    create_bucket(bucket_id, private=True, exist_ok=True)
    res = api.duplicate_repo(
        from_id=TEMPLATE,
        to_id=target,
        repo_type="space",
        private=True,
        space_volumes=[
            Volume(type="bucket", source=bucket_id, mount_path="/data"),
        ],
    )
    url = getattr(res, "url", res)
    print(f"\n✅ Created your private Space: {url}")
    print(f"   Mounted private bucket at /data: {bucket_id}")
    print("   Keep it PRIVATE — this app has no authentication.")
