import * as api from '../api';
import type { Attachment } from '../api';

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
// More files do not mean more simultaneous requests. Three transfers per
// session keeps a large batch moving without letting repeated picker/drop
// additions turn into an unbounded fan-out. Other sessions have their own
// queue, so one large prompt does not hold up another agent.
export const ACTIVE_UPLOADS_PER_SESSION = 3;

export type PendingAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export interface PendingAttachment {
  key: string;
  file: File;
  previewUrl?: string;
  status: PendingAttachmentStatus;
  uploadedBytes?: number;
  uploadController?: AbortController;
  error?: string;
  retryable?: boolean;
  attachment?: Attachment;
}

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
  const add = (file: File | null) => {
    if (!file) return;
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

export function pendingAttachmentsFromFiles(files: File[], _currentCount = 0) {
  const accepted = files.map((file): PendingAttachment => {
    const error = attachmentFileError(file);
    return {
      key: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      previewUrl: isPreviewableImageFile(file) ? URL.createObjectURL(file) : undefined,
      status: error ? 'error' : 'pending',
      error,
      retryable: error ? false : undefined,
    };
  });
  return {
    attachments: accepted,
    error: null,
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

type UploadJob<T> = {
  signal: AbortSignal;
  run: () => Promise<T>;
  resolve: (value: T | undefined) => void;
  reject: (reason: unknown) => void;
  started: boolean;
};
type SessionUploadQueue = { active: number; jobs: UploadJob<unknown>[] };
const sessionUploadQueues = new Map<string, SessionUploadQueue>();

function drainSessionUploads(sessionId: string) {
  const queue = sessionUploadQueues.get(sessionId);
  if (!queue) return;
  while (queue.active < ACTIVE_UPLOADS_PER_SESSION && queue.jobs.length) {
    const job = queue.jobs.shift()!;
    if (job.signal.aborted) { job.resolve(undefined); continue; }
    job.started = true;
    queue.active += 1;
    job.run().then(job.resolve, job.reject).finally(() => {
      queue.active -= 1;
      drainSessionUploads(sessionId);
    });
  }
  if (queue.active === 0 && queue.jobs.length === 0) sessionUploadQueues.delete(sessionId);
}

/** Queue one transfer behind only the other transfers for this same session. */
function scheduleSessionUpload<T>(sessionId: string, signal: AbortSignal, run: () => Promise<T>) {
  return new Promise<T | undefined>((resolve, reject) => {
    const queue = sessionUploadQueues.get(sessionId) || { active: 0, jobs: [] };
    sessionUploadQueues.set(sessionId, queue);
    const job: UploadJob<T> = { signal, run, resolve, reject, started: false };
    const cancelQueued = () => {
      if (job.started) return; // the XHR owns active cancellation
      const at = queue.jobs.indexOf(job as UploadJob<unknown>);
      if (at < 0) return;
      queue.jobs.splice(at, 1);
      resolve(undefined);
      if (queue.active === 0 && queue.jobs.length === 0) sessionUploadQueues.delete(sessionId);
    };
    signal.addEventListener('abort', cancelQueued, { once: true });
    queue.jobs.push(job as UploadJob<unknown>);
    drainSessionUploads(sessionId);
  });
}

/** Upload with bounded per-session concurrency. Already-successful items are reused on retry. */
export async function uploadPendingAttachments(
  sessionId: string,
  attachments: PendingAttachment[],
  update: (key: string, patch: Partial<PendingAttachment>) => void,
) {
  const uploaded: Array<Attachment | undefined> = new Array(attachments.length);
  const failures: Array<Error | undefined> = new Array(attachments.length);
  const controllers = new Map<string, AbortController>();
  for (const attachment of attachments) {
    if (attachment.attachment || attachmentFileError(attachment.file)) continue;
    const controller = new AbortController();
    controllers.set(attachment.key, controller);
    update(attachment.key, { uploadController: controller });
  }
  await Promise.all(attachments.map(async (attachment, index) => {
    if (attachment.attachment) {
      uploaded[index] = attachment.attachment;
      return;
    }
    const invalid = attachmentFileError(attachment.file);
    if (invalid) {
      update(attachment.key, { status: 'error', error: invalid });
      failures[index] = new Error(invalid);
      return;
    }
    const controller = controllers.get(attachment.key)!;
    if (controller.signal.aborted) return;
    try {
      const stored = await scheduleSessionUpload(sessionId, controller.signal, () => {
        update(attachment.key, { status: 'uploading', uploadedBytes: 0, error: undefined, retryable: undefined });
        return api.uploadAttachment(sessionId, attachment.file, {
          signal: controller.signal,
          onProgress: ({ loaded }) => update(attachment.key, { uploadedBytes: loaded }),
        });
      });
      if (!stored) return; // cancelled while queued
      // An abort can race the final response: XHR may have settled while the
      // click that removed the chip already marked the controller aborted.
      // In that narrow window we learned the id, so remove the now-unsent file.
      if (controller.signal.aborted) {
        await api.deleteAttachment(sessionId, stored.id).catch(() => undefined);
        return;
      }
      update(attachment.key, {
        status: 'uploaded', uploadedBytes: attachment.file.size,
        uploadController: undefined, attachment: stored,
      });
      uploaded[index] = stored;
    } catch (error) {
      if (controller.signal.aborted) {
        update(attachment.key, { uploadController: undefined });
        return;
      }
      const message = error instanceof Error ? error.message : 'upload failed';
      const retryable = !(typeof error === 'object' && error !== null
        && 'retryable' in error && (error as { retryable?: unknown }).retryable === false);
      update(attachment.key, {
        status: 'error', uploadController: undefined, error: message,
        retryable,
      });
      failures[index] = error instanceof Error ? error : new Error(message);
    }
  }));
  const firstFailure = failures.find(Boolean);
  if (firstFailure) throw firstFailure;
  return uploaded.filter((attachment): attachment is Attachment => !!attachment);
}
