import { useEffect, useMemo, useRef, useState } from 'react';
import { FileView, type LinkedFileSource, type ViewInfo } from './FilesPane';
import FileWrapToggle from './FileWrapToggle';
import { fileLinkUrl, fileResourceUrl, resolveFileLink, type FileLinkRequest, type FileLinkTarget } from '../lib/fileLinks';
import { BackGlyph, CloseGlyph, DownloadGlyph, FileGlyph, RefreshGlyph } from './icons';
import '../file-links.css';

// Shared read-only surface: transient session preview, retained Files pane, or
// a copied link opened directly. Embedded previews never change browser history.
export default function FileLinkPage({ request, embedded = false, onBack, onClose, onOpenInViewer, dragId, onDragActive, closeLabel = 'Close preview' }: {
  request: FileLinkRequest;
  embedded?: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onOpenInViewer?: (request: FileLinkRequest) => Promise<void>;
  dragId?: string;
  onDragActive?: (dragging: boolean) => void;
  closeLabel?: string;
}) {
  const [target, setTarget] = useState<FileLinkTarget | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [raw, setRaw] = useState(!!request.line);
  const [info, setInfo] = useState<ViewInfo>({ meta: null, extra: [] });
  const [copied, setCopied] = useState('');
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState('');
  const resolved = useRef({ original: request, current: request });
  if (resolved.current.original !== request) resolved.current = { original: request, current: request };

  useEffect(() => {
    if (embedded) return;
    let theme: string | null = null;
    try { theme = localStorage.getItem('am-theme'); } catch { /* private storage */ }
    document.documentElement.dataset.theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, [embedded]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    setError(''); setTarget(null); setInfo({ meta: null, extra: [] });
    resolveFileLink(resolved.current.current, controller.signal).then((next) => {
      if (!alive || controller.signal.aborted) return;
      setTarget(next);
      const canonical = { file: next.path, root: next.root, line: request.line, column: request.column };
      resolved.current.current = canonical;
      if (!embedded) {
        history.replaceState(null, '', fileLinkUrl(canonical));
        document.title = next.path.split('/').pop() + ' · Agent Manager';
      }
    }).catch((err) => {
      if (!alive) return;
      setError(controller.signal.aborted ? 'The file request timed out. Try again.' : String(err.message || err));
    }).finally(() => clearTimeout(timer));
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [request, reload, embedded]);

  const source = useMemo<LinkedFileSource | undefined>(() => {
    if (!target) return undefined;
    const file = { file: target.path, root: target.root };
    return {
      root: target.root,
      preview: async () => {
        const response = await fetch(fileResourceUrl('preview', file), { signal: AbortSignal.timeout(12_000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not read this file.');
        return body;
      },
      rawUrl: fileResourceUrl('raw', file),
      downloadUrl: fileResourceUrl('download', file),
    };
  }, [target]);

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setCopied('Copy unavailable in this browser'); }
  };
  const kind = info.meta?.kind;
  return <section className={`file-link-page${embedded ? ' file-link-embedded' : ''}`} aria-label="File preview">
    <header className={`file-link-head${dragId ? ' draggable' : ''}`} draggable={!!dragId}
      onDragStart={dragId ? (event) => { event.dataTransfer.setData('text/plain', dragId); event.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
      onDragEnd={dragId ? () => onDragActive?.(false) : undefined}>
      {onBack ? <button className="mini-btn" onClick={onBack} title="Back" aria-label="Back"><BackGlyph /></button> : <FileGlyph />}
      <div className="file-link-title">
        <h1>{target?.path.split('/').pop() || 'File preview'}</h1>
        <div className="file-link-path" title={target?.absolute || request.file}>{target?.absolute || request.file}</div>
      </div>
      {onClose && <button className="mini-btn" onClick={onClose} title={closeLabel} aria-label={closeLabel}><CloseGlyph /></button>}
      {!embedded && <a className="mini-btn" href={location.pathname + location.search} target="_blank" rel="noopener noreferrer">Agent Manager ↗</a>}
    </header>
    <div className="file-link-tools">
      {kind && <span className="mono">{kind} · read-only</span>}
      {info.extra.map((text) => <span className="mono" key={text}>{text}</span>)}
      {!!request.line && <span className="mono">line {request.line}{request.column ? `:${request.column}` : ''}</span>}
      <span className="spacer" />
      {onOpenInViewer && <button className="mini-btn" disabled={!target || keeping} onClick={async () => {
        setKeeping(true); setKeepError('');
        try { await onOpenInViewer(resolved.current.current); }
        catch (err) { setKeepError(err instanceof Error ? err.message : 'Could not open the file viewer. Try again.'); }
        finally { setKeeping(false); }
      }}><FileGlyph /> {keeping ? 'Opening…' : 'Open in file viewer'}</button>}
      {(kind === 'markdown' || kind === 'html') && <button className="mini-btn" onClick={() => setRaw(!raw)}>{raw ? 'Preview' : 'Source'}</button>}
      {info.showWrap && info.edit && <FileWrapToggle wrap={info.edit.wrap} onChange={info.edit.setWrap} />}
      <button className="mini-btn" onClick={() => setReload((n) => n + 1)} title="Reload file"><RefreshGlyph /></button>
      {target && <>
        <button className="mini-btn" onClick={() => void copy(target.absolute, 'Path copied')}>Copy path</button>
        <button className="mini-btn" onClick={() => void copy(new URL(fileLinkUrl(resolved.current.current), location.href).href, 'Link copied')}>Copy link</button>
        <a className="mini-btn" href={source?.downloadUrl} download><DownloadGlyph /> Download</a>
      </>}
    </div>
    {copied && <div className="file-link-notice" role="status">{copied}</div>}
    {keepError && <div className="file-link-notice" role="alert">{keepError}</div>}
    {error ? <div className="fv-empty" role="alert">Could not open this file.<div className="fv-sub">{error}</div>
      <button className="mini-btn" onClick={() => setReload((n) => n + 1)}>Retry</button>
    </div> : target && source ? <FileView key={`${target.root}:${target.path}:${reload}`} sessionId="file-link-preview"
      path={target.path} source={source} zoom={100} raw={raw} scripts={false} line={raw || kind === 'text' ? request.line : undefined}
      column={request.column} onInfo={setInfo} /> : <div className="fv-empty" role="status">Locating file…</div>}
  </section>;
}
