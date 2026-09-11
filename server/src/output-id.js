// Which reply is this?
//
// The Overview's unread section has to ask "has the operator seen THIS answer?"
// rather than "is there something newer than a timestamp?", so every surface
// that produces human-facing assistant output names it the same way: a sequence
// number and a hash of the full text.
//
// Both halves are load-bearing. The sequence separates two replies with
// identical text, or the same timestamp — only a counter can. The hash catches
// a streaming answer that grew, including past the 280-character card clip,
// where the visible summary would look unchanged although the operator has been
// shown something new.
//
// Deliberately NOT the trace file's revision, which also moves for tool calls,
// token counts and status records — none of which are anything to read.

/**
 * Cheap and stable rather than cryptographic: this only has to separate one
 * reply from the next within a single transcript. FNV-1a, with the length
 * appended because a truncated-versus-extended streaming answer is exactly the
 * pair most likely to collide in a 32-bit space.
 */
export function outputHash(text) {
  const t = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}${t.length.toString(36)}`;
}

/**
 * The generation of a session's transcript: which file/thread the output is
 * coming from. It changes when a session's trace is replaced — codex repins
 * `codexRollout` on a new run — and an acknowledgement carrying the old
 * generation must not be read as covering the new one's output.
 */
export function sourceKey(session) {
  if (!session) return '';
  const parts = [
    session.remote?.name ? `r:${session.remote.name}` : '',
    session.sessionUuid || '',
    session.codexRollout || '',
    session.opencodeSessionId || '',
  ].filter(Boolean);
  return parts.length ? outputHash(parts.join('|')) : '';
}
