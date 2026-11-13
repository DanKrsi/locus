// The check that runs after a version is saved: every live link whose file has changed since it
// was cited either follows the file by itself (the cited place only moved) or needs a person
// (the cited place really changed). Nothing here writes anything; see App for what is done with it.
import { basename, fileKind, formatDestination, formatReference, parseDestination, type Location, type Reference } from '../core/link';
import { isCanvas } from '../core/canvas';
import { mapLines } from '../core/remap';
import { renumberLabel } from '../core/upkeep';
import type { Citation, NoteLinkUpdate } from '../shared/api';
import { api } from './api';
import { loadBytes } from './files';
import { locateQuote } from './viewers/pdf';
import { cellKey, loadWorkbook, resolveSheetRef } from './viewers/sheetModel';

export interface CheckedLink {
  cite: Citation;
  ref: Reference;
  /**
   * follow: the cited place is unchanged or only moved, and `next` is where it is now.
   * deleted: the file is gone from the workspace; the link stays on the version it was cited from.
   * review: what was cited changed; `next` is the proposed place in the latest version.
   */
  verdict: 'follow' | 'deleted' | 'review';
  next: Reference;
  /** What happened, in a few words ("lines edited", "quote not found"). */
  reason: string;
}

const short = (sha: string) => sha.slice(0, 10);

