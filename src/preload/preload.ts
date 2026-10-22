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
});
