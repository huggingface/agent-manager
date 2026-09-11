// Keyboard navigation for the Files listing.
//
// The listing is a tree drawn as a flat run of rows: an expanded folder's
// children are siblings in the DOM, indented by rails rather than nested in it.
// So "the row above" is a question about the rendered order, not about the
// component tree, and every answer here is computed from the rows that are
// actually on screen — collapsed children are not in that list at all, which is
// what keeps a hidden row from being a keyboard destination.
//
// THE KEY CONTRACT (W3C tree-view pattern, trimmed to what this listing has):
//
//   ↑ / ↓        previous / next visible row
//   →            collapsed folder: expand · expanded folder: first child · file: nothing
//   ←            expanded folder: collapse · otherwise: the parent row
//   Home / End   first / last visible row
//   Enter        file: preview it · folder: open it as the listing root
//
// Enter is the only key here that acts on a file, and none of them commits a
// file operation: moving the focus is not choosing anything. The pane adds two
// state-dependent keys of its own (Enter picks a destination while a move is
// armed, Escape cancels), because those depend on what the pane is doing.

/** One row as it is drawn: what the pane knows about it after rendering. */
export interface TreeRow {
  path: string;
  dir: boolean;
  /** Folders only: is it showing its children right now? */
  open: boolean;
}

export type TreeIntent =
  | { kind: 'focus'; path: string }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'activate'; path: string; dir: boolean };

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * What a key means, given the rows on screen and which one has the focus.
 *
 * Returns null for a key this tree does not claim, so the caller can leave it
 * alone — Tab has to keep working, and a key that does nothing here must not be
 * swallowed on the way to something that would have used it.
 */
export function keyIntent(rows: TreeRow[], current: string | null, key: string): TreeIntent | null {
  if (!rows.length) return null;
  const i = rows.findIndex((r) => r.path === current);
  const row = i >= 0 ? rows[i] : null;
  const at = (n: number) => ({ kind: 'focus', path: rows[Math.max(0, Math.min(rows.length - 1, n))].path } as const);

  switch (key) {
    case 'ArrowDown': return i < 0 ? at(0) : at(i + 1);
    case 'ArrowUp': return i < 0 ? at(rows.length - 1) : at(i - 1);
    case 'Home': return at(0);
    case 'End': return at(rows.length - 1);
    case 'ArrowRight': {
      if (!row?.dir) return null;
      if (!row.open) return { kind: 'expand', path: row.path };
      // An expanded folder's first child is the row after it — it cannot be
      // anything else, since children are drawn immediately below their folder.
      const child = rows[i + 1];
      return child && child.path.startsWith(`${row.path}/`) ? { kind: 'focus', path: child.path } : null;
    }
    case 'ArrowLeft': {
      if (!row) return null;
      if (row.dir && row.open) return { kind: 'collapse', path: row.path };
      const parent = parentOf(row.path);
      const up = rows.find((r) => r.path === parent);
      return up ? { kind: 'focus', path: up.path } : null;
    }
    case 'Enter': return row ? { kind: 'activate', path: row.path, dir: row.dir } : null;
    default: return null;
  }
}

/**
 * Where the focus goes when the row that had it is no longer drawn — renamed,
 * deleted, moved away, collapsed out of sight, or dropped by a refresh.
 *
 * In order: the next thing in the same folder, then the previous one, then the
 * folder itself, then whatever else was nearby, then the top of the listing.
 * Same folder first because that is what "it was here a second ago" means to the
 * person looking; the folder next because when a whole folder's worth of rows
 * goes at once — someone collapsed it — the folder is what is left of where you
 * were. Everything is decided from PATHS, never an index into the new list: a
 * re-sort renumbers every row and would silently hand the focus to a stranger.
 */
export function survivingFocus(before: string[], after: string[], gone: string): string | null {
  if (after.includes(gone)) return gone;
  const alive = new Set(after);
  const i = before.indexOf(gone);
  const home = parentOf(gone);
  const scan = (test: (p: string) => boolean) => {
    for (let n = i + 1; n < before.length; n++) if (alive.has(before[n]) && test(before[n])) return before[n];
    for (let n = i - 1; n >= 0; n--) if (alive.has(before[n]) && test(before[n])) return before[n];
    return null;
  };
  if (i >= 0) {
    const sibling = scan((p) => parentOf(p) === home);
    if (sibling) return sibling;
  }
  for (let p = home; p; p = parentOf(p)) if (alive.has(p)) return p;
  if (i >= 0) {
    const near = scan(() => true);
    if (near) return near;
  }
  return after[0] ?? null;
}

/**
 * Scroll the focused row into view inside the listing, and nowhere else.
 *
 * `scrollIntoView` walks up and scrolls every scrollable ancestor it finds,
 * which in a tiled app means the pane can drag the page around under the other
 * panes. This moves one box's scrollTop by the amount the row overhangs it.
 */
export function keepInView(row: HTMLElement, box: HTMLElement) {
  const r = row.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}
