// The check that runs after a version is saved: every live link whose file has changed since it
// was cited either follows the file by itself (the cited place only moved) or needs a person
// (the cited place really changed). Nothing here writes anything; see App for what is done with it.
import { basename, fileKind, formatDestination, formatReference, parseDestination, type Location, type Reference } from '../core/link';
import { isCanvas } from '../core/canvas';
import { findSlide, readSlides } from '../core/slides';
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

/**
 * Answers held for a moment. A note usually cites the same file several times, and each question
 * about it costs a git call, so one run of the check would otherwise ask the same thing ten times.
 */
const answers = new Map<string, { at: number; value: Promise<unknown> }>();

function ask<T>(key: string, get: () => Promise<T>): Promise<T> {
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.value as Promise<T>;
  const value = get();
  if (answers.size > 400) answers.clear();
  answers.set(key, { at: Date.now(), value });
  return value;
}

const exists = (path: string, rev?: string) => ask(`e|${path}|${rev ?? ''}`, () => api.exists(path, rev).catch(() => false));
const changed = (path: string, rev: string) => ask(`c|${path}|${rev}`, () => api.fileChangedSince(path, rev).catch(() => false));
const moved = (path: string, at: string) => ask(`m|${path}|${at}`, () => api.findMoved(path, at).catch(() => null));
const hunks = (path: string, at: string) => ask(`h|${path}|${at}`, () => api.diffHunks(path, at).catch(() => []));
const bytes = (path: string, rev?: string) =>
  ask(`b|${path}|${rev ?? ''}`, () => (rev ? api.readFile(path, rev) : loadBytes({ path, external: false })).catch(() => null));
const slidesIn = (path: string) =>
  ask(`s|${path}`, async () => {
    const data = await bytes(path);
    return data ? readSlides(data).catch(() => null) : null;
  });

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
  if (!(await exists(path))) {
    const to = await moved(path, at);
    if (!to) {
      if (!(await exists(path, at))) return null; // never existed: a broken link, not ours to fix
      return { ...base, verdict: 'deleted', next: { ...ref, rev: at, at: undefined }, reason: 'the file was deleted' };
    }
    now = to;
    const [was, is] = await Promise.all([bytes(path, at), bytes(to)]);
    if (was && is && sameBytes(was, is)) return { ...base, verdict: 'follow', next: latest(ref.loc, to), reason: 'the file was moved' };
    return { ...base, verdict: 'review', next: latest(ref.loc, to), reason: 'the file was moved and edited' };
  }
  if (!(await changed(path, at))) return null;

  const { loc } = ref;
  const whole = !loc.lines && loc.page === undefined && loc.slide === undefined && !loc.sheet && loc.time === undefined && !loc.rect;
  if (whole) return { ...base, verdict: 'follow', next: latest(loc), reason: 'the whole file is cited' };

  if (loc.lines) {
    const m = mapLines(await hunks(path, at), loc.lines.start, loc.lines.end);
    const next = latest({ ...loc, lines: { start: m.start, end: m.end } });
    if (m.status === 'same') return { ...base, verdict: 'follow', next, reason: 'the cited lines are untouched' };
    if (m.status === 'moved') return { ...base, verdict: 'follow', next, reason: 'the cited lines only moved' };
    return { ...base, verdict: 'review', next, reason: m.status === 'gone' ? 'the cited lines were deleted' : 'the cited lines were edited' };
  }

  if (kind === 'pdf' && loc.page !== undefined) {
    if (cite.quote) {
      const found = await bytes(now)
        .then((data) => (data ? locateQuote(data, cite.quote!, loc.page!) : null))
        .catch(() => null);
      if (found) return { ...base, verdict: 'follow', next: latest({ ...loc, page: found.page, viewrect: loc.viewrect ? found.rect : undefined }), reason: found.page === loc.page ? 'the quoted text is still there' : `the quoted text is now on page ${found.page}` };
      return { ...base, verdict: 'review', next: latest(loc), reason: 'the quoted text was reworded or removed' };
    }
    return { ...base, verdict: 'review', next: latest(loc), reason: loc.viewrect ? 'the PDF changed and the area has no quote to check' : 'the PDF changed' };
  }

  if (kind === 'sheet' && loc.sheet) {
    const [was, is] = await Promise.all([
      bytes(path, at).then((d) => (d ? cellText(d, path, loc) : null)).catch(() => null),
      bytes(now).then((d) => (d ? cellText(d, now, loc) : null)).catch(() => null),
    ]);
    if (is !== null && !loc.sheet.sheet) return { ...base, verdict: 'follow', next: latest(loc), reason: 'the named range still resolves' };
    if (was !== null && was === is) return { ...base, verdict: 'follow', next: latest(loc), reason: 'the cited cells hold the same values' };
    return { ...base, verdict: 'review', next: latest(loc), reason: is === null ? 'the cited cells are gone' : 'a value in the cited cells changed' };
  }

  if (kind === 'slides' && loc.slide !== undefined) {
    // A slide link is a number, and numbers move when a slide is inserted. Quoted words do not.
    if (cite.quote) {
      const slides = await slidesIn(now);
      const on = slides ? findSlide(slides, cite.quote, loc.slide) : null;
      if (on)
        return {
          ...base,
          verdict: 'follow',
          next: latest({ ...loc, slide: on }),
          reason: on === loc.slide ? 'the quoted text is still on this slide' : `the quoted text is now on slide ${on}`,
        };
      return { ...base, verdict: 'review', next: latest(loc), reason: 'the quoted text is no longer in the deck' };
    }
    return { ...base, verdict: 'review', next: latest(loc), reason: loc.viewrect ? 'the deck changed and the box has no quote to check' : `${basename(path)} changed` };
  }

  return { ...base, verdict: 'review', next: latest(loc), reason: `${basename(path)} changed` };
}

