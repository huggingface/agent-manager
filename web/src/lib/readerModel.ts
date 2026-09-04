import type { TraceBlock, TraceTurn } from '../api';

const queueKey = (text: string) => text.replace(/\s+/g, ' ').trim();
const sameBlocks = (a: TraceBlock[], b: TraceBlock[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Transport fragments → one immutable conversation. Never mutate cached pages.
 * Replayed in chronological order so prepends repair the same relationships as
 * appends. Linear in records/blocks, not exchanges × records. */
export function reconcileTrace(raw: TraceTurn[], previous: TraceTurn[] = []): TraceTurn[] {
  const messages: TraceTurn[] = [];
  const byMessage = new Map<string, number>();
  const pending: { text: string; at: number; turn: TraceTurn }[] = [];
  for (const turn of raw) {
    if (turn.event?.type === 'queue') {
      const event = turn.event;
      if (event.operation === 'enqueue') {
        pending.push({ text: queueKey(event.text), at: messages.length,
          turn: { ...turn, event: undefined, role: 'user', queued: true, blocks: [{ type: 'text', text: event.text }] } });
        messages.push(turn); // reserve its chronological position; invisible until removed
      }
      else if (event.operation === 'dequeue') pending.shift();
      else if (event.operation === 'remove') {
        const i = pending.findIndex((p) => p.text === queueKey(event.text));
        if (i >= 0) { const p = pending.splice(i, 1)[0]; messages[p.at] = p.turn; }
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
    const index = turn.messageId ? byMessage.get(turn.messageId) : undefined;
    if (index !== undefined) {
      const first = messages[index];
      messages[index] = { ...first, kind: turn.kind || first.kind, blocks: [...first.blocks, ...turn.blocks] };
    } else {
      if (turn.messageId) byMessage.set(turn.messageId, messages.length);
      messages.push(turn);
    }
  }
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
  const old = new Map(previous.filter((t) => t.id).map((t) => [t.id, t]));
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
