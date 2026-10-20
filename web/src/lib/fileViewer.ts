import * as api from '../api';
import { recall, remember } from '../components/filesMemory';
import type { Session } from '../types';
import { fileLinkHash, type FileLinkRequest } from './fileLinks';

// Only the explicit "Open in file viewer" action creates a passive session.
// Never repoint an unrelated Files pane: it may contain an unsaved editor.
export async function retainFileViewer(request: FileLinkRequest, sessions: Session[], groupId?: string) {
  const existing = sessions.find((session) => {
    const linked = session.cli === 'files' && !session.archivedAt && recall(session.id).linkedFile;
    return linked && fileLinkHash(linked) === fileLinkHash(request);
  });
  if (existing) return existing;
  const pane = await api.createSession(`File: ${request.file.split('/').pop()}`, 'files', groupId, '.');
  remember(pane.id, { linkedFile: request });
  return pane;
}
