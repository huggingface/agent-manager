import { useEffect, useRef, useState } from 'react';
import type { GridSpec } from '../types';

// Miniature preview of a cols×rows grid, drawn as filled cells.
export function GridIcon({ cols, rows }: GridSpec) {
  const w = 12 / cols;
  const h = 12 / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(<rect key={`${r}-${c}`} x={2 + c * w + 0.5} y={2 + r * h + 0.5} width={w - 1} height={h - 1} rx={1} />);
    }
  }
  return <svg viewBox="0 0 16 16" className="lp-ico" fill="currentColor">{cells}</svg>;
}

/**
 * Pane-arrangement picker for a group: the button shows the current grid,
 * clicking reveals the nine cols×rows presets plus Auto (grow with agents).
 */
export default function LayoutPicker({ grid, isAuto, onPick }: {
  grid: GridSpec;
  isAuto: boolean;
  onPick: (l: GridSpec | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="lp" ref={ref}>
      <button className="zbtn lp-btn" title="Arrange panes" onClick={() => setOpen((o) => !o)}>
        <GridIcon cols={grid.cols} rows={grid.rows} />
        <span className="lp-lbl mono">{grid.cols}×{grid.rows}{isAuto ? ' auto' : ''}</span>
      </button>
      {open && (
        <div className="lp-pop">
          <button className={`lp-auto${isAuto ? ' on' : ''}`} onClick={() => { onPick(null); setOpen(false); }}>
            Auto — grow with agents
          </button>
          <div className="lp-grid">
            {[1, 2, 3].flatMap((rows) => [1, 2, 3].map((cols) => (
              <button
                key={`${cols}x${rows}`}
                className={`lp-opt${!isAuto && grid.cols === cols && grid.rows === rows ? ' on' : ''}`}
                title={`${cols}×${rows}`}
                onClick={() => { onPick({ cols, rows }); setOpen(false); }}
              >
                <GridIcon cols={cols} rows={rows} />
              </button>
            )))}
          </div>
        </div>
      )}
    </div>
  );
}
