#!/usr/bin/env python3
# A stand-in for the `hf` CLI, for scripts/agent-state.sh's restore tests: just
# the bucket commands the restore uses, against a local directory that plays
# the bucket (FAKE_BUCKET_ROOT is the bucket's root; the bucket id is
# FAKE_BUCKET, default test/bucket). Its output has the shapes the real CLI
# (2.2.0) was seen to produce:
#
#   buckets list hf://buckets/B/P --format json
#       the JSON array of P's direct entries; for a prefix holding no files,
#       nothing at all, exit 0
#   buckets sync hf://buckets/B/P DEST --filter-from F --plan PLAN
#       a JSONL plan (a header, then one download operation per file, carrying
#       remote_mtime); `+ pat` / `- pat` rules, first match wins, fnmatch on
#       the path relative to P (`*` crosses `/`); a missing P is an empty plan
#   buckets sync --apply PLAN
#       downloads the plan's files WITHOUT their mtimes, as the real one does
#
# Faults, for the fallback tests: FAKE_HF_LIST / FAKE_HF_SYNC = fail | hang
# (FAKE_HF_LIST also = garbage). A hang leaves a child behind that names the
# bucket root on its command line, so a test can see that a timeout stopped
# the whole process group. Every call, and every file downloaded, is appended
# to FAKE_HF_LOG.
import fnmatch
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

args = sys.argv[1:]
root = os.environ['FAKE_BUCKET_ROOT']
bucket = os.environ.get('FAKE_BUCKET', 'test/bucket')


def note(line):
    if os.environ.get('FAKE_HF_LOG'):
        with open(os.environ['FAKE_HF_LOG'], 'a') as f:
            f.write(line + '\n')


def hang():
    subprocess.run(['sh', '-c', 'sleep 1000; :', root])
    sys.exit(0)


def local(url):
    prefix = 'hf://buckets/'
    parts = url[len(prefix):].split('/', 2) if url.startswith(prefix) else []
    if '/'.join(parts[:2]) != bucket:
        print(f"Error: Bucket '{'/'.join(parts[:2])}' not found.", file=sys.stderr)
        sys.exit(1)
    return os.path.join(root, parts[2] if len(parts) > 2 else '')


note('hf ' + ' '.join(args))

if args[:2] == ['buckets', 'list']:
    mode = os.environ.get('FAKE_HF_LIST', '')
    if mode == 'fail':
        print('Error: 429 Too Many Requests', file=sys.stderr)
        sys.exit(29)
    if mode == 'hang':
        hang()
    if mode == 'garbage':
        print('<html>502 Bad Gateway</html>')
        sys.exit(0)
    d = local(args[2])
    if not os.path.isdir(d):
        sys.exit(0)
    rel = os.path.relpath(d, root)
    print(json.dumps([{'type': 'directory' if os.path.isdir(os.path.join(d, n)) else 'file', 'path': f'{rel}/{n}'}
                      for n in sorted(os.listdir(d))], indent=2))
    sys.exit(0)

if args[:2] == ['buckets', 'sync']:
    mode = os.environ.get('FAKE_HF_SYNC', '')
    if mode == 'fail':
        print('Error: 503 Service Unavailable', file=sys.stderr)
        sys.exit(1)
    if mode == 'hang':
        hang()
    rest = args[2:]
    if rest[0] == '--apply':
        lines = [json.loads(line) for line in open(rest[1])]
        head = lines[0]
        for op in lines[1:]:
            if op.get('action') != 'download':
                continue
            dst = os.path.join(head['dest'], op['path'])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(head['local_source'], op['path']), dst)
            note('download ' + op['path'])
        sys.exit(0)
    src, dest, rules, plan = rest[0], rest[1], [], None
    i = 2
    while i < len(rest):
        if rest[i] == '--filter-from':
            rules = [line.rstrip('\n') for line in open(rest[i + 1]) if line.strip()]
            i += 2
        elif rest[i] == '--plan':
            plan = rest[i + 1]
            i += 2
        else:
            i += 1
    base = local(src)
    ops = []
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base)
            keep = True
            for rule in rules:
                if fnmatch.fnmatchcase(rel, rule[2:]):
                    keep = rule[0] == '+'
                    break
            if keep:
                mtime = datetime.fromtimestamp(os.stat(full).st_mtime, timezone.utc).isoformat()
                ops.append({'type': 'operation', 'action': 'download', 'path': rel, 'reason': 'new file',
                            'size': os.stat(full).st_size, 'remote_mtime': mtime})
    with open(plan, 'w') as f:
        f.write(json.dumps({'type': 'header', 'source': src, 'dest': dest, 'local_source': base}) + '\n')
        for op in ops:
            f.write(json.dumps(op) + '\n')
    sys.exit(0)

print(f'fake hf: unsupported command: {" ".join(args)}', file=sys.stderr)
sys.exit(2)
