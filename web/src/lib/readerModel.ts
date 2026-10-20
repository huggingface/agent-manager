import type { TraceBlock, TraceTurn } from '../api';

const queueKey = (text: string) => text.replace(/\s+/g, ' ').trim();

// Mirrors the trace normalizer's named harness envelopes. A leading '<' alone
// can be an operator's HTML/XML prompt and must not hide its prompt band.
//
// This lives with the model rather than with the grouping because the store has
// to count exchanges to decide how much history it still owes the reader, and a
// second copy of the rule would drift from the one the view groups by.
export const isOperatorPrompt = (t: TraceTurn) => {
  if (t.role !== 'user') return false;
  const text = t.blocks.filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('').trim();
  if (!text) return t.blocks.some((b) => b.type === 'image');
  return !/^<(?:task-notification|environment_context|system-reminder|app-context|recommended_plugins|fork-boilerplate)(?:\s|>)/.test(text)
    // Codex injects AGENTS.md as a plain user message. Matched on the shape it
    // emits, so a prompt that merely mentions or quotes it still reads as one.
    // Kept identical to `isHarnessText` in server/src/traces.js. The server's
    // half is what actually runs in production; it has its own coverage in
    // server/test/harness-envelope.test.mjs, through the real normalizer on
    // real rollout files. This copy exists for sources the client sees
    // unnormalized, and is covered in web/test/readerHistory.test.mjs.
    && !/^#\s*AGENTS\.md instructions\s*\n(?:\s*\n)*<INSTRUCTIONS>/.test(text)
    && !text.startsWith('[Request interrupted')
    && !text.startsWith('[SYSTEM NOTIFICATION');
};

/**
 * How many exchanges a reconciled turn list holds — the unit the reader shows
 * and the operator counts, as opposed to transport records, tool results or
 * lifecycle events.
 *
 * Deliberately only the OPENING rule from `splitExchanges`: an operator prompt
 * starts an exchange, and turns before the first prompt form one leading
 * exchange. Nothing else in that function can change the count, and
 * `exchanges.test.mjs` pins the two together against shared fixtures.
 */
