import type { RowStatus as Status, RowStatusKind } from '../lib/rowStatus';
import { LEGEND } from '../lib/rowStatus';

/**
 * The sidebar's status column (#242). Always rendered, so every row keeps the
 * same column width and the marks line up; a stopped row or a panel simply has
 * nothing in it. The glyphs are CSS (`.row-status.rs-*` in styles.css): the
 * spinner is the shared `ov-spin` braille, and the dots are boxes so `●` and
 * `○` come out the same size whatever the font.
 */
export default function RowStatus({ status }: { status: Status }) {
  const { kind, label } = status;
  return label
    ? <span className={`row-status rs-${kind}`} role="img" aria-label={label} title={label} />
    : <span className={`row-status rs-${kind}`} aria-hidden="true" />;
}

/**
 * What the marks mean. Shared by the real sidebar and the locked page's mock
 * so the two cannot drift. The legend's spinner holds still: it explains the
 * mark, it is not an agent at work.
 */
export function StatusLegend() {
  const mark = (kind: RowStatusKind) => <span className={`row-status rs-${kind}`} aria-hidden="true" />;
  return (
    <div className="legend status-legend">
      {LEGEND.map(({ kind, label }) => <span key={kind}>{mark(kind)} {label}</span>)}
      <span className="lg-stopped">{mark('stopped')} stopped</span>
    </div>
  );
}
