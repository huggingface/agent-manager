// The dev-preview calls (routes exist only when the Space sets AM_DEV_PREVIEW=1).
// Imported only by the lazily loaded DevPreviewBar and DevPreviewPanel, so none
// of this ships in the entry chunk; it reuses api.ts's request wrapper.
import { amFetch as fetch, amJson as json, type DevPreviewPr, type DevPreviewSummary } from '../api';

const HEADERS = { 'content-type': 'application/json' };

export const getDevPreviewStatus = (): Promise<DevPreviewSummary & { log: string[] }> =>
  fetch('/api/dev-preview/status').then(json);
export const getDevPreviewPrs = (): Promise<{ ok: boolean; error?: string; repo?: string; main?: { sha: string | null }; prs?: DevPreviewPr[] }> =>
  fetch('/api/dev-preview/prs').then(json);
export const switchDevPreview = (prs: { number: number; sha?: string }[]): Promise<DevPreviewSummary> =>
  fetch('/api/dev-preview/switch', { method: 'POST', headers: HEADERS, body: JSON.stringify({ prs }) }).then(json);
export const rollbackDevPreview = (): Promise<DevPreviewSummary> =>
  fetch('/api/dev-preview/rollback', { method: 'POST', headers: HEADERS, body: '{}' }).then(json);
export type { DevPreviewPr, DevPreviewSummary, DevPreviewRunning, DevPreviewJob } from '../api';
