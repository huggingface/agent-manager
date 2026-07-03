import { useState } from 'react';
import { LockGlyph, SlidersGlyph, SunGlyph, PulseGlyph } from './icons';
import Logo from './Logo';

// A frozen, slightly dimmed replica of the real sidebar so the install page
// looks like the product it unlocks. Pure decoration: no handlers, no state.
type MockSession = { name: string; cli: string; tint: string; state: string };
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
      <span className={`status ${s.state}`} />
      <span className="name">{s.name}</span>
      <Logo cli={s.cli} size={11} tint={s.tint} />
    </div>
  );
}

function MockSidebar() {
  return (
    <aside className="sidebar mock-side" aria-hidden="true">
      <div className="brand">
        <div className="logo"><span className="dot agg-working" /><h1>Agent Manager</h1></div>
        <div className="brand-actions">
          <span className="icon-btn"><SlidersGlyph /></span>
          <span className="icon-btn"><SunGlyph /></span>
        </div>
      </div>
      <div className="controls">
        <div className="add-row">
          <span className="btn-ghost">+ Agent</span>
          <span className="btn-ghost">+ Group</span>
        </div>
      </div>
      <div className="ov-fixed">
        <div className="row ov-row"><PulseGlyph className="ov-row-ico" /><span className="name">Overview</span></div>
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
        <span><span className="status working" /> working</span>
        <span><span className="status waiting" /> your turn</span>
        <span><span className="status idle" /> idle</span>
        <span><span className="status stopped" /> stopped</span>
      </div>
    </aside>
  );
}

// Shown when the server reports the Space is public: the terminal backend is
// disabled server-side and this page explains how to run a private copy.
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
    <div className="app locked-app">
      <MockSidebar />
      <div className="main locked-main">
        <div className="install">
          <div className="install-head">
            <span className="install-lock"><LockGlyph /></span>
            <div>
              <h1>Your own Agent Manager, in two steps</h1>
              <p className="locked-lead">
                A private cloud workspace for Claude Code, Codex, Gemini CLI and friends —
                dispatch agents from anywhere, they keep working when you close the tab.
              </p>
            </div>
          </div>
          <p className="locked-sub">
            This copy is <b>public</b>, so its terminals are disabled: the app has no login of its
            own — a public instance would hand anyone a shell. Your duplicate stays private and unlocks itself.
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
          </div>

          <details className="install-code">
            <summary>Prefer code? Duplicate + bucket in one script</summary>
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

          <p className="locked-sub install-relock">
            <b>Is this your Space?</b> Set it back to <b>Private</b> in Settings → Change visibility —
            it unlocks automatically within a minute.
          </p>
        </div>
      </div>
    </div>
  );
}
