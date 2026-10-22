// Rewrites reference paths when files or notes move, so links keep working (link-format §6).
import { formatDestination, parseDestination, resolvePath } from './link.ts';
import { extractLinks } from './mdlinks.ts';

export interface PathChange {
  /** Root-relative path of a file or folder before the move. */
  from: string;
  to: string;
}

/** Applies file/folder moves to a root-relative path. */
export function movedPath(path: string, changes: PathChange[]): string | null {
  for (const c of changes) {
    if (path === c.from) return c.to;
    if (path.startsWith(c.from + '/')) return c.to + path.slice(c.from.length);
  }
  return null;
}

/**
 * Updates the links in a note after moves. `notePath` is where the note was; `newNotePath`
 * is where it is now (the same when only targets moved). Live links follow their target;
 * pinned (rev=) links keep their path, because it names the file as it was in that version.
 * Relative links in a moved note become root-relative so they keep pointing at the same file.
 */
export function rewriteLinks(md: string, notePath: string, newNotePath: string, changes: PathChange[]): { text: string; count: number } {
  const noteMoved = notePath !== newNotePath;
  let out = '';
  let last = 0;
  let count = 0;
  for (const link of extractLinks(md)) {
    const ref = parseDestination(link.dest);
    if (!ref || ref.pathKind === 'web' || ref.pathKind === 'external' || !ref.path) continue;
    const resolved = resolvePath(ref, notePath);
    const target = ref.rev ? null : movedPath(resolved, changes);
    if (!target && !(noteMoved && ref.pathKind === 'relative')) continue;
    const dest = formatDestination({ ...ref, path: target ?? resolved, pathKind: 'root' });
    out += md.slice(last, link.destFrom) + dest;
    last = link.destTo;
    count++;
  }
  return { text: out + md.slice(last), count };
}
