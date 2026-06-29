#!/usr/bin/env python3
"""Spin up your own PRIVATE Agent Manager Space by duplicating the public template.

    pip install huggingface_hub
    hf auth login          # or: huggingface-cli login
    python setup.py

The new Space is private by default. Open it, then log in to each agent inside
its terminal (run `claude`, `codex`, ...). Enable Persistent Storage in the
Space settings if you want sessions/logins to survive restarts.
"""
import sys
from huggingface_hub import duplicate_space

TEMPLATE = "lvwerra/agent-manager-template"

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else None  # optional "you/your-space"
    res = duplicate_space(TEMPLATE, to_id=target, private=True)
    url = getattr(res, "url", res)
    print(f"\n✅ Created your private Space: {url}")
    print("   Keep it PRIVATE — this app has no authentication.")
