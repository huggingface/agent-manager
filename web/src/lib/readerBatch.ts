import { useRef } from 'react';

/**
 * Identity for one continuous appearance of a Reader surface.
 *
 * Session ids alone are not enough: settings/mobile home unmount the readers,
 * and returning to the same ids must make the focused pane earn first paint
 * again. Focus is deliberately absent so moving focus within a painted grid
 * does not tear down its siblings.
 */
export function useReaderBatch(surfaceKey: string): string {
  const activation = useRef({ surfaceKey, sequence: 0 });
  if (activation.current.surfaceKey !== surfaceKey) {
    activation.current = {
      surfaceKey,
      sequence: activation.current.sequence + 1,
    };
  }
  return `${surfaceKey}|${activation.current.sequence}`;
}
