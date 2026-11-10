import StateLogo from './StateLogo';

/**
 * The sidebar's frame vocabulary (lib/rowMark.ts). Shared with the locked
 * page's mock sidebar so the two can't drift. A running agent with nothing new
 * is a bare logo, so it has no swatch; "idle" is the faded tile a row that is
 * not running shows.
 */
export default function RowMarkLegend() {
  return (
    <div className="legend">
      <span><StateLogo frameOnly state="working" size={12} /> working</span>
      <span><StateLogo frameOnly state="blocked" size={12} /> needs input</span>
      <span><StateLogo frameOnly state="unread" size={12} /> unread</span>
      <span><StateLogo frameOnly state="off" size={12} /> idle</span>
    </div>
  );
}
