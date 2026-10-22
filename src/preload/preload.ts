import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS } from '../shared/api';

const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const method of API_METHODS) {
  api[method] = (...args) => ipcRenderer.invoke('api', method, args);
}

contextBridge.exposeInMainWorld('api', api);
