import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FilePreviewContext } from './FileLinkContent';
import type { FileLinkRequest } from '../lib/fileLinks';
import '../file-links.css';

const FileLinkPage = lazy(() => import('./FileLinkPage'));

// A preview belongs to its originating tile, not the window. Keep the session
// mounted at the same size while covering it, but make it inert to avoid typing
// into a hidden terminal or composer. Other tiles remain usable.
export default function PaneFilePreview({ children, onOpenInViewer }: {
  children: ReactNode;
  onOpenInViewer: (request: FileLinkRequest) => Promise<void>;
}) {
  const [trail, setTrail] = useState<FileLinkRequest[]>([]);
  const open = useCallback((request: FileLinkRequest) => setTrail((old) => [...old, request]), []);
  const overlay = useRef<HTMLDivElement>(null);
  const session = useRef<HTMLDivElement>(null);
  const opened = trail.length > 0;
  const back = () => setTrail((old) => old.slice(0, -1));
  useLayoutEffect(() => {
    if (!opened) return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = session.current, preview = overlay.current;
    if (surface) surface.inert = true;
    preview?.focus({ preventScroll: true });
    return () => {
      if (surface) surface.inert = false;
      // Do not steal focus from a different pane the user has since selected.
      if (previous?.isConnected && (document.activeElement === document.body || preview?.contains(document.activeElement))) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [opened]);

  return <FilePreviewContext.Provider value={open}>
    <div className="pane-file-host">
      <div className="pane-file-session" ref={session}>{children}</div>
      {opened && <div className="pane-file-overlay" ref={overlay} tabIndex={-1} role="dialog" aria-label="File preview"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); }
        }}>
        <Suspense fallback={<div className="fv-empty" role="status">Loading file preview…</div>}>
          <FileLinkPage key={trail.length} embedded request={trail[trail.length - 1]} onBack={back} onClose={() => setTrail([])}
            onOpenInViewer={async (request) => { await onOpenInViewer(request); setTrail([]); }} />
        </Suspense>
      </div>}
    </div>
  </FilePreviewContext.Provider>;
}
