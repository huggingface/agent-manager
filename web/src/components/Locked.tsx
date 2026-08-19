import { useState } from 'react';
import type { SessionState } from '../types';
import { SlidersGlyph, SunGlyph, GridGlyph, PlusGlyph, AmMark } from './icons';
import Logo from './Logo';
import StateLogo from './StateLogo';

// A frozen, slightly dimmed replica of the real sidebar so the install page
// looks like the product it unlocks. Pure decoration: no handlers, no state.
type MockSession = { name: string; cli: string; tint: string; state: SessionState };
type MockItem = MockSession | { group: string; members: MockSession[] };
const MOCK: MockItem[] = [
  { group: 'research', members: [
    { name: 'writer', cli: 'claude', tint: '#d97757', state: 'working' },
    { name: 'reviewer', cli: 'codex', tint: '#5eb6a6', state: 'waiting' },
  ] },
  { name: 'refactor-bot', cli: 'claude', tint: '#d97757', state: 'idle' },
  { name: 'gemini-cli-1', cli: 'gemini', tint: '#4796e3', state: 'stopped' },
  { name: 'shell-1', cli: 'shell', tint: '#8aa0ad', state: 'stopped' },
];

function MockRow({ s, nested }: { s: MockSession; nested?: boolean }) {
  return (
    <div className={`row session${nested ? ' nested' : ''}`}>
      <StateLogo cli={s.cli} state={s.state} size={12} tint={s.tint} />
      <span className="name">{s.name}</span>
    </div>
  );
}

function MockSidebar() {
  return (
    <aside className="sidebar mock-side" aria-hidden="true">
      <div className="brand">
        <div className="logo"><AmMark className="am-mark" /><h1>Agent Manager</h1></div>
        <div className="brand-actions">
          <span className="icon-btn add-btn"><PlusGlyph /></span>
          <span className="icon-btn"><SlidersGlyph /></span>
          <span className="icon-btn"><SunGlyph /></span>
        </div>
      </div>
      <div className="ov-fixed">
        <div className="row ov-row">
          <span className="ov-tile"><GridGlyph /></span>
          <span className="name">overview</span>
        </div>
      </div>
      <div className="tree">
        {MOCK.map((item) => 'group' in item ? (
          <div key={item.group} className="group">
            <div className="row group-head">
              <span className="caret">▾</span>
              <span className="name">{item.group}</span>
              <span className="count">{item.members.length}</span>
            </div>
            {item.members.map((m) => <MockRow key={m.name} s={m} nested />)}
          </div>
        ) : (
          <MockRow key={item.name} s={item} />
        ))}
      </div>
      <div className="quick-add">
        <span className="btn-ghost"><Logo cli="shell" size={14} /> Shell</span>
        <span className="btn-ghost"><Logo cli="files" size={14} /> Files</span>
      </div>
      <div className="legend">
        <span><StateLogo frameOnly state="working" size={12} /> working</span>
        <span><StateLogo frameOnly state="waiting" size={12} /> your turn</span>
        <span><StateLogo frameOnly state="idle" size={12} /> idle</span>
        <span><StateLogo frameOnly state="stopped" size={12} /> stopped</span>
      </div>
    </aside>
  );
}

// Shown when the server locks itself: either the Space is public (visitors get
// the install guide) or the owner's bucket is public (they get a warning — a
// public bucket exposes everything the agents saved, credentials included).
export default function Locked({ spaceId, reason, bucket }: {
  spaceId?: string | null;
  reason?: string | null;
  bucket?: string | null;
}) {
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
  const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
  // The Locked page is shown to embedded (HF App-tab) visitors, where the async
  // Clipboard API is blocked — fall back to execCommand within the click gesture.
  const legacyCopy = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = cmd; ta.style.position = 'fixed'; ta.style.top = '-9999px';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  };
  const copy = () => {
    if (legacyCopy()) { flash(); return; }
    navigator.clipboard?.writeText(cmd).then(flash).catch(() => {});
  };

  if (reason === 'public-bucket') {
    return (
      <div className="app locked-app">
        <MockSidebar />
        <div className="main locked-main">
          <div className="install">
            <h1>Your storage bucket is public</h1>
            <p className="locked-lead">
              The bucket mounted at <span className="mono">/data</span>
              {bucket ? <> (<span className="mono">{bucket}</span>)</> : null} is <b>public</b> —
              everything your agents saved is readable by anyone, including credentials and
              shell history. The terminals stay disabled until it's private.
            </p>
            <div className="step">
              <div className="step-head"><span className="step-n mono">!</span><h3>Make the bucket private</h3></div>
              <p className="locked-sub">
                Open <b>{bucket ? <a href={`https://huggingface.co/buckets/${bucket}/settings`} target="_blank" rel="noreferrer">the bucket's settings</a> : 'the bucket’s settings on Hugging Face'}</b> and
                switch its visibility to <b>Private</b>. This page unlocks automatically within a minute —
                and consider rotating any credentials that were stored while it was public.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app locked-app">
      <MockSidebar />
      <div className="main locked-main">
        <div className="install">
          <div>
            <h1>Set up the Agent Manager in two steps</h1>
            <p className="locked-lead">
              A private cloud workspace for Claude Code, Codex, Gemini CLI and friends —
              dispatch agents from anywhere, they keep working when you close the tab.
            </p>
          </div>
          <p className="locked-sub">
            This copy is <b>public</b>, so its terminals are disabled: the app has no login of its
            own — a public instance would hand anyone a shell. Your duplicate stays private and unlocks itself.
          </p>
          <p className="locked-sub install-relock">
            <b>Is this your Space?</b> Set it back to <b>Private</b> in Settings → Change visibility —
            it unlocks automatically within a minute.
          </p>

          <div className="step">
            <div className="step-head"><span className="step-n mono">1</span><h3>Duplicate this Space</h3></div>
            <p className="locked-sub">
              Open the <b>⋮ menu</b> at the top of this page and choose <b>Duplicate this Space</b>.
              Set the new Space's visibility to <b>Private</b>.
            </p>
            <img src="/install/duplicate-space.png" alt="The Space's ⋮ menu with 'Duplicate this Space' highlighted" />
          </div>

          <div className="step">
            <div className="step-head"><span className="step-n mono">2</span><h3>Attach a private bucket</h3></div>
            <p className="locked-sub">
              In your new Space: <b>Settings → Storage → Mount a bucket</b>. Create a new bucket,
              keep it <b>Private</b>, set the mount path to <span className="mono">/data</span> and
              access to <b>Read &amp; Write</b>. The Space restarts — and that bucket is where your
              agents' work, logins and history survive rebuilds and sleep.
            </p>
            <img src="/install/mount-bucket.png" alt="The Mount a bucket dialog: private bucket, mount path /data, read & write" />
            <p className="install-done">That's it — the Space restarts, unlocks itself, and you're ready to go. Open it and spawn your first agent.</p>
          </div>

          <details className="install-code step">
            <summary className="step-head">
              <span className="step-n mono">&gt;_</span>
              <h3>Prefer code? Both steps in one script</h3>
              <svg className="install-code-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.8 3.2h6.4L5 7.4z" fill="currentColor" /></svg>
            </summary>
            <div className="locked-cmd">
              <pre><code>{cmd}</code></pre>
              <button className="locked-copy" onClick={copy} aria-label="Copy setup code" title={copied ? 'Copied' : 'Copy'}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="9" y="8" width="10" height="12" rx="2" />
                  <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
