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
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

export function normalizedImageMime(type: string) {
  const value = String(type || '').split(';', 1)[0].trim().toLowerCase();
  return value === 'image/jpg' || value === 'image/pjpeg' ? 'image/jpeg' : value;
}

// Clipboard and drag sources sometimes omit MIME metadata. Use it as a hint,
// not as proof; the server validates the actual bytes before storing anything.
export function looksLikeImageFile(file: Pick<File, 'name' | 'type'>) {
  const type = normalizedImageMime(file.type);
  return !type || type === 'application/octet-stream'
    || type.startsWith('image/') || IMAGE_EXTENSION.test(file.name || '');
}

export function imageFileError(file: Pick<File, 'name' | 'type' | 'size'>) {
  if (file.size > MAX_IMAGE_BYTES) return 'too large (25 MB max)';
  if (file.size === 0) return 'empty image';
  const type = normalizedImageMime(file.type);
  if (type.startsWith('image/') && !(IMAGE_MIMES as readonly string[]).includes(type)) {
    return 'unsupported image type';
  }
  if (type && type !== 'application/octet-stream' && !type.startsWith('image/')
      && !IMAGE_EXTENSION.test(file.name || '')) return 'unsupported image type';
  return undefined;
}

export function transferMayContainImage(transfer: DataTransfer) {
  return Array.from(transfer.items || []).some((item) => item.kind === 'file'
      && (item.type.startsWith('image/') || looksLikeImageFile(item.getAsFile() || { name: '', type: item.type })))
    || Array.from(transfer.files || []).some(looksLikeImageFile);
}

/** DataTransfer exposes the same file through both items and files in Chromium. */
export function imageFilesFromTransfer(transfer: DataTransfer) {
  const files: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null) => {
    if (!file || !looksLikeImageFile(file)) return;
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
    const error = imageFileError(file);
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
    if (imageFileError(image.file)) {
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
