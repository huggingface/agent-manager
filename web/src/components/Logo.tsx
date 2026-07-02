import { FolderGlyph } from './icons';

// Black logos invert on the dark theme; white logos invert on the light theme.
const INVERT_DARK = new Set(['shell', 'opencode']);
const INVERT_LIGHT = new Set(['hermes']);

export default function Logo({ cli, size = 18, tint }: { cli: string; size?: number; tint?: string }) {
  // `tint` (the CLI's brand color) wraps the glyph in a softly tinted tile so
  // rows/panes read as "Claude / Codex / Gemini" at a glance. `size` stays the
  // glyph size; the tile adds its own padding around it.
  const tile = tint
    ? { padding: Math.max(3, Math.round(size * 0.18)), background: `color-mix(in srgb, ${tint} 13%, transparent)`, borderRadius: Math.max(4, Math.round(size * 0.28)) }
    : undefined;

  // Files uses the same minimal folder glyph as the file tree.
  if (cli === 'files') {
    return (
      <span className="cli-logo files-glyph" style={{ width: size, height: size, boxSizing: 'content-box', ...tile }}>
        <FolderGlyph />
      </span>
    );
  }
  const cls = INVERT_DARK.has(cli) ? ' inv-dark' : INVERT_LIGHT.has(cli) ? ' inv-light' : '';
  return (
    <span className={`cli-logo${cls}`} style={{ width: size, height: size, boxSizing: 'content-box', ...tile }}>
      <img
        src={`/logos/${cli}.png`}
        alt={cli}
        draggable={false}
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/logos/shell.png'; }}
      />
    </span>
  );
}
