import type { SessionState } from '../types';
import Logo, { logoTilePadding, logoTileRadius } from './Logo';

/**
 * The CLI tile and the agent state are one mark. The 96-unit path is divided
 * into four exact 20 + 4 cells, so the working dash loop has no remainder (and
 * therefore no visible jump) at the rounded rectangle's origin.
 */
export default function StateLogo({
  cli, state, size = 18, tint, title,
}: {
  cli: string;
  state: SessionState;
  size?: number;
  tint?: string;
  title?: string;
}) {
  const padding = logoTilePadding(size, tint);
  const frameSize = size + padding * 2;

  return (
    <span
      className={`state-logo ${state}`}
      style={{ width: frameSize, height: frameSize }}
      title={title}
    >
      <Logo cli={cli} size={size} tint={tint} />
      <svg
        className="state-logo-frame"
        viewBox={`0 0 ${frameSize} ${frameSize}`}
        aria-hidden="true"
      >
        {state === 'working' && (
          <rect
            className="state-logo-track"
            x="0.5" y="0.5" width={frameSize - 1} height={frameSize - 1}
            rx={logoTileRadius(size)} pathLength="96"
          />
        )}
        <rect
          className={state === 'working' ? 'state-logo-run' : 'state-logo-static'}
          x="0.5" y="0.5" width={frameSize - 1} height={frameSize - 1}
          rx={logoTileRadius(size)} pathLength="96"
        />
      </svg>
    </span>
  );
}
