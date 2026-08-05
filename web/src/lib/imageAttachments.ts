import * as api from '../api';
import type { ImageAttachment } from '../api';

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const IMAGE_ACCEPT = IMAGE_MIMES.join(',');
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES = 5;

export type PendingImageStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export interface PendingImage {
  key: string;
  file: File;
  previewUrl: string;
  status: PendingImageStatus;
  error?: string;
  attachment?: ImageAttachment;
}

const identity = (file: File) => `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`;

export function transferMayContainImage(transfer: DataTransfer) {
  return Array.from(transfer.items || []).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
    || Array.from(transfer.files || []).some((file) => file.type.startsWith('image/'));
}

/** DataTransfer exposes the same file through both items and files in Chromium. */
export function imageFilesFromTransfer(transfer: DataTransfer) {
  const files: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    const id = identity(file);
    if (seen.has(id)) return;
    seen.add(id);
    files.push(file);
  };
  for (const item of Array.from(transfer.items || [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  for (const file of Array.from(transfer.files || [])) add(file);
  return files;
}

export function pendingImagesFromFiles(files: File[], currentCount = 0) {
  const remaining = Math.max(0, MAX_IMAGES - currentCount);
  const accepted = files.slice(0, remaining).map((file): PendingImage => {
    let error: string | undefined;
    if (!(IMAGE_MIMES as readonly string[]).includes(file.type)) error = 'unsupported image type';
    else if (file.size > MAX_IMAGE_BYTES) error = 'too large (25 MB max)';
    else if (file.size === 0) error = 'empty image';
    return {
      key: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      status: error ? 'error' : 'pending',
      error,
    };
  });
  return {
    images: accepted,
    error: files.length > remaining ? `At most ${MAX_IMAGES} screenshots can be attached.` : null,
  };
}

export function revokePendingImages(images: PendingImage[]) {
  for (const image of images) URL.revokeObjectURL(image.previewUrl);
}

export const defaultImagePrompt = (count: number) =>
  `Please inspect the attached screenshot${count === 1 ? '' : 's'}.`;

/** Upload in display order. Already-successful items are reused on retry. */
export async function uploadPendingImages(
  sessionId: string,
  images: PendingImage[],
  update: (key: string, patch: Partial<PendingImage>) => void,
) {
  const attachments: ImageAttachment[] = [];
  for (const image of images) {
    if (image.attachment) {
      attachments.push(image.attachment);
      continue;
    }
    if (!(IMAGE_MIMES as readonly string[]).includes(image.file.type)
        || image.file.size === 0 || image.file.size > MAX_IMAGE_BYTES) {
      throw new Error(image.error || 'invalid image');
    }
    update(image.key, { status: 'uploading', error: undefined });
    try {
      const attachment = await api.uploadImageAttachment(sessionId, image.file);
      update(image.key, { status: 'uploaded', attachment });
      attachments.push(attachment);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'upload failed';
      update(image.key, { status: 'error', error: message });
      throw error;
    }
  }
  return attachments;
}
