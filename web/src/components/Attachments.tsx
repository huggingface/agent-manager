import { useId, useRef } from 'react';
import type { PendingAttachment } from '../lib/attachments';

const fmtBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const fileLabel = (name: string) => {
  const extension = name.split('.').pop();
  return extension && extension !== name ? extension.slice(0, 4).toUpperCase() : 'FILE';
};

export default function Attachments({ attachments, disabled, disabledReason, showPicker = true, onFiles, onRemove }: {
  attachments: PendingAttachment[];
  disabled?: boolean;
  disabledReason?: string;
  showPicker?: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (key: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  const showReason = showPicker && !!disabled && !!disabledReason;
  if (!showPicker && attachments.length === 0) return null;
  return (
    <div className={`image-attachments${attachments.length ? ' has-images' : ''}${showReason ? ' has-note' : ''}`}>
      {showPicker && (
        <>
          <button
            type="button"
            className="image-pick"
            disabled={disabled}
            title={disabledReason || 'Attach files'}
            aria-label="Attach files"
            aria-describedby={showReason ? reasonId : undefined}
            onClick={() => picker.current?.click()}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M6.2 9.7 10.8 5a2.5 2.5 0 0 1 3.6 3.5l-6.2 6.3a4 4 0 0 1-5.7-5.7l6-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <input
            ref={picker}
            className="image-file-input"
            type="file"
            multiple
            disabled={disabled}
            onChange={(event) => {
              onFiles(Array.from(event.currentTarget.files || []));
              event.currentTarget.value = '';
            }}
          />
        </>
      )}
      {showReason && <span id={reasonId} className="image-attachments-note">{disabledReason}</span>}
      {attachments.map((attachment) => (
        <div key={attachment.key} className={`image-chip ${attachment.status}`}>
          {attachment.previewUrl ? (
            <a className="image-chip-preview" href={attachment.previewUrl} target="_blank" rel="noreferrer" title={`Preview ${attachment.file.name || 'image'}`}>
              <img src={attachment.previewUrl} alt="" />
            </a>
          ) : (
            <span className="image-chip-placeholder mono" aria-hidden="true">{fileLabel(attachment.file.name || '')}</span>
          )}
          <span className="image-chip-copy">
            <span className="image-chip-name">{attachment.file.name || 'Attachment'}</span>
            <span className="image-chip-meta" aria-live="polite">
              {attachment.status === 'uploading' ? 'uploading…'
                : attachment.error || (attachment.status === 'uploaded' ? 'uploaded' : fmtBytes(attachment.file.size))}
            </span>
          </span>
          <button type="button" onClick={() => onRemove(attachment.key)} disabled={disabled || attachment.status === 'uploading'} aria-label={`Remove ${attachment.file.name || 'file'}`}>×</button>
        </div>
      ))}
    </div>
  );
}
