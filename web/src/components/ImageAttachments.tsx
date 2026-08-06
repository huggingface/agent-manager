import { useId, useRef } from 'react';
import type { PendingImage } from '../lib/imageAttachments';
import { IMAGE_ACCEPT } from '../lib/imageAttachments';

const fmtBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function ImageAttachments({ images, disabled, disabledReason, onFiles, onRemove }: {
  images: PendingImage[];
  disabled?: boolean;
  disabledReason?: string;
  onFiles: (files: File[]) => void;
  onRemove: (key: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  const showReason = !!disabled && !!disabledReason;
  return (
    <div className={`image-attachments${images.length ? ' has-images' : ''}${showReason ? ' has-note' : ''}`}>
      <button
        type="button"
        className="image-pick"
        disabled={disabled}
        title={disabledReason || 'Attach screenshots'}
        aria-label="Attach screenshots"
        aria-describedby={showReason ? reasonId : undefined}
        onClick={() => picker.current?.click()}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <rect x="2.5" y="3" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" />
          <circle cx="6.5" cy="7" r="1.25" fill="currentColor" />
          <path d="m4 13 3.2-3.1 2.1 2 1.6-1.6L14 13" fill="none" stroke="currentColor" strokeLinejoin="round" />
        </svg>
      </button>
      <input
        ref={picker}
        className="image-file-input"
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        disabled={disabled}
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files || []));
          event.currentTarget.value = '';
        }}
      />
      {showReason && <span id={reasonId} className="image-attachments-note">{disabledReason}</span>}
      {images.map((image) => (
        <div key={image.key} className={`image-chip ${image.status}`}>
          {image.error === 'unsupported image type' ? (
            <span className="image-chip-placeholder mono" aria-hidden="true">IMG</span>
          ) : (
            <a className="image-chip-preview" href={image.previewUrl} target="_blank" rel="noreferrer" title={`Preview ${image.file.name || 'screenshot'}`}>
              <img src={image.previewUrl} alt="" />
            </a>
          )}
          <span className="image-chip-copy">
            <span className="image-chip-name">{image.file.name || 'Screenshot'}</span>
            <span className="image-chip-meta" aria-live="polite">
              {image.status === 'uploading' ? 'uploading…'
                : image.error || (image.status === 'uploaded' ? 'uploaded' : fmtBytes(image.file.size))}
            </span>
          </span>
          <button type="button" onClick={() => onRemove(image.key)} disabled={disabled || image.status === 'uploading'} aria-label={`Remove ${image.file.name || 'screenshot'}`}>×</button>
        </div>
      ))}
    </div>
  );
}