/** The text of the cited cells, row by row, or null when the range can't be found. */
async function cellText(data: Uint8Array, path: string, loc: Location): Promise<string | null> {
  if (!loc.sheet) return null;
  const wb = await loadWorkbook(data, basename(path));
  const hit = resolveSheetRef(wb, loc.sheet);
  if (!hit) return null;
  const sheet = wb.sheets[hit.sheet];
  const rows: string[] = [];
  for (let r = hit.box.top; r <= Math.min(hit.box.bottom, sheet.rows); r++) {
    const row: string[] = [];
    for (let c = hit.box.left; c <= Math.min(hit.box.right, sheet.cols); c++) row.push(sheet.cells.get(cellKey(r, c))?.text ?? '');
    rows.push(row.join('\t'));
  }
  return rows.join('\n');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Checks one live link against the latest saved version (`head`). Null when there is nothing to do. */
export async function checkLink(cite: Citation, head: string): Promise<CheckedLink | null> {
  const ref = parseDestination(cite.dest);
  if (!ref || ref.rev || !ref.at || ref.pathKind === 'external' || ref.pathKind === 'web') return null;
  if (head.startsWith(ref.at) || ref.at.startsWith(short(head))) return null;
  const path = cite.path;
  const kind = fileKind(path);
  // Notes and flowcharts are read as they are now; a link to one has no place that goes stale.
  if (kind === 'markdown' || isCanvas(path)) return null;
  const at = ref.at;
  const base = { cite, ref };
  const latest = (loc: Location, to = path): Reference => ({ ...ref, path: to, pathKind: 'root', loc, at: short(head), rev: undefined });

  let now = path;
  if (!(await api.exists(path).catch(() => false))) {
    const moved = await api.findMoved(path, at).catch(() => null);
    if (!moved) {
      if (!(await api.exists(path, at).catch(() => false))) return null; // never existed: a broken link, not ours to fix
      return { ...base, verdict: 'deleted', next: { ...ref, rev: at, at: undefined }, reason: 'the file was deleted' };
    }
    now = moved;
    const [was, is] = await Promise.all([api.readFile(path, at), api.readFile(moved)]);
    if (sameBytes(was, is)) return { ...base, verdict: 'follow', next: latest(ref.loc, moved), reason: 'the file was moved' };
    return { ...base, verdict: 'review', next: latest(ref.loc, moved), reason: 'the file was moved and edited' };
  }
  if (!(await api.fileChangedSince(path, at).catch(() => false))) return null;

  const { loc } = ref;
  const whole = !loc.lines && loc.page === undefined && loc.slide === undefined && !loc.sheet && loc.time === undefined && !loc.rect;
  if (whole) return { ...base, verdict: 'follow', next: latest(loc), reason: 'the whole file is cited' };

  if (loc.lines) {
    const m = mapLines(await api.diffHunks(path, at).catch(() => []), loc.lines.start, loc.lines.end);
    const next = latest({ ...loc, lines: { start: m.start, end: m.end } });
    if (m.status === 'same') return { ...base, verdict: 'follow', next, reason: 'the cited lines are untouched' };
    if (m.status === 'moved') return { ...base, verdict: 'follow', next, reason: 'the cited lines only moved' };
    return { ...base, verdict: 'review', next, reason: m.status === 'gone' ? 'the cited lines were deleted' : 'the cited lines were edited' };
  }

  if (kind === 'pdf' && loc.page !== undefined) {
    if (cite.quote) {
      const found = await loadBytes({ path: now, external: false })
        .then((data) => locateQuote(data, cite.quote!, loc.page!))
        .catch(() => null);
      if (found) return { ...base, verdict: 'follow', next: latest({ ...loc, page: found.page, viewrect: loc.viewrect ? found.rect : undefined }), reason: found.page === loc.page ? 'the quoted text is still there' : `the quoted text is now on page ${found.page}` };
      return { ...base, verdict: 'review', next: latest(loc), reason: 'the quoted text was reworded or removed' };
    }
    return { ...base, verdict: 'review', next: latest(loc), reason: loc.viewrect ? 'the PDF changed and the area has no quote to check' : 'the PDF changed' };
  }

  if (kind === 'sheet' && loc.sheet) {
    const [was, is] = await Promise.all([
      api.readFile(path, at).then((d) => cellText(d, path, loc)).catch(() => null),
      loadBytes({ path: now, external: false }).then((d) => cellText(d, now, loc)).catch(() => null),
    ]);
    if (is !== null && !loc.sheet.sheet) return { ...base, verdict: 'follow', next: latest(loc), reason: 'the named range still resolves' };
    if (was !== null && was === is) return { ...base, verdict: 'follow', next: latest(loc), reason: 'the cited cells hold the same values' };
    return { ...base, verdict: 'review', next: latest(loc), reason: is === null ? 'the cited cells are gone' : 'a value in the cited cells changed' };
  }

  return { ...base, verdict: 'review', next: latest(loc), reason: `${basename(path)} changed` };
}

/** Checks every live link in the workspace against the latest saved version. */
export async function checkLinks(head: string): Promise<CheckedLink[]> {
  const cites = await api.citations().catch(() => [] as Citation[]);
  const seen = new Map<string, Promise<CheckedLink | null>>();
  const out: CheckedLink[] = [];
  for (const cite of cites) {
    // The same link in the same note (or in two notes) is checked once and decided once.
    const key = `${cite.path}|${cite.dest}|${cite.quote ?? ''}`;
    if (!seen.has(key)) seen.set(key, checkLink(cite, head).catch(() => null));
    const r = await seen.get(key)!;
    if (r) out.push({ ...r, cite });
  }
  return out;
}

/** The rewrite that moves a link to `next` (renumbering a label that names the old place). */
export function updateFor(link: CheckedLink, next: Reference = link.next): NoteLinkUpdate {
  const newLabel = renumberLabel(link.cite.label, link.ref.loc, next.loc);
  return { note: link.cite.note, dest: link.cite.dest, label: link.cite.label, newDest: bare(formatDestination(next)), ...(newLabel !== link.cite.label ? { newLabel } : {}) };
}

/** The rewrite that keeps a link on the version it was cited from, for good. */
export function pinFor(link: CheckedLink): NoteLinkUpdate {
  return { note: link.cite.note, dest: link.cite.dest, label: link.cite.label, newDest: bare(formatDestination({ ...link.ref, rev: link.ref.at, at: undefined })) };
}

const bare = (dest: string) => (dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1) : dest);

export { formatReference };
