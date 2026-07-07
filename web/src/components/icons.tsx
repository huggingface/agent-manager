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

export const PlusGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </G>
);

// The AM monogram: rectangular A (two verticals, top bar, crossbar) and
// M (three verticals joined at the top). One 4-unit stroke, 4-unit counters.
export const AmMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 38 24" fill="currentColor" aria-label="Agent Manager">
    <path fillRule="evenodd" d="M0 0H12V24H8V14H4V24H0ZM4 4H8V10H4Z" />
    <path d="M18 0H38V24H34V4H30V24H26V4H22V24H18Z" />
  </svg>
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
