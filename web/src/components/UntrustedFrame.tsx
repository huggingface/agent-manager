// Inside a frame that the default trust list (lib/framing.ts) rejects. The
// server may allow more embedders (AM_FRAME_ANCESTORS, listed in /api/info):
// ask once, then either hand back to the app or show the one thing an untrusted
// frame gets, a button that opens the app in its own tab. Loaded lazily by
// FrameGate in main.tsx.
import { useEffect, useState } from 'react';
import { appRootUrl } from '../lib/appUrl';
import { defaultTrusted, frameVerdict } from '../lib/framing';

export default function UntrustedFrame({ onTrusted }: { onTrusted: () => void }) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    // Plain fetch: this is a read, and the app's API helpers would start
    // lock/state side effects.
    let live = true;
    fetch('/api/info', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((info) => {
        if (!live) return;
        const extra = Array.isArray(info?.frameAncestors) ? info.frameAncestors.filter((o: unknown) => typeof o === 'string') : [];
        if (frameVerdict({ win: window }, [...defaultTrusted(window), ...extra]) === 'trusted') onTrusted();
        else setChecked(true);
      });
    return () => { live = false; };
  }, [onTrusted]);
  if (!checked) return null;
  return (
    <div className="framed-elsewhere" style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Agent Manager is embedded in another site</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
          For your safety it only runs in its own tab or on its Hugging Face Space page.
        </p>
        <button
          style={{ padding: '8px 16px', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: '1px solid #8884', background: 'transparent', color: 'inherit' }}
          // The app's root, nothing from this address: whoever framed us chose
          // its path, parameters and hash.
          onClick={() => window.open(appRootUrl(), '_blank', 'noopener,noreferrer')}
        >Open Agent Manager</button>
      </div>
    </div>
  );
}
