import StateLogo from './StateLogo';

/**
 * The sidebar's frame vocabulary (lib/rowMark.ts). Shared with the locked
 * page's mock sidebar so the two can't drift. Only the three frames get a
 * swatch: a bare logo (running, read) and a faded row (not running) speak for
 * themselves, and the row's hover text names them.
 */
export default function RowMarkLegend() {
  return (
    <div className="legend">
      <span><StateLogo frameOnly state="working" size={12} /> working</span>
      <span><StateLogo frameOnly state="blocked" size={12} /> needs input</span>
      <span><StateLogo frameOnly state="unread" size={12} /> unread</span>
    </div>
  );
}
