// Shared minimal stroke glyphs (inherit currentColor, scale to their box).
export const FolderGlyph = ({ className, open = false }: { className?: string; open?: boolean }) => (open ? (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round">
    <path d="M2 12.25V4.25a1 1 0 0 1 1-1h2.85a1 1 0 0 1 .7.3l.9.9h4.9a1 1 0 0 1 1 1v1.1" />
    <path d="M2 12.4l1.7-4.05a1 1 0 0 1 .92-.6h9.36a1 1 0 0 1 .94 1.35l-1.3 3.5a1 1 0 0 1-.94.65H3a1 1 0 0 1-1-1z" />
  </svg>
) : (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.3l.9.9h5.1a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </svg>
));

export const FileGlyph = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
    <path d="M4 1.75h5L12.25 5v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" />
    <path d="M8.75 1.9V5.25h3.35" />
  </svg>
);
