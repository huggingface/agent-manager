// The code surface for the Files pane: one CodeMirror editor that both reads
// and writes, so viewing and editing can't drift apart in look or behaviour.
//
// CodeMirror and every language mode are LAZY: none of it is in the initial
// bundle, and a language chunk only loads for a file that needs it. Until the
// editor arrives (a tick or two) the plain <pre> below is on screen, so opening
// a file never shows an empty box.
import { useEffect, useMemo, useRef, useState } from 'react';

// ---- lazy module handles -------------------------------------------------
// One dynamic import for the editor core, one per language. Vite splits each
// into its own chunk.
type CM = typeof import('./cm-core');
let corePromise: Promise<CM> | null = null;
const loadCore = () => (corePromise ??= import('./cm-core'));

// Plain, instant fallback — also what a file gets when the editor can't load.
// Line numbers live in their own sticky column so a long line scrolls under
// them rather than pushing them away.
export function PlainCode({ text }: { text: string }) {
  const gutter = useMemo(
    () => Array.from({ length: text.split('\n').length }, (_, i) => i + 1).join('\n'),
    [text],
  );
  return (
    <div className="fv-code">
      <pre className="fv-gutter" aria-hidden>{gutter}</pre>
      <pre className="fv-text">{text}</pre>
    </div>
  );
}

export type CodeViewProps = {
  text: string;
  /** File name — picks the language mode. */
  name: string;
  editable: boolean;
  /** Called on every edit with the new document. */
  onChange?: (next: string) => void;
  /** Cmd/Ctrl-S inside the editor. */
  onSave?: () => void;
  /** Light/dark, so the editor's own chrome matches the app. */
  theme: 'light' | 'dark';
  /** Soft-wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
};

export default function CodeView({ text, name, editable, onChange, onSave, theme, wrap = false }: CodeViewProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<any>(null);
  const core = useRef<CM | null>(null);
  const [ready, setReady] = useState(false);

  // Keep the latest callbacks reachable from CodeMirror's long-lived listeners
  // without tearing the editor down on every render.
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

  // Mount once per file. `text` is deliberately NOT a dependency: re-running
  // this on every keystroke would rebuild the editor under the cursor. External
  // text changes (a different file, a revert) come through the effect below.
  useEffect(() => {
    let alive = true;
    (async () => {
      const mod = await loadCore();
      if (!alive || !host.current) return;
      core.current = mod;
      view.current = mod.createEditor({
        parent: host.current,
        doc: text,
        name,
        editable,
        wrap,
        theme,
        onChange: (v: string) => cbs.current.onChange?.(v),
        onSave: () => cbs.current.onSave?.(),
      });
      setReady(true);
    })().catch(() => { /* the <pre> fallback stays on screen */ });
    return () => {
      alive = false;
      view.current?.destroy();
      view.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // Adopt text that changed from the outside (file reloaded, edits discarded)
  // while leaving the user's own typing alone. setDoc marks the dispatch as ours
  // so it doesn't come back through onChange as a fresh edit.
  useEffect(() => {
    const v = view.current;
    if (v) core.current?.setDoc(v, text);
  }, [text]);

  useEffect(() => { if (view.current) core.current?.setEditable(view.current, editable); }, [editable]);
  useEffect(() => { if (view.current) core.current?.setWrap(view.current, wrap); }, [wrap]);
  useEffect(() => { if (view.current) core.current?.setTheme(view.current, theme); }, [theme]);

  return (
    <div className="fv-code-host">
      <div ref={host} className="fv-cm" hidden={!ready} />
      {!ready && <PlainCode text={text} />}
    </div>
  );
}
