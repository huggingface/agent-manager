// CodeMirror setup, kept out of the main bundle: CodeView imports this module
// dynamically, so nothing here loads until someone opens a text file.
//
// The theme is written against the app's own CSS variables rather than shipping
// a stock CodeMirror theme, so the code surface stays the surface it was — same
// mono face, same gutter treatment, same background — and follows the light/dark
// switch for free.
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { HighlightStyle, syntaxHighlighting, indentUnit, bracketMatching, foldGutter, StreamLanguage, LanguageSupport } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// ---- palette -------------------------------------------------------------
// Every colour is a CSS variable defined in styles.css for both themes, so the
// highlighting is themed in one place alongside the rest of the app.
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--cm-string)' },
  { tag: [t.number, t.bool, t.null, t.integer, t.float], color: 'var(--cm-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--cm-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--cm-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--cm-prop)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--cm-punct)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--cm-tag)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--cm-def)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--cm-meta)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: 'var(--cm-heading)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: [t.deleted, t.invalid], color: 'var(--cm-invalid)' },
  { tag: [t.inserted], color: 'var(--cm-string)' },
  { tag: [t.quote], color: 'var(--cm-comment)' },
]);

const baseTheme = (dark: boolean) => EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--term-bg)', height: '100%', fontSize: 'inherit' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { padding: '8px 14px 8px 12px', caretColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--term-bg)',
    color: 'color-mix(in srgb, var(--muted) 70%, transparent)',
    borderRight: '1px solid var(--border)',
    paddingRight: '2px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)', outline: 'none',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 2px', color: 'var(--muted)' },
  // Read-only still shows a text cursor on hover; make it feel like a document.
  '&:not(.cm-focused) .cm-cursor': { display: 'none' },
}, { dark });

// ---- languages -----------------------------------------------------------
// Loaded per file, so opening a .py never pays for the SQL or PHP grammar.
async function languageFor(name: string): Promise<Extension | null> {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const base = lower.slice(lower.lastIndexOf('/') + 1);

  const legacy = async (pick: (m: any) => any) =>
    StreamLanguage.define(pick(await import('@codemirror/legacy-modes/mode/shell')));

  switch (ext) {
    case '.js': case '.mjs': case '.cjs':
      return (await import('@codemirror/lang-javascript')).javascript();
    case '.jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case '.ts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case '.tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case '.py': case '.pyi':
      return (await import('@codemirror/lang-python')).python();
    case '.md': case '.markdown': case '.mdx':
      return (await import('@codemirror/lang-markdown')).markdown();
    case '.json': case '.jsonl': case '.ndjson':
      return (await import('@codemirror/lang-json')).json();
    case '.css': case '.scss': case '.less': case '.sass':
      return (await import('@codemirror/lang-css')).css();
    case '.html': case '.htm': case '.vue': case '.svelte':
      return (await import('@codemirror/lang-html')).html();
    case '.xml': case '.svg':
      return (await import('@codemirror/lang-xml')).xml();
    case '.sql':
      return (await import('@codemirror/lang-sql')).sql();
    case '.yaml': case '.yml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case '.rs':
      return (await import('@codemirror/lang-rust')).rust();
    case '.go': case '.mod':
      return (await import('@codemirror/lang-go')).go();
    case '.c': case '.h': case '.cc': case '.cpp': case '.hpp':
      return (await import('@codemirror/lang-cpp')).cpp();
    case '.java': case '.kt': case '.kts':
      return (await import('@codemirror/lang-java')).java();
    case '.php':
      return (await import('@codemirror/lang-php')).php();
    case '.sh': case '.bash': case '.zsh': case '.fish':
      return legacy((m) => m.shell);
    case '.toml': case '.ini': case '.cfg': case '.conf': case '.properties': case '.env':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
    case '.rb':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby);
    case '.lua':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua);
    case '.diff': case '.patch':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff);
    case '.dockerfile':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
    default: break;
  }
  // Files that are text by convention rather than by extension.
  if (base === 'dockerfile') return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
  if (base === 'makefile' || ext === '.mk') return legacy((m) => m.shell);
  if (base.startsWith('.bashrc') || base.startsWith('.zshrc') || base.startsWith('.profile')) return legacy((m) => m.shell);
  return null; // plain text: still line-numbered, just uncoloured
}

// ---- editor --------------------------------------------------------------
const langComp = new Compartment();
const editComp = new Compartment();
const themeComp = new Compartment();
const wrapComp = new Compartment();

export type EditorHandle = EditorView & { __compartments?: never };

export function createEditor(opts: {
  parent: HTMLElement;
  doc: string;
  name: string;
  editable: boolean;
  wrap: boolean;
  theme: 'light' | 'dark';
  onChange: (next: string) => void;
  onSave: () => void;
}): EditorView {
  const saveKey = keymap.of([{
    key: 'Mod-s',
    preventDefault: true,
    run: () => { opts.onSave(); return true; },
  }]);

  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      wrapComp.of(opts.wrap ? EditorView.lineWrapping : []),
      lineNumbers(),
      foldGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      rectangularSelection(),
      bracketMatching(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      indentUnit.of('  '),
      syntaxHighlighting(highlight, { fallback: true }),
      saveKey,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      langComp.of([]),
      themeComp.of(baseTheme(opts.theme === 'dark')),
      editComp.of([EditorView.editable.of(opts.editable), EditorState.readOnly.of(!opts.editable)]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applying.has(u.view)) opts.onChange(u.state.doc.toString());
      }),
    ],
  });

  const view = new EditorView({ state, parent: opts.parent });
  // The grammar arrives a beat after the text — the document is already
  // readable, it just gains colour.
  languageFor(opts.name).then((lang) => {
    if (lang) view.dispatch({ effects: langComp.reconfigure(lang) });
  }).catch(() => {});
  return view;
}

// Replacing the document from the outside (a discard, a reload, a rename) is not
// an edit. Without this flag the update listener fires on our own dispatch and
// marks the file dirty again the instant it was made clean.
const applying = new WeakSet<EditorView>();

export function setDoc(view: EditorView, text: string) {
  if (view.state.doc.toString() === text) return;
  applying.add(view);
  try {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  } finally {
    applying.delete(view);
  }
}

export function setWrap(view: EditorView, wrap: boolean) {
  view.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) });
}

export function setEditable(view: EditorView, editable: boolean) {
  view.dispatch({
    effects: editComp.reconfigure([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
  });
}

export function setTheme(view: EditorView, theme: 'light' | 'dark') {
  view.dispatch({ effects: themeComp.reconfigure(baseTheme(theme === 'dark')) });
}

export type { LanguageSupport };
