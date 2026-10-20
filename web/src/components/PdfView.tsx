// PDF pages painted to canvas by pdf.js, rather than handed to the browser's
// built-in viewer in a frame.
//
// The frame approach could not work here: /raw sends
// `Content-Security-Policy: sandbox …` WITHOUT allow-same-origin (so agent-written
// HTML gets an opaque origin), and Chrome refuses to run its PDF viewer for a
// sandboxed resource — the frame stayed blank, and so did "open in a new tab".
// Fetching the bytes ourselves side-steps that completely: a fetch response is
// not a browsing context, so the header keeps protecting HTML while PDFs render
// anywhere, including the headless browsers that have no viewer at all.
//
// pdf.js is lazy — the ~1 MB library only loads when a PDF is actually opened.
import { useEffect, useRef, useState } from 'react';

let libPromise: Promise<any> | null = null;
async function loadPdfjs() {
  libPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    // Vite resolves this to a hashed asset URL and ships the worker as its own
    // file; without it pdf.js parses on the main thread and janks the pane.
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return libPromise;
}

export default function PdfView({ src, onPages }: { src: string; onPages?: (n: number) => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    let alive = true;
    let doc: any = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const bytes = await (await fetch(src)).arrayBuffer();
        if (!alive) return;
        doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (!alive) return;
        onPages?.(doc.numPages);
        setStatus('');
        const box = host.current;
        if (!box) return;
        box.replaceChildren();

        // Render at the pane's width, times the device ratio so it stays sharp
        // on a retina screen without inflating the CSS size.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(320, (box.parentElement?.clientWidth ?? box.clientWidth) - 34);
        for (let n = 1; n <= doc.numPages; n++) {
          if (!alive) return;
          const page = await doc.getPage(n);
          const unit = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / unit.width) * dpr });
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${width}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          box.append(canvas);
          const ctx = canvas.getContext('2d');
          if (ctx) await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        }
      } catch (e: any) {
        if (alive) setErr(String(e?.message || e));
      }
    })();
    return () => { alive = false; doc?.destroy?.(); };
  }, [src, onPages]);

  if (err) {
    return (
      <div className="fv-empty">
        Could not render this PDF.
        <div className="fv-sub">{err}</div>
      </div>
    );
  }
  // The canvases are appended by hand, so they need a container React never
  // renders into — sharing one with the status line makes React trip over
  // children it didn't create ("removeChild: not a child of this node").
  return (
    <div className="fv-pdf">
      {status && <div className="fv-empty">{status}</div>}
      <div className="pdf-pages" ref={host} />
    </div>
  );
}
