import * as api from '../api';
import type { Attachment } from '../api';

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

export type PendingAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export interface PendingAttachment {
  key: string;
  file: File;
  previewUrl?: string;
  status: PendingAttachmentStatus;
  uploadedBytes?: number;
  uploadController?: AbortController;
  error?: string;
  attachment?: Attachment;
}

const identity = (file: File) => `${file.name}\u0000${file.type}\u0000${file.size}`;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

function normalizedMime(type: string) {
  const value = String(type || '').split(';', 1)[0].trim().toLowerCase();
  return value === 'image/jpg' || value === 'image/pjpeg' ? 'image/jpeg' : value;
}

// Clipboard and drag sources sometimes omit MIME metadata. Use it only to
// decide whether a local thumbnail is useful; the server independently decides
// which uploads are validated/native images and which remain inert files.
export function isPreviewableImageFile(file: Pick<File, 'name' | 'type'>) {
  const type = normalizedMime(file.type);
  return (IMAGE_MIMES as readonly string[]).includes(type) || IMAGE_EXTENSION.test(file.name || '');
}

export function attachmentFileError(file: Pick<File, 'size'>) {
  if (file.size > MAX_ATTACHMENT_BYTES) return 'too large (100 MB max)';
  if (file.size === 0) return 'empty file';
  return undefined;
}

export function transferMayContainFile(transfer: DataTransfer) {
  return Array.from(transfer.items || []).some((item) => item.kind === 'file')
    || Array.from(transfer.files || []).length > 0;
}

/**
 * DataTransfer exposes the same file through both `files` and `items` in some
 * browsers. The two views are not guaranteed to return the same File object —
 * clipboard-created files can even get different `lastModified` values — so
 * merging them can turn one paste into two attachments. `files` is the
 * canonical list; `items` is only a fallback for browsers that leave it empty.
 */
