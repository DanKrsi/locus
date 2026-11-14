// Exporting a note so it can be read without Locus: one HTML page (or a PDF printed from it)
// holding the note as it was on screen, its pictures inside it, and links that still open the
// documents it cites on this computer (UI spec §9).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { extname, fileKind, parseDestination, resolvePath, slugify, stem } from '../core/link';
import { extractLinks } from '../core/mdlinks';
import { renderMarkdown } from '../core/render';
import { splitNoteId } from '../core/noteid';
import { buildPage } from '../core/page';
import * as git from './git';

/** Pictures bigger than this are left out: a note of screenshots would make an unusable file. */
const MAX_IMAGE = 25 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

/** An absolute path on this computer as a URL a browser or PDF reader will open. */
export function fileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return 'file:///' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

export interface ExportContext {
  /** Absolute path of the workspace folder. */
  root: string;
  /** The note being exported, as a workspace path. */
  notePath: string;
}

/** Where a reference points once the note is read outside Locus. */
export function exportHref(dest: string, ctx: ExportContext): string | null {
  const ref = parseDestination(dest);
  if (!ref) return null;
  if (ref.pathKind === 'web') return dest;
  // A heading of this note stays an in-page link.
  if (!ref.path) return ref.loc.heading ? `#${ref.loc.heading}` : null;
  const path = ref.pathKind === 'external' ? ref.path : ctx.root.replace(/[\\/]+$/, '') + resolvePath(ref, ctx.notePath);
  const url = fileUrl(path);
  // A PDF opens at its page; a note at its heading. Nothing else carries its place through a link.
  if (fileKind(path) === 'pdf' && ref.loc.page) return `${url}#page=${ref.loc.page}`;
  if (fileKind(path) === 'markdown' && ref.loc.heading) return `${url}#${ref.loc.heading}`;
  return url;
}

/** Every picture the note shows, as a data URI, so the export is one self-contained file. */
async function imagesOf(md: string, ctx: ExportContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const link of extractLinks(md)) {
    if (!link.image || out.has(link.dest)) continue;
    const ref = parseDestination(link.dest);
    if (!ref) continue;
    if (ref.pathKind === 'web') {
      out.set(link.dest, link.dest);
      continue;
    }
    const path = ref.pathKind === 'external' ? ref.path : resolvePath(ref, ctx.notePath);
    const type = MIME[extname(path)];
    if (!type) continue;
    try {
      const bytes = ref.rev
        ? await git.readBlob(ctx.root, path, ref.rev)
        : await fs.readFile(ref.pathKind === 'external' ? path : join(ctx.root, path.slice(1)));
      if (bytes.length > MAX_IMAGE) continue;
      out.set(link.dest, `data:${type};base64,${Buffer.from(bytes).toString('base64')}`);
    } catch {
      /* a picture that can't be read is left out */
    }
  }
  return out;
}

/** The whole page for one note: markdown in, one HTML document out. */
export async function noteToPage(markdown: string, ctx: ExportContext, workspaceName: string): Promise<{ html: string; title: string }> {
  const md = splitNoteId(markdown).body;
  const images = await imagesOf(md, ctx);
  const title = stem(ctx.notePath);
  const body = renderMarkdown(md, {
    href: (dest) => exportHref(dest, ctx),
    img: (dest) => images.get(dest) ?? null,
    headingId: slugify,
  });
  const when = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return { html: buildPage({ title, body, note: `${workspaceName} · ${title} · exported ${when}` }), title };
}
