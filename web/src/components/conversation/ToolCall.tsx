// An expanded tool call, rendered as what it is rather than as its wire format.
// (docs/conversation-view.md §4.3)
//
// The JSON a harness sends is an argument object, not a thing to read: a Bash
// call is a command, an Edit is a before and an after, a Read is a file and a
// range. Anything unrecognised still renders — as fields, and as JSON only where
// the value really is structured.
import type { ReactNode } from 'react';

const isScalar = (v: unknown) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const Block = ({ kind, children }: { kind?: string; children: ReactNode }) => (
  <pre className={`cs-pre${kind ? ` ${kind}` : ''}`}>{children}</pre>
);

const Caption = ({ children }: { children: ReactNode }) => (
  <div className="ct-cap mono">{children}</div>
);

/** "lines 170–210" reads; `{offset: 170, limit: 40}` does not. */
function range(o: Record<string, unknown>): string {
  const off = typeof o.offset === 'number' ? o.offset : null;
  const lim = typeof o.limit === 'number' ? o.limit : null;
  if (off == null && lim == null) return '';
  if (off != null && lim != null) return `lines ${off}–${off + lim}`;
  return off != null ? `from line ${off}` : `first ${lim} lines`;
}

const SHOWN_ELSEWHERE = new Set([
  'command', 'description', 'file_path', 'path', 'notebook_path', 'content',
  'old_string', 'new_string', 'offset', 'limit', 'replace_all',
]);

/** Whatever is left, as fields — scalars inline, structure as JSON. */
function Fields({ o, skip }: { o: Record<string, unknown>; skip?: Set<string> }) {
  const rows = Object.entries(o).filter(([k, v]) =>
    !(skip?.has(k)) && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
  if (!rows.length) return null;
  return (
    <dl className="ct-fields mono">
      {rows.map(([k, v]) => (
        <div key={k} className="ct-row">
          <dt>{k}</dt>
          <dd>
            {isScalar(v)
              ? (typeof v === 'string' && v.includes('\n')
                ? <Block>{v}</Block>
                : String(v))
              : <Block>{JSON.stringify(v, null, 2)}</Block>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function ToolCall({ name, text }: { name: string; text: string }) {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return <Block>{text}</Block>; }
  if (!parsed || typeof parsed !== 'object') return <Block>{String(parsed)}</Block>;
  const o = parsed as Record<string, unknown>;

  const file = [o.file_path, o.path, o.notebook_path].find((v) => typeof v === 'string') as string | undefined;
  const note = typeof o.description === 'string' ? o.description : '';

  // A shell call is a command.
  if (typeof o.command === 'string') {
    return (
      <>
        {note && <Caption>{note}</Caption>}
        <Block kind="ct-cmd">{o.command}</Block>
        <Fields o={o} skip={SHOWN_ELSEWHERE} />
      </>
    );
  }

  // An edit is a before and an after.
  if (typeof o.old_string === 'string' && typeof o.new_string === 'string') {
    return (
      <>
        {file && <Caption>{file}{o.replace_all ? ' · every occurrence' : ''}</Caption>}
        <Block kind="ct-was">{o.old_string}</Block>
        <Block kind="ct-now">{o.new_string}</Block>
        <Fields o={o} skip={SHOWN_ELSEWHERE} />
      </>
    );
  }

  // A write is a file and its contents.
  if (file && typeof o.content === 'string') {
    return (
      <>
        <Caption>{file}</Caption>
        <Block>{o.content}</Block>
        <Fields o={o} skip={SHOWN_ELSEWHERE} />
      </>
    );
  }

  // A read is a file and a range.
  if (file) {
    const r = range(o);
    return (
      <>
        <Caption>{file}{r ? ` · ${r}` : ''}</Caption>
        {note && <div className="ct-note">{note}</div>}
        <Fields o={o} skip={SHOWN_ELSEWHERE} />
      </>
    );
  }

  // Everything else — a search, a fetch, an agent — is its fields.
  return (
    <>
      {note && <Caption>{note}</Caption>}
      <Fields o={o} skip={new Set(['description'])} />
    </>
  );
}
