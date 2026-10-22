import type { Api } from '../shared/api';

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;

/** Short version id as written into links. */
export const shortSha = (sha: string) => sha.slice(0, 10);