export function filesFromTransfer(transfer: DataTransfer) {
  const listed = Array.from(transfer.files || []);
  if (listed.length) return listed;

  const files: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null) => {
    if (!file) return;
    const id = identity(file);
    if (seen.has(id)) return;
    seen.add(id);
    files.push(file);
  };
  for (const item of Array.from(transfer.items || [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  return files;
}

const extensionForMime = (type: string) => ({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}[normalizedMime(type)] || 'bin');

/** One ClipboardItem can advertise the same logical file in several formats. */
export async function filesFromClipboardItems(items: ClipboardItem[]) {
  const files: File[] = [];
  for (const item of items) {
    const imageTypes = item.types.filter((type) => normalizedMime(type).startsWith('image/'));
    const fileTypes = item.types.filter((type) => !['text/plain', 'text/html'].includes(normalizedMime(type)));
    const hasText = item.types.some((type) => ['text/plain', 'text/html'].includes(normalizedMime(type)));
    const type = imageTypes.find((candidate) =>
      (IMAGE_MIMES as readonly string[]).includes(normalizedMime(candidate)))
      || imageTypes[0]
      || (!hasText ? fileTypes[0] : undefined);
    if (!type) continue;
    const blob = await item.getType(type);
    const mime = blob.type || type;
    files.push(new File([blob], `Clipboard.${extensionForMime(mime)}`, { type: mime }));
  }
  return files;
}

export function pendingAttachmentsFromFiles(files: File[], currentCount = 0) {
  const remaining = Math.max(0, MAX_ATTACHMENTS - currentCount);
  const accepted = files.slice(0, remaining).map((file): PendingAttachment => {
    const error = attachmentFileError(file);
    return {
      key: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      previewUrl: isPreviewableImageFile(file) ? URL.createObjectURL(file) : undefined,
      status: error ? 'error' : 'pending',
      error,
    };
  });
  return {
    attachments: accepted,
    error: files.length > remaining ? `At most ${MAX_ATTACHMENTS} files can be attached.` : null,
  };
}

export function revokePendingAttachments(attachments: PendingAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

/** Abandon an unsent chip: stop its transfer and remove any stored server file. */
export function discardPendingAttachment(sessionId: string, attachment: PendingAttachment) {
  attachment.uploadController?.abort();
  if (attachment.attachment) {
    void api.deleteAttachment(sessionId, attachment.attachment.id).catch(() => {});
  }
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export function discardPendingAttachments(sessionId: string, attachments: PendingAttachment[]) {
  for (const attachment of attachments) discardPendingAttachment(sessionId, attachment);
}

export interface PendingPrompt {
  /** The operator's words (or the attachment-only fallback), used to recognise
   *  the real transcript turn when it arrives. */
  text: string;
  /** What the optimistic exchange shows until that transcript turn arrives. */
  displayText: string;
}

/**
 * The server sends the prompt and its attachment paths as one string. Mirror
 * that small presentation rule in the optimistic exchange so the first paint
 * says exactly what was sent, without making transcript catch-up depend on a
 * CLI retaining the path syntax verbatim.
 */
export function buildPendingPrompt(
  cli: string,
  text: string,
  attachments: Pick<Attachment, 'kind' | 'path'>[],
): PendingPrompt {
  const onlyImages = attachments.length > 0 && attachments.every((attachment) => attachment.kind === 'image');
  const prompt = String(text || '').trim() || (onlyImages
    ? `Please inspect the attached screenshot${attachments.length === 1 ? '' : 's'}.`
    : `Please inspect the attached file${attachments.length === 1 ? '' : 's'}.`);
  if (!attachments.length) return { text: prompt, displayText: prompt };
  const paths = attachments.map((attachment) => attachment.path);
  const attachmentText = cli === 'gemini'
    ? paths.map((filePath) => `@${JSON.stringify(filePath)}`).join('\n')
    : `Attached files:\n${paths.map((filePath) => `- ${JSON.stringify(filePath)}`).join('\n')}`;
  return { text: prompt, displayText: `${prompt}\n\n${attachmentText}` };
}

/** Upload in display order. Already-successful items are reused on retry. */
export async function uploadPendingAttachments(
  sessionId: string,
  attachments: PendingAttachment[],
  update: (key: string, patch: Partial<PendingAttachment>) => void,
) {
  const uploaded: Attachment[] = [];
  let firstFailure: Error | null = null;
  const controllers = new Map<string, AbortController>();
  for (const attachment of attachments) {
    if (attachment.attachment || attachmentFileError(attachment.file)) continue;
    const controller = new AbortController();
    controllers.set(attachment.key, controller);
    update(attachment.key, { uploadController: controller });
  }
  for (const attachment of attachments) {
    if (attachment.attachment) {
      uploaded.push(attachment.attachment);
      continue;
    }
    const invalid = attachmentFileError(attachment.file);
    if (invalid) {
      update(attachment.key, { status: 'error', error: invalid });
      firstFailure ??= new Error(invalid);
      continue;
    }
    const controller = controllers.get(attachment.key)!;
    if (controller.signal.aborted) continue;
    update(attachment.key, { status: 'uploading', uploadedBytes: 0, error: undefined });
    try {
      const stored = await api.uploadAttachment(sessionId, attachment.file, {
        signal: controller.signal,
        onProgress: ({ loaded }) => update(attachment.key, { uploadedBytes: loaded }),
      });
      // An abort can race the final response: XHR may have settled while the
      // click that removed the chip already marked the controller aborted.
      // In that narrow window we learned the id, so remove the now-unsent file.
      if (controller.signal.aborted) {
        await api.deleteAttachment(sessionId, stored.id).catch(() => undefined);
        continue;
      }
      update(attachment.key, {
        status: 'uploaded', uploadedBytes: attachment.file.size,
        uploadController: undefined, attachment: stored,
      });
      uploaded.push(stored);
    } catch (error) {
      if (controller.signal.aborted) {
        update(attachment.key, { uploadController: undefined });
        continue;
      }
      const message = error instanceof Error ? error.message : 'upload failed';
      update(attachment.key, { status: 'error', uploadController: undefined, error: message });
      firstFailure ??= error instanceof Error ? error : new Error(message);
    }
  }
  if (firstFailure) throw firstFailure;
  return uploaded;
}
