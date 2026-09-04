import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { requestFromHash } from './lib/fileLinks';
import './styles.css';
import './conversation.css';

// Last-resort guard: React unmounts the WHOLE tree on an uncaught render
// error, which reads as a blank white page. Show a reload card instead.
class Boundary extends Component<{ children: ReactNode }, { err: unknown }> {
  state = { err: null as unknown };
  static getDerivedStateFromError(err: unknown) { return { err }; }
  componentDidCatch(err: unknown) { console.error('[render crash]', err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Something broke in the UI</h2>
          <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
            The error is logged in the browser console. Your agents keep running; reloading usually fixes the view.
          </p>
          <button
            style={{ padding: '8px 16px', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: '1px solid #8884', background: 'transparent', color: 'inherit' }}
            onClick={() => location.reload()}
          >Reload</button>
        </div>
      </div>
    );
  }
}

// No StrictMode: it double-mounts in dev, which would open duplicate WebSockets.
const FileLinkPage = lazy(() => import('./components/FileLinkPage'));
function Entry() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  // Keep request identity stable while the page renders metadata or copies a URL.
  const request = useMemo(() => requestFromHash(hash), [hash]);
  return request
    ? <Suspense fallback={<div className="fv-empty">Loading file preview…</div>}><FileLinkPage key={hash} request={request} /></Suspense>
    : <App />;
}
createRoot(document.getElementById('root')!).render(<Boundary><Entry /></Boundary>);

// Push notifications ride on this worker (agents message the operator on request).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* unsupported context */ });
}
