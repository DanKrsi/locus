// Loads file bytes (working copy, a past version, or an external file) with a small cache,
// so viewers and hover-card previews share one read.
import { api } from './api';

export interface FileSource {
  path: string;
  external?: boolean;
  rev?: string;
}

export const sourceKey = (s: FileSource) => `${s.external ? 'ext:' : ''}${s.path}@${s.rev ?? 'latest'}`;

const cache = new Map<string, Promise<Uint8Array>>();
const MAX_ENTRIES = 24;

export function loadBytes(src: FileSource): Promise<Uint8Array> {
  const key = sourceKey(src);
  let p = cache.get(key);
  if (!p) {
    p = src.external ? api.readExternal(src.path) : api.readFile(src.path, src.rev);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Forget cached working-copy reads (after files change on disk). Past versions never change. */
export function invalidateLatest() {
  for (const key of [...cache.keys()]) if (key.endsWith('@latest')) cache.delete(key);
}

export function decodeText(bytes: Uint8Array): { text: string; bom: boolean; eol: string } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { text, bom, eol };
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

export function mimeFor(ext: string): string {
  return MIME[ext] ?? 'application/octet-stream';
}
