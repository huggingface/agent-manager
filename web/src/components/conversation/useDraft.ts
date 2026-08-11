// The composer's draft, as React state.
//
// The rules the text obeys once it leaves the box — where it is kept, how big it
// may get, how long it lives — are drafts.ts. This is the binding: it reads the
// remembered draft on mount, writes every change through, and keeps an IME
// composition from being persisted half-finished.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { holdDraft, recallDraft, rememberDraft } from './drafts';

/**
 * The composer's text, for one session, across everything that can take the
 * page away. A drop-in for `useState('')`.
 *
 * Restoring only ever fills the box: no focus, no cursor move, no send. The send
 * action stays exactly where it was — under the user's thumb. Clearing is the
 * caller's existing `setDraft('')` on a successful send, so a sent message
 * stops being a draft without anything new having to remember to say so.
 *
 * `inputRef` is the textarea the draft is typed into, and is used for one thing:
 * an IME composition gate. A phone keyboard composes — pinyin, kana, autocorrect
 * with candidates — and mid-composition the textarea holds a string the user has
 * not committed. Persisting that means a discard can restore half a syllable, so
 * writes are held back until `compositionend` and the pre-composition snapshot
 * stands in the meantime. The listeners are the hook's own rather than JSX props
 * deliberately: the composer markup is being unified in PR #49, and this has no
 * opinion about which element renders it.
 */
export function useDraft(
  sessionId: string,
  inputRef?: RefObject<HTMLTextAreaElement | null>,
): [string, (text: string) => void] {
  const [draft, setDraftState] = useState(() => recallDraft(sessionId));
  const composing = useRef(false);
  const held = useRef<string | null>(null);

  // A pane is mounted per session, so this fires on mount and then only if one
  // is ever re-pointed at another agent.
  useEffect(() => { setDraftState(recallDraft(sessionId)); }, [sessionId]);

  // Composition events bubble, so this listens on the document and asks "was
  // that my textarea?" rather than binding the node. Binding the node looks
  // tidier and is wrong: the reader renders `reading the trace…` on its first
  // commit, so at the moment the effect runs there is no textarea to bind, and
  // nothing re-runs it when one appears. The gate silently did nothing — caught
  // by driving a real composition sequence in a browser, not by reading it.
  useEffect(() => {
    if (!inputRef) return undefined;
    const mine = (e: Event) => e.target === inputRef.current;
    const start = (e: Event) => { if (mine(e)) composing.current = true; };
    const end = (e: Event) => {
      if (!mine(e)) return;
      composing.current = false;
      if (held.current === null) return;
      rememberDraft(sessionId, held.current);
      held.current = null;
    };
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    return () => {
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      // Unmounting mid-composition: commit what the box held rather than leave
      // the last committed keystroke behind forever.
      if (composing.current && held.current !== null) rememberDraft(sessionId, held.current);
      composing.current = false;
      held.current = null;
    };
  }, [sessionId, inputRef]);

  const setDraft = useCallback((text: string) => {
    setDraftState(text);
    if (composing.current) { held.current = text; holdDraft(sessionId, text); return; }
    rememberDraft(sessionId, text);
  }, [sessionId]);

  return [draft, setDraft];
}
