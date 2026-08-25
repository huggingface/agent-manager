import { FolderGlyph, ListGlyph, RemoteGlyph } from './icons';

// Black logos invert on the dark theme; white logos invert on the light theme.
const INVERT_DARK = new Set(['shell', 'opencode', 'fx']);
const INVERT_LIGHT = new Set(['hermes']);

// A state frame must follow the tile exactly, so expose the two pieces of tile
// geometry rather than making that component repeat Logo's sizing arithmetic.
export const logoTilePadding = (size: number, tint?: string) =>
  tint ? Math.max(3, Math.round(size * 0.18)) : 0;
export const logoTileRadius = (size: number) => Math.max(4, Math.round(size * 0.28));

export default function Logo({ cli, size = 18, tint }: { cli: string; size?: number; tint?: string }) {
  // `tint` (the CLI's brand color) wraps the glyph in a softly tinted tile so
  // rows/panes read as "Claude / Codex / Gemini" at a glance. `size` stays the
  // glyph size; the tile adds its own padding around it.
  const tile = tint
    ? { padding: logoTilePadding(size, tint), background: `color-mix(in srgb, ${tint} 13%, transparent)`, borderRadius: logoTileRadius(size) }
    : undefined;

  // Files uses the same minimal folder glyph as the file tree.
  if (cli === 'files') {
    return (
      <span className="cli-logo files-glyph" style={{ width: size, height: size, boxSizing: 'content-box', ...tile }}>
        <FolderGlyph />
      </span>
    );
  }
  // Trace is a panel, not a vendor — a glyph, not a logo. (Without this it would
  // request /logos/trace.png and land on the shell fallback.)
  if (cli === 'trace') {
    return (
      <span className="cli-logo files-glyph" style={{ width: size, height: size, boxSizing: 'content-box', ...tile }}>
        <ListGlyph />
      </span>
    );
  }
  // A remote agent is a place, not a vendor — the harness it happens to run
  // (claude, codex, …) is shown as text in the pane header instead.
  if (cli === 'remote') {
    return (
      <span className="cli-logo files-glyph" style={{ width: size, height: size, boxSizing: 'content-box', ...tile }}>
        <RemoteGlyph />
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
