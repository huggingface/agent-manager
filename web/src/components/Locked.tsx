import { useState } from 'react';

// Shown when the server reports the Space is public. The terminal backend is
// disabled server-side; this explains how to run a private copy or relock.
export default function Locked({ spaceId }: { spaceId?: string | null }) {
  const id = spaceId || 'owner/space-name';
  const cmd = `from huggingface_hub import duplicate_space\nduplicate_space("${id}", private=True)`;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div className="locked">
      <div className="locked-card">
        <div className="locked-emoji">🔒</div>
        <h1>Agent Manager</h1>
        <p className="locked-lead">
          This Space is <b>public</b>, so the terminal manager is disabled. It has
          no authentication — a public instance would hand anyone a shell and your
          logged-in agents.
        </p>

        <h3>Run your own private copy</h3>
        <p className="locked-sub">
          Press <b>⋮ → Duplicate this Space</b> above and keep it <b>Private</b>, or run:
        </p>
        <div className="locked-cmd">
          <pre><code>{cmd}</code></pre>
          <button className="btn-ghost" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
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
