import { useEffect, useRef } from 'react';

/**
 * A readout of the numbers the mobile keyboard layout is computed from
 * (App.tsx: the visualViewport effect). iOS Safari has no devtools and the Hub
 * page embeds the app cross-origin, so when the layout lands in the wrong place
 * on a phone there is otherwise nothing to read. Opt in with `?vvdebug=1`.
 *
 * It keeps a short history, not just a live line: the interesting moment is the
 * keyboard animation, and by the time a phone can be screenshotted that is over.
 * A row is recorded only when something changed, so the tail of the list IS the
 * transition — which value moved, and which one failed to follow.
 *
 * Writes through textContent on a frame loop rather than setState: this exists
 * to measure a layout animation, and re-rendering the app every frame would
 * perturb the thing being measured.
 */
const ROWS = 10;

export default function ViewportDebug() {
  const out = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let last = '';
    const history: string[] = [];
    // vv.height while nothing is focused: what App.tsx's focusFallback later
    // multiplies by its constant. In an iframe this is the FRAME's height, not
    // the screen's — the discrepancy that makes the guess wrong.
    let baseline = window.visualViewport?.height ?? window.innerHeight;

    const num = (n: number) => String(Math.round(n)).padStart(4);
    const active = () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return '-';
      const cls = (el.className || '').split(/\s+/)[0];
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`.slice(0, 18);
    };
    const edges = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return '   -    ';
      const r = el.getBoundingClientRect();
      return `${num(r.top)}${num(r.bottom)}`;
    };

    const read = () => {
      const vv = window.visualViewport;
      const root = document.documentElement;
      const focused = document.activeElement instanceof HTMLElement
        && /^(input|textarea)$/.test(document.activeElement.tagName.toLowerCase());
      if (!focused) baseline = vv?.height ?? window.innerHeight;

      // One fixed-width row per sample so a column of them reads as a timeline.
      const row = [
        `vv${num(vv?.height ?? -1)}@${num(vv?.offsetTop ?? -1)}`,
        `css${(root.style.getPropertyValue('--vvh').trim() || '-').padStart(5)}@${(root.style.getPropertyValue('--vv-top').trim() || '-').padStart(4)}`,
        `scr${num(document.scrollingElement?.scrollTop ?? 0)}`,
        `app${edges('.app')}`,
        `box${edges('.cxv-live textarea')}`,
        (root.dataset.keyboardLayout || 'none').slice(0, 8),
      ].join(' ');
      if (row !== last) {
        last = row;
        history.push(row);
        if (history.length > ROWS) history.shift();
      }

      if (out.current) {
        out.current.textContent = [
          `base ${Math.round(baseline)}  inner ${window.innerHeight}  vvw ${Math.round(vv?.width ?? -1)}`,
          `screen ${window.screen.width}x${window.screen.height}  embed ${window.self !== window.top ? 'y' : 'n'}`,
          `focus ${active()}`,
          '',
          ...history,
        ].join('\n');
      }
      frame = requestAnimationFrame(read);
    };
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <pre className="vvdebug" ref={out} />;
}
