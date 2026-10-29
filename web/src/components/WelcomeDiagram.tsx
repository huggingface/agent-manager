import { AmMark } from './icons';

// How it all connects: harnesses -> your Space (with its bucket) -> browser ->
// your devices. Theme-aware via the app's CSS tokens; hidden on narrow screens
// (see .welcome-diagram media query) where the labels would be too small.
const HARNESSES: [name: string, logo: string, color: string, y: number, inv: string][] = [
  ['Claude Code', 'claude.png', '#d97757', 36, ''],
  ['Codex', 'codex.png', '#5eb6a6', 68, ''],
  ['opencode', 'opencode.png', '#b9c2cc', 100, 'wd-inv-dark'],
  ['Hermes', 'hermes.png', '#a78bfa', 132, 'wd-inv-light'],
  ['OpenClaw', 'openclaw.png', '#e05a4e', 164, ''],
  ['fx', 'fx.png', '#626262', 196, 'wd-inv-dark'],
];

export default function WelcomeDiagram() {
  return (
    <div className="welcome-diagram" aria-hidden="true">
      <svg viewBox="0 0 640 264" role="img">
        <text className="wd-zone" x="116" y="12" textAnchor="middle">Agents</text>
        <text className="wd-zone" x="320" y="12" textAnchor="middle">Your Space</text>
        <text className="wd-zone" x="568" y="12" textAnchor="middle">You</text>

        {/* nested rounded routing, outer wires innermost so nothing crosses.
            The harnesses sit symmetrically around the hub's centre line, so
            the elbows pair up above and below it. */}
        <path className="wd-link" d="M172 48 H238 Q244 48 244 54 V104 Q244 110 250 110 H268" />
        <path className="wd-link" d="M172 80 H230 Q236 80 236 86 V111 Q236 117 242 117 H268" />
        <path className="wd-link" d="M172 112 H222 Q228 112 228 118 V118 Q228 124 234 124 H268" />
        <path className="wd-link" d="M172 144 H222 Q228 144 228 138 V138 Q228 132 234 132 H268" />
        <path className="wd-link" d="M172 176 H230 Q236 176 236 170 V145 Q236 139 242 139 H268" />
        <path className="wd-link" d="M172 208 H238 Q244 208 244 202 V152 Q244 146 250 146 H268" />
        <path className="wd-link" d="M372 128 H428" />
        <path className="wd-link" d="M514 128 H528 Q534 128 534 120 V84 Q534 76 540 76 H542" />
        <path className="wd-link" d="M514 128 H528 Q534 128 534 136 V185 Q534 191 540 191 H554" />
        <path className="wd-link" d="M320 160 V172" />

        {/* harness nodes: brand-tinted pill sized to the label + brand logo cap */}
        {HARNESSES.map(([name, logo, c, y, inv]) => (
          <g key={name} transform={`translate(60,${y})`}>
            <rect width="112" height="24" rx="6" style={{ fill: `color-mix(in srgb, ${c} 11%, var(--panel-2))`, stroke: `color-mix(in srgb, ${c} 40%, var(--border))` }} />
            <rect x="3" y="3" width="18" height="18" rx="5" style={{ fill: `color-mix(in srgb, ${c} 26%, var(--panel-2))` }} />
            <image className={inv} href={`/logos/${logo}`} x="6" y="6" width="12" height="12" />
            <text className="wd-hlbl" x="28" y="16">{name}</text>
          </g>
        ))}

        {/* hub: AM = the Space */}
        <text className="wd-lbl" x="320" y="88" textAnchor="middle">Agent Manager</text>
        <rect className="wd-hub" x="268" y="96" width="104" height="64" rx="11" />
        <svg x="302" y="112" width="36" height="30" viewBox="0 0 28 24"><AmMark className="wd-am" /></svg>

        {/* bucket */}
        <g transform="translate(268,164)">
          <path className="wd-node" d="M0 8 V44 A52 8 0 0 0 104 44 V8" />
          <ellipse className="wd-node" cx="52" cy="8" rx="52" ry="8" />
          <text className="wd-lbl" x="52" y="30" textAnchor="middle">Private bucket</text>
          <text className="wd-lbl-sm" x="52" y="45" textAnchor="middle">state persists</text>
        </g>

        {/* browser */}
        <g transform="translate(428,100)">
          <rect className="wd-node" width="86" height="56" rx="7" />
          <rect className="wd-screen" x="9" y="24" width="68" height="22" rx="2" />
          <circle cx="15" cy="12" r="1.5" className="wd-glyph" /><circle cx="20" cy="12" r="1.5" className="wd-glyph" /><circle cx="25" cy="12" r="1.5" className="wd-glyph" />
          <text className="wd-lbl-sm" x="43" y="68" textAnchor="middle">Browser</text>
        </g>

        {/* desktop */}
        <g transform="translate(542,58)">
          <rect className="wd-node" width="56" height="36" rx="4" />
          <rect className="wd-screen" x="6" y="6" width="44" height="20" rx="2" />
          <path className="wd-dev" d="M28 36 V42 M20 43 H36" />
          <text className="wd-lbl-sm" x="28" y="-7" textAnchor="middle">Desktop</text>
        </g>
        {/* phone */}
        <g transform="translate(554,168)">
          <rect className="wd-node" width="26" height="46" rx="6" />
          <rect className="wd-screen" x="4" y="7" width="18" height="30" rx="2" />
          <circle cx="13" cy="41" r="1.4" className="wd-glyph" />
          <text className="wd-lbl-sm" x="13" y="-7" textAnchor="middle">Phone</text>
        </g>
      </svg>
    </div>
  );
}
