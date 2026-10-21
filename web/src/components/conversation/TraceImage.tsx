import { useState } from 'react';

/**
 * An image from a transcript. The conversation names it (`src` points at the
 * trace image route) rather than carrying its bytes, so it is fetched when it
 * is about to be seen — and when the server knew its size, the box it will
 * fill is laid out before then, so nothing below it jumps as it arrives.
 * `--img-max-h` (set by the caller's class) bounds the height. An inline
 * data-URL `src` from an older server renders the same way.
 */
export default function TraceImage({ s: { src, width: w, height: h }, className = 'cs-img' }: {
  /** The image step or block, passed whole: spreading it would hand React its `ref`. */
  s: { src?: string; width?: number; height?: number }; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className={`trace-img-missing mono ${className}`}>image unavailable</span>;
  const sized = !!w && !!h;
  return (
    <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}
      {...(sized ? { width: w, height: h, style: { aspectRatio: `${w}/${h}`, height: 'auto', width: `min(100%,${w}px,calc(var(--img-max-h)*${w! / h!}))` } } : {})} />
  );
}
