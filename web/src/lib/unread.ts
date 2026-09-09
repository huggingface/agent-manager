// Has the operator read this agent's latest reply?
//
// The whole feature is one comparison — the newest output the server has seen
// against the newest the operator has been shown — so the comparison lives in
// one place, in the open, rather than being spelled out slightly differently in
// the Overview, the reader and the bulk action.

export interface OutputVersion { src: string; seq: number; hash: string }
export interface ReadMark extends OutputVersion { at?: string }

/** What a session carries once /api/meta has answered for it. */
export interface Readable {
  id: string;
  output?: OutputVersion | null;
  read?: ReadMark | null;
}

/**
 * Unread means: there is human-facing output, and the mark does not describe
 * it.
 *
 * The three ways a mark can fail to describe it are all real cases, not
 * defensive padding:
 *
 *   no mark          — nothing has ever been read here. Note this is only
 *                      reachable for output that appeared AFTER the rollout
 *                      baseline; the baseline gave every existing reply a mark.
 *   older generation — the transcript was replaced (a new run repins it), so a
 *                      mark against the old file says nothing about this one.
 *                      A stale acknowledgement must never cover new output.
 *   behind, or the same position with different content — a streaming answer
 *                      that grew is something else to read, even at the same
 *                      sequence number.
 *
 * No output at all is NOT unread: an agent that has never spoken has nothing to
 * show. Missing metadata is likewise not unread — but it is not "read" either,
 * and nothing here writes a mark for it, so the first real reply still counts.
 */
export function isUnread(s: Readable): boolean {
  const o = s.output;
  if (!o || !o.seq) return false;
  const r = s.read;
  if (!r) return true;
  if (r.src !== o.src) return true;
  if (r.seq < o.seq) return true;
  return r.seq === o.seq && r.hash !== o.hash;
}

/**
 * Which of the three Overview blocks a session belongs in.
 *
 * A running agent stays in Running even when it has unread output: what it is
 * saying now is not finished, and moving it would take it out from under the
 * one block the operator watches while work is in flight. Its unread state is
 * untouched, so it lands in Unread as soon as it stops.
 */
export type Section = 'running' | 'unread' | 'rest';
export function sectionOf(s: Readable, running: boolean): Section {
  if (running) return 'running';
  return isUnread(s) ? 'unread' : 'rest';
}

/**
 * The acknowledgement a surface should send for what it just displayed.
 *
 * Deliberately the version the client already holds rather than "whatever is
 * newest on the server": the server rejects anything that no longer matches, so
 * a reply that arrived between rendering and acknowledging stays unread instead
 * of being swept up by a mark it was never part of.
 */
export function markFor(s: Readable): (OutputVersion & { id: string }) | null {
  const o = s.output;
  if (!o || !o.seq) return null;
  return { id: s.id, src: o.src, seq: o.seq, hash: o.hash };
}

/**
 * Of two marks for the same session, the one that has read further.
 *
 * The client holds two: what the last /api/meta said, and what it has
 * acknowledged since. A poll in flight during an acknowledgement carries the
 * older of the two, and taking it at face value would flash the card back to
 * unread and then forward again. Taking the further one cannot regress, and a
 * mark from a different generation is not comparable at all — the newer
 * generation wins, because the older one describes a transcript that is gone.
 */
export function furtherMark(a: ReadMark | null | undefined, b: ReadMark | null | undefined): ReadMark | null {
  if (!a) return b || null;
  if (!b) return a;
  if (a.src !== b.src) return b; // b is the one the caller just learned about
  if (b.seq > a.seq) return b;
  if (b.seq === a.seq && b.hash !== a.hash) return b;
  return a;
}

/**
 * Fold a server answer back into the local view.
 *
 * Only 'ok' advances anything. A rejection is an ordinary answer — the reply
 * that was displayed is no longer the newest — so the session stays unread and
 * the operator sees the thing they have not read, which is the truthful
 * outcome. Nothing here can move a mark backwards: the caller keeps whichever
 * of the two is further on.
 */
export function applyAck(
  prev: Record<string, ReadMark>,
  sent: (OutputVersion & { id: string })[],
  results: Record<string, string>,
): Record<string, ReadMark> {
  let changed = false;
  const next = { ...prev };
  for (const m of sent) {
    if (results[m.id] !== 'ok') continue;
    const cur = next[m.id];
    if (cur && cur.src === m.src && (cur.seq > m.seq || (cur.seq === m.seq && cur.hash === m.hash))) continue;
    next[m.id] = { src: m.src, seq: m.seq, hash: m.hash };
    changed = true;
  }
  return changed ? next : prev;
}
