// ASCII-tree rails: one cell per ancestor (a vertical line if that ancestor has
// more siblings below) plus the elbow cell for this row — `├` normally, `└` for
// the last child. `prefix[i]` = "draw a continuation line at ancestor column i".
//
// Lifted out of FilesPane so the reader's sub-agent strip can draw the same
// tree the file browser does, from the same six lines of CSS (`.rails`/`.rail`
// in styles.css). The rows differ completely; the rails do not.
export function Rails({ prefix, isLast }: { prefix: boolean[]; isLast: boolean }) {
  return (
    <span className="rails" aria-hidden>
      {prefix.map((cont, i) => <span key={i} className={`rail${cont ? ' v' : ''}`} />)}
      <span className={`rail elbow${isLast ? ' last' : ''}`} />
    </span>
  );
}

/** The room those cells need: the rails are absolute, so the row pays for them. */
export const railPad = (prefix: boolean[]) => ({ paddingLeft: `${(prefix.length + 1) * 1.1}em` });
