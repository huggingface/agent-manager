import { useState } from 'react';
import { LockGlyph } from './icons';

// Shown when the server reports the Space is public. The terminal backend is
// disabled server-side; this explains how to run a private copy or relock.
export default function Locked({ spaceId }: { spaceId?: string | null }) {
  const id = spaceId || 'owner/space-name';
  const cmd = `from huggingface_hub import HfApi, Volume, create_bucket

api = HfApi()
space_id = "your-username/agent-manager"
bucket_id = "your-username/agent-manager-data"

create_bucket(bucket_id, private=True, exist_ok=True)
api.duplicate_repo(
    from_id="${id}",
    to_id=space_id,
    repo_type="space",
    private=True,
    space_volumes=[
        Volume(
            type="bucket",
            source=bucket_id,
            mount_path="/data",
        ),
    ],
)`;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div className="locked">
      <div className="locked-card">
        <div className="locked-emoji"><LockGlyph /></div>
        <h1>Agent Manager</h1>
        <p className="locked-lead">
          This Space is <b>public</b>, so the terminal manager is disabled. It has
          no authentication — a public instance would hand anyone a shell and your
          logged-in agents.
        </p>

        <h3>Run your own private copy</h3>
        <p className="locked-sub">
          Create a private Storage Bucket mounted at <b>/data</b>, then duplicate this Space:
        </p>
        <div className="locked-cmd">
          <pre><code>{cmd}</code></pre>
          <button className="locked-copy" onClick={copy} aria-label="Copy setup code" title={copied ? 'Copied' : 'Copy'}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="8" width="10" height="12" rx="2" />
              <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>

        <h3>Is this your Space?</h3>
        <p className="locked-sub">
          Set it to <b>Private</b> in <b>Settings → Change visibility</b>. It unlocks
          automatically within a minute.
        </p>
      </div>
    </div>
  );
}
