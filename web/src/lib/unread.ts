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
  // Read means the mark names EXACTLY what is newest. Anything else is unread.
  //
  // The strictness earns its keep on the "mark is further along" case, which is
  // not the impossibility it looks like: a rotated or replaced transcript
  // restarts its sequence at 1, and a harness whose runs cannot be told apart
  // from the pane record alone — OpenClaw merges several session files into one
  // pane — will present that new reply under the same generation key. Reading
  // `mark.seq >= output.seq` as "seen it" hides genuinely new output behind a
  // cursor from a transcript that no longer exists.
  return !r || r.src !== o.src || r.seq !== o.seq || r.hash !== o.hash;
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
export function furtherMark(
  server: ReadMark | null | undefined,
  local: ReadMark | null | undefined,
  output?: OutputVersion | null,
): ReadMark | null {
  if (!local) return server || null;
  if (!server) return local;
  // Different generations are not comparable by number, so neither "further"
  // nor "newer argument" decides it — the current output does. Whichever mark
  // belongs to the transcript in front of us is the only one that can describe
  // it; a local mark left over from the previous generation must not shout down
  // a server mark another device just wrote for this one.
  if (server.src !== local.src) {
    if (output?.src === server.src) return server;
    if (output?.src === local.src) return local;
    return server; // unknowable: the server is the authority
  }
  if (local.seq > server.seq) return local;
  // Same position, different content: the local one was observed against text
  // the server had not published yet, so it is the later observation.
  if (local.seq === server.seq && local.hash !== server.hash && server.hash !== output?.hash) return local;
  return server;
}

/**
 * Local acknowledgements the server has caught up with, and can stop being
 * remembered. Without this the local map only ever grows, and a mark from a
 * generation that is gone stays in it forever.
 */
export function retireLocal(
  local: Record<string, ReadMark>,
  sessions: Readable[],
): Record<string, ReadMark> {
  const keep: Record<string, ReadMark> = {};
  let dropped = false;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const [id, mark] of Object.entries(local)) {
    const s = byId.get(id);
    const server = s?.read;
    const covered = !s // the session is gone
      || (server && server.src === mark.src && (server.seq > mark.seq
        || (server.seq === mark.seq && server.hash === mark.hash)))
      // A mark for a generation that is no longer the current one says nothing.
      || (s.output && s.output.src !== mark.src);
    if (covered) dropped = true; else keep[id] = mark;
  }
  return dropped ? keep : local;
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

/**
 * The server's output hash, recomputed in the browser.
 *
 * Duplicated from server/src/output-id.js on purpose: the reader has to be able
 * to say "the reply I am showing IS the one this version names", and the only
 * way to say that exactly is to hash the same bytes the server hashed. A
 * prefix comparison cannot — two different replies routinely share their first
 * few hundred characters, and a streaming answer's tail is exactly what a
 * prefix ignores. web/test/unread.test.mjs pins the two implementations to the
 * same vectors so they cannot drift apart silently.
 */
export function outputHash(text: string): string {
  const t = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}${t.length.toString(36)}`;
}

/**
 * Is the rendered answer the reply this version names?
 *
 * The harnesses hand their assistant text to the digest in slightly different
 * shapes — Claude one text block at a time, the others a whole message — so the
 * candidates are the last text block and the blocks joined. A match on either is
 * an exact content identity. No match means the reader is showing something
 * else (an older turn, a stale window, a differently assembled message), and
 * the caller must leave the reply unread rather than guess.
 */
export function answerMatches(texts: string[], hash: string): boolean {
  if (!hash || !texts.length) return false;
  const last = texts[texts.length - 1];
  return outputHash(last) === hash
    || outputHash(texts.join('\n')) === hash
    || outputHash(texts.join('')) === hash;
}
