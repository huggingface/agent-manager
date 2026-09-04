import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import { fileLinkHash, parseFileReference } from './fileLinks';

// Render markdown to SANITIZED HTML. Agent output and skill files can contain
// untrusted content (an agent may echo something it read from the web or a
// repo), and we inject the result via dangerouslySetInnerHTML into a page that
// has full backend/shell access — so it must be sanitized. marked does not
// sanitize; DOMPurify strips scripts, event handlers, and dangerous URLs.
//
// `breaks` exists for ONE caller: the prompt band. An agent writes markdown on
// purpose, so a single newline in an answer is a soft wrap and folding it into
// the paragraph is correct. A person typing into a composer does not — their
// newlines are where they pressed Enter, and the band showed every one of them
// while it was raw text. Rendering a prompt under strict markdown would reflow
// every multi-line prompt in the reader into one paragraph, which is a silent
// loss of what was typed rather than a rendering choice.
export function renderMarkdown(md: string, opts?: { breaks?: boolean }): string {
  const renderer = new Renderer();
  const link = renderer.link;
  renderer.link = function (token) {
    // file:// and a bare `app.ts:42` look like protocols to the sanitizer.
    // Convert recognized file references to safe app fragments first.
    const ref = /^[^/]*:/.test(token.href) ? parseFileReference(token.href) : null;
    return link.call(this, ref ? { ...token, href: fileLinkHash(ref) } : token);
  };
  const html = marked.parse(md ?? '', { async: false, breaks: !!opts?.breaks, renderer }) as string;
  return DOMPurify.sanitize(html);
}
