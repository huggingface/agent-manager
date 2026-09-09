import type { TraceTurn } from '../../api';
import type { Exchange } from './exchanges';

// Serialize searchable content once per immutable turn, never on each keypress.
// Image URLs and transport metadata are not conversation text.
const textCache = new WeakMap<TraceTurn, string>();
function searchable(turn: TraceTurn) {
  let text = textCache.get(turn);
  if (text === undefined) {
    text = turn.blocks.map((block) => [
      'name' in block ? block.name : '', 'text' in block ? block.text : '',
      'command' in block ? block.command : '', 'stdout' in block ? block.stdout : '', 'stderr' in block ? block.stderr : '',
    ].join('\n')).join('\n').toLowerCase();
    textCache.set(turn, text);
  }
  return text;
}
export function searchIndex(exchanges: Exchange[]) {
  return exchanges.map((x) => [x.prompt, ...x.steps, ...x.answer].filter(Boolean).map((t) => searchable(t!)).join('\n'));
}
