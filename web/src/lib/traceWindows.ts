// React is a subscriber, not the owner of transcript history or request state.
// Parent readers, file previews and expanded children share the same lifecycle.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { readerFor, type TraceSource } from './readerStore';
export { INITIAL_WINDOW_BYTES, INITIAL_WINDOW_TURNS, WINDOW_BYTES, mergeMeta } from './readerStore';
export type { TraceSource, Meta, TraceHeadInfo } from './readerStore';

export function useTraceWindows(src: TraceSource, srcKey: string, opts: {
  onPrepend?: (count: number) => void;
  onAppend?: (count: number) => void;
  onReset?: () => void;
  paused?: boolean;
  /** Activity is a presentation hint; even an idle transcript can change. */
  live?: boolean;
} = {}) {
  const store = useMemo(() => readerFor(srcKey, src), [srcKey, src]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const callbacks = useRef(opts); callbacks.current = opts;
  const turns = useRef(state.turns); turns.current = state.turns;
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => store.observe((change) => {
    if (change.type === 'reset') callbacks.current.onReset?.();
    else if (change.type === 'prepend') callbacks.current.onPrepend?.(change.count);
    else callbacks.current.onAppend?.(change.count);
  }), [store]);
  useEffect(() => {
    if (!opts.paused && !hidden) return store.retain();
  }, [store, opts.paused, hidden]);
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const recover = () => { if (!document.hidden && !callbacks.current.paused) void store.refresh(); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) recover(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pageshow', show);
    window.addEventListener('online', recover);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('online', recover);
    };
  }, [store]);
  return { ...state, turns, meta: state.head, atStart: !!state.cursor?.atStart,
    blocked: !!state.cursor?.blocked, loadOlder: store.loadOlder, loadNewer: store.loadNewer,
    reload: store.refresh, dismissNotice: store.dismissNotice };
}
