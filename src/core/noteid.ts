// A note that something links to carries a permanent identity, so the link still finds it after
// the note is renamed or moved outside the app. In a markdown note it is a hidden comment on the
// last line; in a flowchart it is a top-level key. It is written once and never changed.
import { isCanvas, parseCanvas, serializeCanvas } from './canvas.ts';

const COMMENT = /(\r?\n)?[ \t]*<!--\s*locus-id:\s*([a-z0-9]{12})\s*-->[ \t]*(\r?\n)?$/;
const KEY = 'locusId';

export function newNoteId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (const b of crypto.getRandomValues(new Uint8Array(12))) id += chars[b % chars.length];
  return id;
}

/** Splits a markdown note into what the editor shows and its identity (if it has one). */
export function splitNoteId(md: string): { body: string; id?: string } {
  const m = md.match(COMMENT);
  if (!m) return { body: md };
  // The comment sits on its own last line; the note's own final line break stays with the body.
  const body = md.slice(0, m.index!) + (m[1] ?? '');
  return { body, id: m[2] };
}

/** Puts a note's identity back as the last line. */
export function joinNoteId(body: string, id: string | undefined, eol = '\n'): string {
  if (!id) return body;
  const sep = body === '' || body.endsWith('\n') ? '' : eol;
  return `${body}${sep}<!-- locus-id: ${id} -->${eol}`;
}

/** The identity of a note or flowchart, from its file text. */
export function readNoteId(path: string, text: string): string | undefined {
  if (!isCanvas(path)) return splitNoteId(text).id;
  try {
    const id = parseCanvas(text)[KEY];
    return typeof id === 'string' && /^[a-z0-9]{12}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The file text with an identity added. A file that already has one is returned unchanged. */
export function addNoteId(path: string, text: string, id: string): string {
  if (readNoteId(path, text)) return text;
  if (!isCanvas(path)) return joinNoteId(text, id, text.includes('\r\n') ? '\r\n' : '\n');
  try {
    return serializeCanvas({ ...parseCanvas(text), [KEY]: id });
  } catch {
    return text;
  }
}

/** The `id=` part of a link's address, if it records the note it points at. */
export function linkNoteId(extra: string[]): string | undefined {
  return extra.find((p) => /^id=[a-z0-9]{12}$/.test(p))?.slice(3);
}

/** A link's extra parts with the note's identity recorded. */
export function withLinkNoteId(extra: string[], id: string): string[] {
  return [...extra.filter((p) => !p.startsWith('id=')), `id=${id}`];
}
