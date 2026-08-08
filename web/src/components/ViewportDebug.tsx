import { useEffect, useState } from 'react';

/**
 * A readout of the numbers the mobile keyboard layout is computed from
 * (App.tsx: the visualViewport effect). iOS Safari has no devtools and the Hub
 * page embeds the app cross-origin, so when the layout lands in the wrong place
 * on a phone there is otherwise nothing to read. Opt in with `?vvdebug=1`.
 *
 * Sampled on a frame loop rather than on events: the interesting moment is the
 * keyboard animation, where the values that matter are the ones that DISAGREE
 * mid-flight.
 */
export default function ViewportDebug() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      const vv = window.visualViewport;
      const root = document.documentElement;
      const css = (name: string) => root.style.getPropertyValue(name).trim() || '–';
      const rect = (el: Element | null) => {
        if (!el) return '–';
        const r = el.getBoundingClientRect();
        return `${Math.round(r.top)}→${Math.round(r.bottom)}`;
      };
      const active = document.activeElement;
      const name = active instanceof HTMLElement
        ? `${active.tagName.toLowerCase()}.${(active.className || '').split(/\s+/)[0] || '-'}`
        : '–';
      setLines([
        `screen ${window.screen.height}  inner ${window.innerHeight}  embed ${window.self !== window.top ? 'y' : 'n'}`,
        `vv     h ${Math.round(vv?.height ?? -1)}  top ${Math.round(vv?.offsetTop ?? -1)}  scale ${(vv?.scale ?? 1).toFixed(2)}`,
        `css    vvh ${css('--vvh')}  vv-top ${css('--vv-top')}`,
        `mode   ${root.dataset.keyboardLayout || 'none'}`,
        `scroll doc ${Math.round(document.scrollingElement?.scrollTop ?? 0)}  win ${Math.round(window.scrollY)}`,
        `app    ${rect(document.querySelector('.app'))}`,
        `reader ${rect(document.querySelector('.pane-reader'))}`,
        `box    ${rect(document.querySelector('.cxv-live textarea'))}`,
        `focus  ${name}`,
      ]);
      frame = requestAnimationFrame(read);
    };
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <pre className="vvdebug">{lines.join('\n')}</pre>;
}
