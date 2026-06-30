import { FolderGlyph } from './icons';

// Black logos invert on the dark theme; white logos invert on the light theme.
const INVERT_DARK = new Set(['shell', 'opencode']);
const INVERT_LIGHT = new Set(['hermes']);

export default function Logo({ cli, size = 18 }: { cli: string; size?: number }) {
  // Files uses the same minimal folder glyph as the file tree.
  if (cli === 'files') {
    return (
      <span className="cli-logo files-glyph" style={{ width: size, height: size }}>
        <FolderGlyph />
      </span>
    );
  }
  const cls = INVERT_DARK.has(cli) ? ' inv-dark' : INVERT_LIGHT.has(cli) ? ' inv-light' : '';
  return (
    <span className={`cli-logo${cls}`} style={{ width: size, height: size }}>
      <img
        src={`/logos/${cli}.png`}
        alt={cli}
        draggable={false}
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/logos/shell.png'; }}
      />
    </span>
  );
}