/** How many links are checked at once: enough to be quick, few enough not to flood git. */
const AT_ONCE = 16;

/**
 * Which files have changed since each version the links were cited from: one question to git per
 * version, instead of asking about every link in turn. Most links cite a file nothing has touched,
 * and those are then settled without a single call of their own.
 */
async function filesTouchedSince(cites: Citation[]): Promise<Map<string, Set<string>>> {
  const revs = new Set<string>();
  for (const cite of cites) {
    const ref = parseDestination(cite.dest);
    if (ref?.at && !ref.rev) revs.add(ref.at);
  }
  const out = new Map<string, Set<string>>();
  await Promise.all(
    [...revs].map(async (rev) => {
      const changes = await api.changesSince(rev).catch(() => null);
      if (!changes) return; // could not tell: every link citing this version is checked the long way
      const paths = new Set<string>();
      for (const c of changes) {
        paths.add(c.path);
        if (c.from) paths.add(c.from);
      }
      out.set(rev, paths);
    }),
  );
  return out;
}

/** Whether anything has happened to this link's file since it was cited. */
function worthChecking(cite: Citation, touched: Map<string, Set<string>>): boolean {
  const ref = parseDestination(cite.dest);
  if (!ref?.at || ref.rev) return true; // pinned or odd: checkLink says no, cheaply
  const paths = touched.get(ref.at);
  return !paths || paths.has(cite.path);
}

/**
 * Checks every live link in the workspace against the latest saved version. The user is waiting
 * on this with a version just saved, so the links are checked together rather than one at a time,
 * and the same link in two notes is only worked out once.
 */
export async function checkLinks(head: string): Promise<CheckedLink[]> {
  answers.clear(); // a fresh look: what was asked during the last check may have changed since
  const cites = await api.citations().catch(() => [] as Citation[]);
  const touched = await filesTouchedSince(cites);
  const keyOf = (c: Citation) => `${c.path}|${c.dest}|${c.quote ?? ''}`;
  const first = new Map<string, Citation>();
  for (const cite of cites) if (!first.has(keyOf(cite)) && worthChecking(cite, touched)) first.set(keyOf(cite), cite);
  const keys = [...first.keys()];
  const done = new Map<string, CheckedLink | null>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
      while (next < keys.length) {
        const key = keys[next++];
        done.set(key, await checkLink(first.get(key)!, head).catch(() => null));
      }
    }),
  );
  const out: CheckedLink[] = [];
  for (const cite of cites) {
    const r = done.get(keyOf(cite));
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
