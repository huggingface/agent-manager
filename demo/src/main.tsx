// The real reader, on a bundled synthetic session. No sidebar, no settings, no
// setup: just the session window and the few controls needed to test it.
import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ConversationView from '../../web/src/components/conversation/ConversationView';
import { demo } from './fixtureApi';
import type { Session } from '../../web/src/types';

const session = {
  id: 'demo', cli: 'claude', name: 'Reader demo', state: 'waiting',
  running: false, everStarted: true, path: null, createdAt: new Date().toISOString(),
} as unknown as Session;

function App() {
  // A fresh key remounts the reader with a cold store, which is what makes the
  // initial-load behaviour repeatable without reloading the page.
  const [run, setRun] = useState(0);
  const [slow, setSlow] = useState(true);
  const reset = useCallback(() => {
    demo.reads = 0;
    try { localStorage.removeItem('am.reading'); } catch { /* private mode */ }
    setRun((n) => n + 1);
  }, []);
  return <div className="demo">
    <header className="demo-bar mono">
      <span className="demo-title">Agent Manager · reader</span>
      <span className="demo-note">synthetic session · {slow ? 'slowed for the spinner' : 'no added delay'}</span>
      <span className="spacer" />
      <button className="cxv-mini" onClick={() => { demo.latencyMs = slow ? 0 : 750; setSlow(!slow); }}>
        {slow ? 'remove delay' : 'add delay'}
      </button>
      <button className="cxv-mini" onClick={reset}>reset · load again</button>
    </header>
    <div className="demo-pane">
      <ConversationView key={run} session={session} readOnly />
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
