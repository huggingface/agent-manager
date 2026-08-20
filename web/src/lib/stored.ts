// Small preferences that live in the browser: theme, zoom, where you were, and
// now the palette and typeface.
//
// Storage can be denied outright — private mode, or a third-party iframe under
// cross-site tracking prevention (the Hub embeds this Space in exactly such an
// iframe). Reading it then THROWS rather than returning null, so every access
// goes through these two: a raw localStorage call in a useState initializer
// took the whole app down to its error boundary — "Something broke in the UI" —
// for a preference as incidental as which zoom you last used. A "don't
// remember" fallback, never a crash, so both sides swallow.
export const readStored = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

export const writeStored = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch { /* storage denied — the selection just won't survive a reload */ }
};
