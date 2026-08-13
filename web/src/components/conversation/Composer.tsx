/**
 * The reply line: `❯`, a textarea that grows, a send key.
 *
 * One component, used by the Overview card and by reader mode, because they are
 * the same act — answering the agent you are reading. It was duplicated markup
 * for exactly one release and that is how composers drift: a feature lands in
 * the card (paste-to-attach, PR #39; a slash-command menu; history recall) and
 * quietly does not exist in the pane. Everything a composer can do belongs here.
 */
import { useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { filesFromTransfer, transferMayContainFile } from '../../lib/attachments';
import { SendGlyph } from '../icons';

export default function Composer({
  draft, sending, isMobile, inputRef, className = '', containerClassName = '', above, canSend,
  onChange, onSend, onCancel, onPasteFiles,
}: {
  draft: string;
  sending?: boolean;
  isMobile?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  containerClassName?: string;
  /** Rendered directly above the line — an attachment strip, when there is one. */
  above?: ReactNode;
  /** Overrides the send-button condition, for example when files are attached without text. */
  canSend?: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel?: () => void;
  /**
   * A paste (or drop) carrying files rather than text. The seam PR #39's
   * screenshot input plugs into: give it a handler and both the card and the
   * reader accept pasted images, because they are literally this component.
   */
  onPasteFiles?: (files: File[]) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const filesEnabled = !!onPasteFiles && !sending;
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!filesEnabled || !onPasteFiles) return;
    const files = filesFromTransfer(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    onPasteFiles(files);
  };
  const acceptsDrop = (e: DragEvent<HTMLDivElement>) =>
    filesEnabled && transferMayContainFile(e.dataTransfer);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop: Enter sends, Shift+Enter newlines. Mobile keyboards cannot do
    // Shift+Enter, so there Enter newlines and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); onSend(); }
    if (e.key === 'Escape') { onChange(''); onCancel?.(); inputRef?.current?.blur(); }
  };
  return (
    <div
      className={`ov-composer${containerClassName ? ` ${containerClassName}` : ''}${dropActive ? ' image-drop' : ''}`}
      onDragEnter={(e) => { if (acceptsDrop(e)) { e.preventDefault(); setDropActive(true); } }}
      onDragOver={(e) => { if (acceptsDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }}
      onDrop={(e) => {
        if (!acceptsDrop(e) || !onPasteFiles) return;
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);
        onPasteFiles(filesFromTransfer(e.dataTransfer));
      }}
    >
      {above}
      <div className={`ov-live ${className}`.trim()}>
      <span className="ov-p mono">❯</span>
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        disabled={sending}
        placeholder={sending ? 'sending…' : 'reply…'}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={(e) => { onChange(e.target.value); grow(e.currentTarget); }}
        onPaste={onPaste}
        // iOS does not resize the layout for the keyboard — scroll the input
        // into view once the keyboard has animated in.
        onFocus={(e) => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); }}
        onKeyDown={onKeyDown}
      />
        {(canSend ?? !!draft.trim()) && (
          <button className="ov-send" title="Send" onClick={onSend} disabled={sending}><SendGlyph /></button>
        )}
      </div>
    </div>
  );
}
