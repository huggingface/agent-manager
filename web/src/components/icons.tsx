import type { ReactNode } from 'react';

// Shared minimal stroke glyphs (inherit currentColor, scale to their box).
// One pen for the whole UI: 16px grid, 1.2 stroke, round joins.
const G = ({ className, children }: { className?: string; children: ReactNode }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round">
    {children}
  </svg>
);

export const FolderGlyph = ({ className, open = false }: { className?: string; open?: boolean }) => (open ? (
  <G className={className}>
    <path d="M2 12.25V4.25a1 1 0 0 1 1-1h2.85a1 1 0 0 1 .7.3l.9.9h4.9a1 1 0 0 1 1 1v1.1" />
    <path d="M2 12.4l1.7-4.05a1 1 0 0 1 .92-.6h9.36a1 1 0 0 1 .94 1.35l-1.3 3.5a1 1 0 0 1-.94.65H3a1 1 0 0 1-1-1z" />
  </G>
) : (
  <G className={className}>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.3l.9.9h5.1a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </G>
));

export const FileGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M4 1.75h5L12.25 5v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" />
    <path d="M8.75 1.9V5.25h3.35" />
  </G>
);

export const SlidersGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    <circle cx="10" cy="4.5" r="1.5" fill="var(--panel, #fff)" />
    <circle cx="6" cy="8" r="1.5" fill="var(--panel, #fff)" />
    <circle cx="11" cy="11.5" r="1.5" fill="var(--panel, #fff)" />
  </G>
);

export const ListGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M5.6 4.2h8.2M5.6 8h8.2M5.6 11.8h8.2" />
    <circle cx="2.6" cy="4.2" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="2.6" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="2.6" cy="11.8" r="0.9" fill="currentColor" stroke="none" />
  </G>
);

// A remote agent: `> <` facing each other inside a circle — the machine-to-machine
// connection sign, not a vendor logo. The gap is the point: two ends reaching
// toward each other across a distance.
export const RemoteGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    {/* Thin ring, bold chevrons: at 16px the ring plus fine inner detail muddles
        into a circled X, so the enclosure recedes and the `><` carries the mark. */}
    <circle cx="8" cy="8" r="7.1" strokeWidth="1" />
    <path d="M5.1 5.9 6.7 8 5.1 10.1M10.9 5.9 9.3 8l1.6 2.1" strokeWidth="1.7" strokeLinejoin="round" />
  </G>
);

// The "the agent has this" tick. Its own glyph rather than a text ✓ so it can be
// sized and coloured deliberately (accent, via currentColor).
export const AckGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    {/* Heavier than the 1.2 house stroke: this is a small mark that has to read
        at a glance next to a line of text. Set on the path, since G fixes the
        stroke width for every other glyph. */}
    <path d="M3.2 8.6 6.4 11.8 12.8 4.6" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
  </G>
);

export const BoltGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M8.9 1.6 3.9 8.9h3.2l-1 5.5 5-7.3H7.9l1-5.5z" strokeLinejoin="round" />
  </G>
);

export const SunGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.14 1.14M11.46 11.46l1.14 1.14M12.6 3.4l-1.14 1.14M4.54 11.46L3.4 12.6" />
  </G>
);

export const MoonGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M13.2 9.6A5.6 5.6 0 1 1 6.4 2.8a4.4 4.4 0 0 0 6.8 6.8z" />
  </G>
);

export const TrashGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M3 4.5h10M6.4 4.4v-1a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1" />
    <path d="M4.4 4.6l.55 8a1 1 0 0 0 1 .93h4.1a1 1 0 0 0 1-.93l.55-8M6.7 7.2v3.8M9.3 7.2v3.8" />
  </G>
);

export const PencilGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9zM9.7 4.1l2.2 2.2" />
  </G>
);

export const CloseGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
  </G>
);

export const PlayGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M5.6 3.9v8.2L12.4 8z" />
  </G>
);

export const StopGlyph = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" fill="currentColor">
    <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" />
  </svg>
);

export const UploadGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M8 10V3.3M5.1 6L8 3.2 10.9 6M3 10.7v1.8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.8" />
  </G>
);

export const UpGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M8 12.8V3.4M4.4 7L8 3.4 11.6 7" />
  </G>
);

export const RefreshGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M13.2 8A5.2 5.2 0 1 1 11 3.8" />
    <path d="M11.2 1.6l.3 2.5 2.5-.3" />
  </G>
);

export const PulseGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M1.5 8.2h2.8l1.6-4.4 3.4 8.4 1.7-4h3.5" />
  </G>
);

// Overview: four panes at a glance — what the page literally is.
export const GridGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <rect x="2.2" y="2.2" width="4.8" height="4.8" rx="0.8" fill="currentColor" />
    <rect x="9" y="2.2" width="4.8" height="4.8" rx="0.8" />
    <rect x="2.2" y="9" width="4.8" height="4.8" rx="0.8" />
    <rect x="9" y="9" width="4.8" height="4.8" rx="0.8" fill="currentColor" />
  </G>
);

export const PlusGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </G>
);

// The AM ligature: rectangular A and M sharing their middle stroke under one
// continuous roof. One 4-unit stroke, 4-unit counters.
export const AmMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 28 24" fill="currentColor" aria-label="Agent Manager">
    <path fillRule="evenodd" d="M0 0H28V24H24V4H20V24H16V4H12V24H8V14H4V24H0ZM4 4H8V10H4Z" />
  </svg>
);

export const KeyGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <circle cx="5.4" cy="5.4" r="2.9" />
    <path d="M7.5 7.5l5 5M11 11l1.4-1.4M9.4 9.4l1.4-1.4" />
  </G>
);

export const BellGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M4 11.2V7.2a4 4 0 0 1 8 0v4M2.8 11.2h10.4M6.6 13.4a1.6 1.6 0 0 0 2.8 0" />
  </G>
);

export const InfoGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.4v3.4" />
    <circle cx="8" cy="5.1" r="0.4" fill="currentColor" stroke="none" />
  </G>
);

export const LockGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M5.4 7V5.1a2.6 2.6 0 0 1 5.2 0V7" />
    <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.2" />
  </G>
);

export const ShareGlyph = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" /><line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
  </svg>
);

// A conversation branching into its next agent: used for trace handover.
export const HandoverGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M3 3.2v3.1A2.7 2.7 0 0 0 5.7 9h6.4" />
    <path d="M8.9 5.8 12.1 9l-3.2 3.2" />
  </G>
);
