import { useRef } from 'react';
import Composer from './conversation/Composer';

/** A real text field lets the OS replace whole words before any bytes reach the PTY. */
export default function MobileTerminalDraft({ draft, onChange, onInsert, onClose, canInsert }: {
  draft: string;
  onChange: (value: string) => void;
  onInsert: () => void;
  onClose: () => void;
  canInsert: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  return <div className="term-draft" onPointerDown={(e) => e.stopPropagation()}>
    <div className="term-draft-caption">
      <span>Write here, then paste at the terminal cursor. No Enter is added.</span>
      <button type="button" onClick={onClose} aria-label="Close terminal draft">close</button>
    </div>
    <Composer draft={draft} onChange={onChange} onSend={() => { if (canInsert) onInsert(); }}
      isMobile inputRef={input} placeholder="write a prompt…" sendLabel="Paste draft into terminal"
      canSend={!!draft} sendDisabled={!canInsert} />
    {!canInsert && <small>Reconnect and tap the terminal to take control before pasting.</small>}
    {/[\r\n]/.test(draft) && <small>Multiple lines follow the terminal’s paste behavior and may run commands in a shell.</small>}
  </div>;
}
