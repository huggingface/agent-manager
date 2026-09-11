// The real ExchangeView, wired to the real hook through the real `answerRef`.
//
// Loaded by seenLatest.render.test.mjs. Kept as its own file rather than an
// inline string so the component and hook are imported the way the app imports
// them, and so this stays type-checked with everything else.
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { ExchangeView } from '../../src/components/conversation/Exchange';
import { useSeenLatest } from '../../src/components/useSeenLatest';

const version = { id: 's1', src: 'gen1', seq: 1, hash: 'h1' };
declare global { interface Window { acks: string[][]; mountWired: () => void } }
window.acks = [];

// A prompt long enough to fill the viewport on its own, with the answer below.
const long = Array.from({ length: 60 }, (_, i) => `prompt line ${i}`).join('\n');
const x = {
  key: 'x1',
  at: 0,
  prompt: { role: 'user' as const, blocks: [{ type: 'text' as const, text: long }], harness: 'claude' },
  steps: [],
  answer: [{ role: 'assistant' as const, blocks: [{ type: 'text' as const, text: 'THE ANSWER' }], harness: 'claude' }],
  startTs: 0,
  endTs: 0,
  tokens: 0,
  toolCalls: 0,
};

function Wired() {
  const ref = useSeenLatest({
    version,
    eligible: true,
    onSeen: (marks) => { window.acks.push(marks.map((m) => m.hash)); },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return h('div', null, h(ExchangeView as any, { x, answerRef: (n: HTMLDivElement | null) => { ref.current = n; } }));
}

window.mountWired = () => {
  window.acks = [];
  createRoot(document.getElementById('root')!).render(h(Wired));
};
