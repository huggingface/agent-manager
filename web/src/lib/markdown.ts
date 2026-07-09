import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Render markdown to SANITIZED HTML. Agent output and skill files can contain
// untrusted content (an agent may echo something it read from the web or a
// repo), and we inject the result via dangerouslySetInnerHTML into a page that
// has full backend/shell access — so it must be sanitized. marked does not
// sanitize; DOMPurify strips scripts, event handlers, and dangerous URLs.
export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html);
}
