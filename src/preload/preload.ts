import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS } from '../shared/api';

const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const method of API_METHODS) {
  api[method] = (...args) => ipcRenderer.invoke('api', method, args);
}

contextBridge.exposeInMainWorld('api', api);

// Files and links Windows asks Locus to open (double-clicked .locus files, locus:// links).
contextBridge.exposeInMainWorld('locusEvents', {
  onOpenRequest(cb: (req: string) => void) {
    ipcRenderer.on('open-request', (_e, req: string) => cb(req));
    ipcRenderer.invoke('pending-open').then((req: string | null) => req && cb(req));
  },
  /** Workspace files another program has just written. */
  onFilesChanged(cb: (paths: string[]) => void) {
    ipcRenderer.on('files-changed', (_e, paths: string[]) => cb(paths));
  },
  /** How updating Locus from GitHub is going. */
  onUpdateStatus(cb: (status: unknown) => void) {
    ipcRenderer.on('update-status', (_e, status: unknown) => cb(status));
  },
});