export function countExchanges(turns: TraceTurn[]): number {
  let count = 0;
  let open = false;
  for (const turn of turns) {
    if (isOperatorPrompt(turn)) { count++; open = true; }
    // splitExchanges drops system turns from every exchange's steps, so one
    // opening an exchange here would count a row the reader never draws — which
    // is exactly how injected context made a short history look long enough.
    else if (turn.role === 'system') continue;
    else if (!open) { count++; open = true; }
  }
  return count;
}
const sameBlocks = (a: TraceBlock[], b: TraceBlock[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Transport fragments → one immutable conversation. Never mutate cached pages.
 * Replayed in chronological order so prepends repair the same relationships as
 * appends. Linear in records/blocks, not exchanges × records. */
export function reconcileTrace(raw: TraceTurn[], previous: TraceTurn[] = []): TraceTurn[] {
  const old = new Map(previous.filter((t) => t.id).map((t) => [t.id, t]));
  const messages: TraceTurn[] = [];
  const byMessage = new Map<string, number>();
  const pending: { text: string; turn: TraceTurn }[] = [];
  const placed = new Set<string>();   // queue entries already shown, by the id their removal names
  const consumed = new Map<string, number>();   // dequeued into a request: the real message carries it
  for (const turn of raw) {
    if (turn.event?.type === 'queue') {
      const event = turn.event;
      // Text is the only thing an enqueue carries, so it is what connects one
      // to its removal. Everything else uses the removal's own identity: it
      // names the queue entry, and taking the enqueue's id instead let a
      // non-FIFO removal of two identical messages wear the other one's id and
      // timestamp.
      const sameText = (t?: TraceTurn) => !!t && t.blocks.length === 1
        && t.blocks[0].type === 'text' && t.blocks[0].text === event.text;
      const prior = turn.id ? old.get(turn.id) : undefined;
      const blocks: TraceBlock[] = sameText(prior) ? prior!.blocks : [{ type: 'text', text: event.text }];
      const key = queueKey(event.text);
      if (event.operation === 'enqueue') {
        // Held, not placed. The enqueue marks where the prompt was TYPED, which
        // for a mid-turn message is in the middle of the answer to the previous
        // one — and a user turn there opens an exchange that swallows the rest
        // of that answer, leaving the exchange it belongs to with none. Still
        // waiting prompts are appended after the loop instead.
        pending.push({ text: key, turn: { ...turn, event: undefined, role: 'user', queued: true, blocks } });
      }
      else if (event.operation === 'dequeue') {
        // Popped into a request: the ordinary user message is on its way and
        // that copy keeps the prompt. Positional, because a dequeue names no
        // text — but the entry it pops does, and a later record of the same
        // prompt must not add it a second time.
        const gone = pending.shift();
        if (gone) consumed.set(gone.text, (consumed.get(gone.text) || 0) + 1);
      }
      else {
        // `remove` and `delivered` are both terminal: whatever the queue did
        // with it, it is not waiting any more, so the badge comes off. They are
        // also two records of the SAME prompt, so the first to arrive places it
        // and the id keeps the second from placing it again.
        const id = event.commandUuid;
        if (id && placed.has(id)) { continue; }
        const already = consumed.get(key) || 0;
        if (already) { consumed.set(key, already - 1); continue; }
        const at = pending.findIndex((p) => p.text === key);
        if (at >= 0) pending.splice(at, 1);   // no longer waiting
        // The removal alone is enough. A window can begin after the enqueue and
        // still carry this, and the prompt used to vanish in that window while
        // its reply stayed — which is why a reload and the live view disagreed.
        // `blocks` is reused from the previous poll's copy of THIS turn, which
        // is what keeps the rendered row identical across polls.
        messages.push({ ...turn, event: undefined, role: 'user', queued: false, blocks });
        if (id) placed.add(id);
      }
      continue;
    }
    if (turn.event?.type === 'task-complete') {
      const answer = turn.event.text.trim();
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && m.blocks.some((b) => b.type === 'text' || b.type === 'image' || b.type === 'shell')) break;
        if (m.role === 'assistant' && m.blocks.some((b) => b.type === 'text'
          && (b.text.trim() === answer || (b.more && answer.startsWith(b.text.trim()))))) {
          messages[i] = { ...m, kind: 'final' }; break;
        }
      }
      continue;
    }
    // The dequeued prompt has arrived as an ordinary message, so that dequeue
    // is answered for. Left standing, its count was spent by the next record of
    // the same TEXT instead — a second send of the same words, whose removal
    // was then skipped and whose enqueue sat at the end still marked queued.
    if (turn.role === 'user' && consumed.size) {
      const arrived = queueKey(turn.blocks.filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : '')).join(''));
      const outstanding = arrived ? consumed.get(arrived) || 0 : 0;
      if (outstanding) consumed.set(arrived, outstanding - 1);
    }
    const index = turn.messageId ? byMessage.get(turn.messageId) : undefined;
    if (index !== undefined) {
      const first = messages[index];
      messages[index] = { ...first, kind: turn.kind || first.kind, blocks: [...first.blocks, ...turn.blocks] };
    } else {
      if (turn.messageId) byMessage.set(turn.messageId, messages.length);
      messages.push(turn);
    }
  }
  // Anything still in the queue when the page ends is a prompt the operator has
  // sent and is waiting on. Held back above so it does not split the answer it
  // was typed into, it goes in here, at the end, where it is waiting — and
  // visibly queued, which is the one case that badge is for. Without this a
  // genuinely queued prompt was in the transcript and nowhere on screen, so it
  // disappeared on reload.
  for (const held of pending) messages.push(held.turn);
  // Results can arrive in a different HTTP request, or before their call in a
  // backward page. Ordinary tools need the same identity join as subagents.
  const calls = new Set<string>();
  const results = new Map<string, TraceBlock[]>();
  for (const turn of messages) for (const block of turn.blocks) {
    if (block.type === 'tool_use' && block.id) calls.add(block.id);
    if (block.type === 'tool_result' && block.id) {
      const list = results.get(block.id) || []; list.push(block); results.set(block.id, list);
    }
  }
  const reconciled: TraceTurn[] = [];
  for (const turn of messages) {
    const blocks: TraceBlock[] = [];
    for (const block of turn.blocks) {
      if (block.type === 'tool_result' && block.id && calls.has(block.id)) continue;
      blocks.push(block);
      if (block.type === 'tool_use' && block.id) blocks.push(...(results.get(block.id) || []));
    }
    if (!blocks.length) continue;
    let next = sameBlocks(blocks, turn.blocks) ? turn : { ...turn, blocks };
    const prior = next.id ? old.get(next.id) : undefined;
    if (prior && prior.kind === next.kind && prior.role === next.role && prior.ts === next.ts
      && prior.queued === next.queued && prior.model === next.model && prior.usage === next.usage
      && sameBlocks(prior.blocks, next.blocks)) next = prior;
    reconciled.push(next);
  }
  return reconciled.length === previous.length && reconciled.every((t, i) => t === previous[i]) ? previous : reconciled;
}
