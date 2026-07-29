#!/usr/bin/env python
"""Create (once) and push the lab Space.

    ./.venv/bin/python deploy.py

Both repos are PRIVATE: /data holds the Claude login for both panels.
"""
import sys

from huggingface_hub import HfApi, Volume, create_bucket, get_token

SPACE_ID = "lvwerra/ghostty-lab"
BUCKET_ID = "lvwerra/ghostty-lab-data"

IGNORE = [
    "node_modules/*", "*/node_modules/*",
    "dist/*", "*/dist/*",
    ".venv/*", ".git/*",
    ".data/*", "*/.data/*",
    ".smoke*/*", "*/.smoke*/*",
    "*.log", ".DS_Store", "*/.DS_Store",
]


def main() -> int:
    api = HfApi(token=get_token())

    create_bucket(BUCKET_ID, private=True, exist_ok=True)
    print(f"bucket ready: {BUCKET_ID} (private)")

    try:
        api.create_repo(SPACE_ID, repo_type="space", space_sdk="docker", private=True)
        print(f"space created: {SPACE_ID} (private)")
    except Exception as err:  # already exists is the normal path on redeploys
        print(f"space exists: {SPACE_ID} ({type(err).__name__})")

    api.set_space_volumes(
        SPACE_ID,
        volumes=[Volume(type="bucket", source=BUCKET_ID, mount_path="/data")],
    )
    print("bucket mounted at /data")

    api.upload_folder(
        repo_id=SPACE_ID,
        repo_type="space",
        folder_path=".",
        ignore_patterns=IGNORE,
        commit_message="ghostty lab: current stack vs server-held libghostty grid",
    )
    print(f"pushed. https://huggingface.co/spaces/{SPACE_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
