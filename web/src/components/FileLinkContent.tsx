import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { fileLinkUrl, fileRequest, looksLikeFile, requestFromHash, type FileLinkContext } from '../lib/fileLinks';

const Context = createContext<FileLinkContext>({});
export function FileLinkScope({ session, root, base, unavailable, children }: FileLinkContext & { children: ReactNode }) {
  const value = useMemo(() => ({ session, root, base, unavailable }), [session, root, base, unavailable]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// `html` has already passed through renderMarkdown's sanitizer. Only generated
// app URLs are added here; no untrusted HTML or attributes are inserted.
export function linkFileContent(html: string, context: FileLinkContext): string {
  // Static renders have no browser navigation to decorate.
  if (typeof document === 'undefined') return html;
  const host = document.createElement('div');
  host.innerHTML = html;
  const decorate = (anchor: HTMLAnchorElement, value: string, encoded: boolean) => {
    // renderMarkdown protects file:// links before sanitizing them.
    const protectedRef = value.startsWith('#file=') ? requestFromHash(value) : null;
    const request = protectedRef?.root || protectedRef?.session ? protectedRef
      : fileRequest(protectedRef?.file || value, context, protectedRef ? false : encoded);
    if (!request) return;
    if (protectedRef?.line) request.line = protectedRef.line;
    if (protectedRef?.column) request.column = protectedRef.column;
    anchor.href = fileLinkUrl(request);
    anchor.dataset.fileLink = 'true';
    anchor.title = `Open ${request.file}${request.line ? `:${request.line}` : ''}`;
  };
  host.querySelectorAll('a[href]').forEach((anchor) => {
    decorate(anchor as HTMLAnchorElement, anchor.getAttribute('href')!, true);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });
  host.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre, a') || !looksLikeFile(code.textContent || '')) return;
    const anchor = document.createElement('a');
    decorate(anchor, code.textContent!, false);
    if (!anchor.dataset.fileLink) return;
    anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    code.replaceWith(anchor); anchor.append(code);
  });
  return host.innerHTML;
}

export default function FileLinkContent({ html, className }: { html: string; className?: string }) {
  const context = useContext(Context);
  const linked = useMemo(() => linkFileContent(html, context), [html, context]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: linked }} />;
}
