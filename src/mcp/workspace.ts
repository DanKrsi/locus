// Workspace access for the MCP server: locating the workspace, reading files at any version,
// building references and checking them (the same rules the app uses).
import { promises as fs } from 'node:fs';
import { basename as pathBase, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  defaultLabel,
  embedKind,
  fileKind,
  formatReference,
  isEmbed,
  isLegacyOffice,
  normalizePath,
  parseA1Range,
  parseDestination,
  parseSheetRef,
  resolvePath,
  slugify,
  type Location,
  type Reference,
} from '../core/link';
import { extractLinks } from '../core/mdlinks';
import { isCanvas, parseCanvas, serializeCanvas, type Shape } from '../core/canvas';
import { layoutDraft, type DraftArrow, type DraftLoop } from '../core/flowLayout';
import { findQuote } from '../core/quote';
import { mapLines } from '../core/remap';
import * as git from '../main/git';
import { NO_TEXT_LAYER, readPdf, readWorkbook, type PdfPage } from './reader';
import { findShape, findSlide, readDeck, readSlides } from '../core/slides';
import { findParagraphs, quoteIn, readWord } from '../core/word';
import { addNoteId, joinNoteId, newNoteId, readNoteId, splitNoteId, withLinkNoteId } from '../core/noteid';

export interface Workspace {
  root: string;
  name: string;
  managed: boolean;
  isRepo: boolean;
}

async function exists(p: string) {
  return fs.access(p).then(() => true, () => false);
}

export async function openWorkspace(dir?: string): Promise<Workspace> {
  const start = resolve(dir || process.env.LOCUS_WORKSPACE || process.cwd());
  if (!(await exists(start))) throw new Error(`Folder not found: ${start}`);
  let root: string | null = null;
  for (let d = start; ; ) {
    if (await exists(join(d, '.locus'))) {
      root = d;
      break;
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  root ??= (await git.topLevel(start)) ?? start;
  root = resolve(root);
  let name = pathBase(root);
  let managed = false;
  try {
    const meta = JSON.parse(await fs.readFile(join(root, '.locus', 'workspace.json'), 'utf8'));
    name = meta.name ?? name;
    managed = !!meta.managed;
  } catch {
    /* not set up by the app yet */
  }
  return { root, name, managed, isRepo: await git.isRepo(root) };
}

/** Initialises version history the same way the app does when it opens a plain folder. */
export async function initWorkspace(dir?: string): Promise<Workspace> {
  const ws = await openWorkspace(dir);
  const metaFile = join(ws.root, '.locus', 'workspace.json');
  if (await exists(metaFile)) return ws;
  const managed = !ws.isRepo;
  await fs.mkdir(join(ws.root, '.locus'), { recursive: true });
  await fs.writeFile(metaFile, JSON.stringify({ format: 1, name: ws.name, managed }, null, 2) + '\n');
  await fs.writeFile(join(ws.root, '.locus', '.gitignore'), 'cache/\n');
  if (!ws.isRepo) {
    await git.init(ws.root);
    await git.commitAll(ws.root, 'Workspace created');
  }
  return openWorkspace(ws.root);
}

/** Accepts "docs/a.pdf", "/docs/a.pdf" or an absolute path inside the workspace. */
export function wsPath(ws: Workspace, path: string): string {
  let p = path.replace(/\\/g, '/');
  if (isAbsolute(path) && /^[A-Za-z]:|^\/\//.test(path)) {
    const rel = relative(ws.root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path} is outside the workspace ${ws.root}`);
    p = rel.replace(/\\/g, '/');
  }
  return normalizePath(p);
}

function absPath(ws: Workspace, path: string): string {
  const full = resolve(ws.root, '.' + path);
  const rel = relative(ws.root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${path}`);
  return full;
}

export async function readBytes(ws: Workspace, path: string, rev?: string): Promise<Uint8Array> {
  if (rev) return git.readBlob(ws.root, path, rev);
  return fs.readFile(absPath(ws, path));
}

export async function fileExists(ws: Workspace, path: string, rev?: string): Promise<boolean> {
  if (rev) return ws.isRepo && git.blobExists(ws.root, path, rev);
  return exists(absPath(ws, path));
}

export async function listFiles(ws: Workspace, rev?: string): Promise<string[]> {
  if (!ws.isRepo) {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.locus') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push('/' + relative(ws.root, full).replace(/\\/g, '/'));
      }
    };
    await walk(ws.root);
    return out.sort();
  }
  const files = rev ? await git.listTree(ws.root, rev) : await git.listWorking(ws.root);
  return files.filter((f) => !f.startsWith('/.locus/')).sort();
}

const pdfCache = new Map<string, Promise<PdfPage[]>>();

export async function pdfPages(ws: Workspace, path: string, rev?: string): Promise<PdfPage[]> {
  let key = `${ws.root}|${path}|${rev ?? ''}`;
  if (!rev) {
    const st = await fs.stat(absPath(ws, path));
    key += `|${st.mtimeMs}`;
  }
  let p = pdfCache.get(key);
  if (!p) {
    p = readBytes(ws, path, rev).then(readPdf);
    pdfCache.set(key, p);
    p.catch(() => pdfCache.delete(key));
  }
  return p;
}

// ---------- Making references ----------

export interface ReferenceRequest {
  path: string;
  label?: string;
  lines?: [number, number];
  page?: number;
  quote?: string;
  highlight?: boolean;
  range?: string;
  slide?: number;
  /** Word: first and last paragraph (core/word numbering). */
  paragraphs?: [number, number];
  heading?: string;
  time?: string;
  version?: string;
  notePath?: string;
  /** Show the place in the note (a picture of a PDF page or box, or a slide; a table of cells) instead of linking to it. */
  embed?: boolean;
}

export interface ReferenceResult {
  markdown: string;
  location: string;
  version: string;
  notes: string[];
}

export async function makeReference(ws: Workspace, req: ReferenceRequest): Promise<ReferenceResult> {
  const path = wsPath(ws, req.path);
  const kind = fileKind(path);
  const pinned = req.version && req.version !== 'live' ? await git.resolveRev(ws.root, req.version) : undefined;
  if (!(await fileExists(ws, path, pinned))) throw new Error(`${path} doesn't exist${pinned ? ' in that version' : ''}`);
  const notes: string[] = [];
  if (req.embed && !embedKind(path)) throw new Error(`${path} can't be shown in a note: only PDFs, Word documents, slide decks and spreadsheets can (leave out embed to link to it)`);
  if (isLegacyOffice(path) && (req.slide || req.paragraphs || req.quote))
    throw new Error(`${path} is in the old binary Office format: it can only be linked as a whole file (leave out slide, paragraphs and quote). Saved as .docx or .pptx it can be read and cited inside.`);
  const loc: Location = {};
  let quote = req.quote?.trim() || undefined;
  let pageLabel: string | undefined;

  if (kind === 'pdf') {
    const pages = await pdfPages(ws, path, pinned);
    let page = req.page;
    if (page !== undefined && (page < 1 || page > pages.length)) throw new Error(`${path} has ${pages.length} pages; page ${page} doesn't exist`);
    if (quote) {
      const candidates = page ? [pages[page - 1]] : pages;
      let hit: { page: PdfPage; rect: import('../core/link').Rect } | null = null;
      const elsewhere: number[] = [];
      for (const p of candidates) {
        const m = findQuote(p.runs, quote);
        if (!m) continue;
        if (!hit) hit = { page: p, rect: m.rect };
        else if (elsewhere.length < 8) elsewhere.push(p.page);
        else break;
      }
      if (!hit) {
        if (pages.every((p) => !p.runs.length)) throw new Error(NO_TEXT_LAYER);
        throw new Error(`Couldn't find the quote ${page ? `on page ${page}` : 'anywhere'} in ${path}. Quote the text exactly as it appears (read_file shows it).`);
      }
      // The same words on more than one page (a summary and the body, a running header): the
      // first is cited, and Claude is told, so it can choose with page instead of not knowing.
      if (elsewhere.length) notes.push(`This quote also appears on page${elsewhere.length === 1 ? '' : 's'} ${elsewhere.join(', ')}; page ${hit.page.page} was cited. Pass page=<n> to cite another one.`);
      page = hit.page.page;
      if (req.highlight) loc.viewrect = roundRect(hit.rect);
    } else if (req.highlight) {
      notes.push('highlight needs a quote to know what to box; cited the whole page instead.');
    }
    loc.page = page ?? 1;
    const label = pages[loc.page - 1]?.label;
    if (label && label !== String(loc.page)) pageLabel = label;
  } else if (kind === 'code' || kind === 'markdown') {
    const text = new TextDecoder().decode(await readBytes(ws, path, pinned));
    const lines = text.split(/\r?\n/);
    if (kind === 'markdown' && req.heading) {
      const slug = slugify(req.heading.replace(/^#+\s*/, ''));
      const found = lines.some((l) => {
        const m = l.match(/^#{1,6}\s+(.*)$/);
        return m && slugify(m[1]) === slug;
      });
      if (!found) throw new Error(`No heading "${req.heading}" in ${path}`);
      loc.heading = slug;
    } else if (req.lines) {
      const [a, b] = req.lines;
      if (a < 1 || b < a || b > lines.length) throw new Error(`${path} has ${lines.length} lines; L${a}-L${b} is out of range`);
      loc.lines = { start: a, end: b };
      if (quote && !lines.slice(a - 1, b).join('\n').replace(/\s+/g, ' ').includes(quote.replace(/\s+/g, ' '))) {
        notes.push('The quote is not inside the cited lines; check the line numbers.');
      }
    } else if (quote) {
      const found = findInLines(lines, quote);
      if (!found) throw new Error(`Couldn't find the quoted code in ${path}`);
      loc.lines = found;
    }
  } else if (kind === 'sheet') {
    if (!req.range) throw new Error('Spreadsheet references need a range, e.g. "\'Load cases\'!B4:D12" or a named range');
    const ref = parseSheetRef(req.range);
    const wb = await readWorkbook(await readBytes(ws, path, pinned), path);
    if (ref.sheet && !wb.sheets.some((s) => s.name === ref.sheet)) throw new Error(`No sheet named "${ref.sheet}". Sheets: ${wb.sheets.map((s) => s.name).join(', ')}`);
    if (!ref.sheet && !parseA1Range(ref.range) && !wb.names.some((n) => n.name.toLowerCase() === ref.range.toLowerCase())) {
      throw new Error(`"${ref.range}" isn't a cell range or a named range in ${path}`);
    }
    // Name the sheet only when there is a choice; single-sheet files (like CSV) stay unqualified.
    if (!ref.sheet && parseA1Range(ref.range) && wb.sheets.length > 1) ref.sheet = wb.sheets[0]?.name;
    loc.sheet = ref;
  } else if (kind === 'doc' && !isLegacyOffice(path)) {
    const { paragraphs } = await readWord(await readBytes(ws, path, pinned));
    if (req.paragraphs) {
      const [a, b] = req.paragraphs;
      if (a < 1 || b < a || b > paragraphs.length) throw new Error(`${path} has ${paragraphs.length} paragraphs; paragraphs ${a}-${b} are out of range`);
      loc.para = { start: a, end: b };
      if (quote && !quoteIn(paragraphs, loc.para, quote)) {
        const at = findParagraphs(paragraphs, quote, a);
        notes.push(at ? `The quote is in paragraph ${at.start}${at.end !== at.start ? `-${at.end}` : ''}, not in the paragraphs given; leave out paragraphs to cite where it is.` : 'The quote is not in the document; check it against read_file.');
      }
    } else if (quote) {
      const found = findParagraphs(paragraphs, quote);
      if (!found) throw new Error(`Couldn't find the quote in ${path}. Quote the text exactly as read_file shows it.`);
      loc.para = found;
      const again = findParagraphs(paragraphs.slice(found.end), quote);
      if (again) notes.push(`This quote also appears in paragraph ${again.start + found.end}; paragraph ${found.start} was cited. Pass paragraphs to cite another one.`);
    }
    if (req.embed && !loc.para) throw new Error('A picture of a Word document shows paragraphs: give paragraphs or a quote');
  } else if (kind === 'slides') {
    const deck = await readDeck(await readBytes(ws, path, pinned));
    const slides = deck.map((s) => s.text);
    let n = req.slide;
    if (n !== undefined && (n < 1 || n > slides.length)) throw new Error(`${path} has ${slides.length} slides; slide ${n} doesn't exist`);
    if (quote) {
      const on = findSlide(slides, quote, n ?? 1);
      if (!on) {
        const inNotes = deck.findIndex((s) => s.notes.replace(/\s+/g, ' ').toLowerCase().includes(quote.replace(/\s+/g, ' ').toLowerCase()));
        if (inNotes >= 0) throw new Error(`That quote is in the speaker notes of slide ${inNotes + 1}, not on the slide. Notes can't be quoted in a link; cite slide=${inNotes + 1} without a quote.`);
        throw new Error(n ? `Couldn't find the quote on slide ${n} or any other slide of ${path}` : `Couldn't find the quote on any slide of ${path}`);
      }
      if (n && on !== n) notes.push(`The quote is on slide ${on}, not slide ${n}; slide ${on} was cited.`);
      n = on;
      const again = findSlide(slides.slice(on), quote);
      if (again) notes.push(`This quote also appears on slide ${again + on}; slide ${on} was cited. Pass slide to cite another one.`);
    }
    if (!n) throw new Error('Slide references need slide (a number) or a quote from the slide');
    loc.slide = n;
    if (req.highlight) {
      const shape = quote ? findShape(deck[n - 1], quote) : null;
      if (shape) loc.viewrect = roundRect(shape.box);
      else notes.push(quote ? "highlight: the text box holding the quote couldn't be placed (it may sit in a group or a table); cited the whole slide instead." : 'highlight needs a quote to know what to box; cited the whole slide instead.');
    }
  } else if (kind === 'media' && req.time) {
    const ref = parseDestination(`/x.mp4#t=${req.time}`);
    loc.time = ref?.loc.time;
  }

  const reference: Reference = { path, pathKind: 'root', loc, extra: [] };
  let version = 'none (workspace has no version history yet; call init_workspace)';
  if (pinned) {
    reference.rev = pinned.slice(0, 10);
    version = `pinned to ${pinned.slice(0, 10)}`;
  } else if (ws.isRepo) {
    if (kind === 'markdown' || isCanvas(path)) {
      // A link to a note records the note itself, so it survives the note being renamed or moved.
      const full = absPath(ws, path);
      const text = await fs.readFile(full, 'utf8');
      let id = readNoteId(path, text);
      if (!id) {
        id = newNoteId();
        const next = addNoteId(path, text, id);
        if (next !== text) await fs.writeFile(full, next, 'utf8');
        else id = undefined;
      }
      if (id) reference.extra = withLinkNoteId(reference.extra, id);
    }
    const sha = await git.ensureVersion(ws.root, path, ws.managed);
    if (sha) {
      reference.at = sha.slice(0, 10);
      version = `live, recorded at ${sha.slice(0, 10)}`;
    }
  }
  const label = req.label?.trim() || defaultLabel(path, loc, pageLabel);
  if (req.embed && kind === 'sheet' && !loc.sheet) throw new Error('A table in the note needs the cells it shows: give range');
  return { markdown: formatReference(label, reference, quote, !!req.embed), location: describe(loc), version, notes };
}

function roundRect(r: { x: number; y: number; w: number; h: number }) {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

function findInLines(lines: string[], quote: string): { start: number; end: number } | null {
  const q = quote.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!q.length) return null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(q[0])) continue;
    let ok = true;
    for (let k = 1; k < q.length; k++) {
      if (!lines[i + k]?.includes(q[k])) {
        ok = false;
        break;
      }
    }
    if (ok) return { start: i + 1, end: i + q.length };
  }
  return null;
}

export function describe(loc: Location): string {
  if (loc.slide) return loc.viewrect ? `area on slide ${loc.slide}` : `slide ${loc.slide}`;
  if (loc.para) return loc.para.end !== loc.para.start ? `paragraphs ${loc.para.start}-${loc.para.end}` : `paragraph ${loc.para.start}`;
  if (loc.viewrect) return `area on page ${loc.page}`;
  if (loc.page) return `page ${loc.page}`;
  if (loc.lines) return `lines ${loc.lines.start}-${loc.lines.end}`;
  if (loc.sheet) return `range ${loc.sheet.sheet ? loc.sheet.sheet + '!' : ''}${loc.sheet.range}`;
  if (loc.heading) return `section #${loc.heading}`;
  if (loc.time !== undefined) return `time ${loc.time}s`;
  return 'whole file';
}

// ---------- Validating notes ----------

export interface LinkCheck {
  line: number;
  label: string;
  dest: string;
  status: 'ok' | 'moved' | 'changed' | 'broken' | 'warning' | 'web';
  detail?: string;
}

export async function validateNote(ws: Workspace, notePath: string, markdown: string): Promise<LinkCheck[]> {
  const checks: LinkCheck[] = [];
  const head = ws.isRepo ? await git.head(ws.root) : null;
  for (const link of extractLinks(markdown)) {
    const base = { line: link.line, label: link.label, dest: link.dest };
    const ref = parseDestination(link.dest);
    if (!ref) {
      checks.push({ ...base, status: 'broken', detail: 'Empty link destination' });
      continue;
    }
    if (ref.pathKind === 'web') {
      checks.push({ ...base, status: 'web' });
      continue;
    }
    try {
      checks.push({ ...base, ...(await checkReference(ws, notePath, ref, link.title, head, link.image)) });
    } catch (e) {
      checks.push({ ...base, status: 'broken', detail: (e as Error).message });
    }
  }
  return checks;
}

async function checkReference(
  ws: Workspace,
  notePath: string,
  ref: Reference,
  title: string | undefined,
  head: string | null,
  /** Pictures shown in the note show the latest file on purpose, so they need no recorded version (views of a page, slide or cells still do). */
  image = false,
): Promise<Pick<LinkCheck, 'status' | 'detail'>> {
  if (ref.pathKind === 'external') {
    return (await exists(ref.path))
      ? { status: 'warning', detail: 'External file outside the workspace: it has no versions and is not shared with the workspace' }
      : { status: 'broken', detail: `External file not found: ${ref.path}` };
  }
  if (!ref.path) {
    if (!ref.loc.heading) return { status: 'ok' };
    const note = new TextDecoder().decode(await readBytes(ws, notePath).catch(() => new Uint8Array()));
    return headingExists(note, ref.loc.heading) ? { status: 'ok' } : { status: 'broken', detail: `No heading #${ref.loc.heading} in this note` };
  }
  const path = resolvePath(ref, notePath);
  const rev = ref.rev;
  const warnings: string[] = [];
  if (ref.pathKind === 'relative') warnings.push('Relative path: prefer a workspace-root path starting with "/" so moving the note never breaks it');
  const embedded = isEmbed(ref, image);
  if (embedded && fileKind(path) === 'sheet' && !ref.loc.sheet) return { status: 'broken', detail: 'A table shown in the note needs a range of cells' };
  if (!rev && !ref.at && ws.isRepo && (!image || embedded) && fileKind(path) !== 'markdown') warnings.push('No version recorded (at=): the app cannot follow this file through changes');

  if (!(await fileExists(ws, path, rev))) {
    if (!rev && ref.at && (await fileExists(ws, path, ref.at))) return { status: 'broken', detail: `${path} existed at ${ref.at} but is gone now (moved or deleted)` };
    return { status: 'broken', detail: `${path} not found${rev ? ` in version ${rev}` : ''}` };
  }
  const kind = fileKind(path);
  const { loc } = ref;
  let status: LinkCheck['status'] = 'ok';
  let detail: string | undefined;

  if (kind === 'pdf') {
    const pages = await pdfPages(ws, path, rev);
    if (loc.page && (loc.page < 1 || loc.page > pages.length)) return { status: 'broken', detail: `Page ${loc.page} doesn't exist (${pages.length} pages)` };
    if (title && loc.page && !findQuote(pages[loc.page - 1].runs, title)) {
      const elsewhere = pages.find((p) => findQuote(p.runs, title));
      status = 'warning';
      detail = elsewhere ? `Quote is on page ${elsewhere.page}, not page ${loc.page}` : `Quote not found on page ${loc.page}`;
    }
    if (loc.viewrect && loc.page) {
      const p = pages[loc.page - 1];
      const r = loc.viewrect;
      if (r.x < 0 || r.y < 0 || r.x + r.w > p.width + 1 || r.y + r.h > p.height + 1) {
        status = 'warning';
        detail = `viewrect is outside the page (${Math.round(p.width)}x${Math.round(p.height)} pt)`;
      }
    }
  } else if (kind === 'code' || kind === 'markdown') {
    const lines = new TextDecoder().decode(await readBytes(ws, path, rev)).split(/\r?\n/);
    if (loc.heading && kind === 'markdown') {
      if (!headingExists(lines.join('\n'), loc.heading)) return { status: 'broken', detail: `No heading #${loc.heading} in ${path}` };
    }
    if (loc.lines) {
      let { start, end } = loc.lines;
      if (!rev && ref.at && head && !head.startsWith(ref.at)) {
        const hunks = await git.diffHunks(ws.root, path, ref.at);
        const m = mapLines(hunks, start, end);
        if (m.status === 'moved') {
          status = 'moved';
          detail = `Lines moved to L${m.start}-L${m.end} since ${ref.at}; the app follows them`;
        } else if (m.status === 'changed' || m.status === 'gone') {
          status = 'changed';
          detail = m.status === 'gone' ? 'The cited lines were deleted since' : `Some cited lines were edited since ${ref.at} (now L${m.start}-L${m.end})`;
        }
        start = m.start;
        end = m.end;
      }
      if (end > lines.length) return { status: 'broken', detail: `L${loc.lines.start}-L${loc.lines.end} is past the end of the file (${lines.length} lines)` };
      if (title && status === 'ok') {
        const cited = lines.slice(start - 1, end).join(' ').replace(/\s+/g, ' ');
        if (!cited.includes(title.replace(/\s+/g, ' ').trim())) {
          status = 'warning';
          detail = 'Quote not found in the cited lines';
        }
      }
    }
  } else if (kind === 'doc' && !isLegacyOffice(path) && loc.para) {
    const { paragraphs } = await readWord(await readBytes(ws, path, rev));
    const where = (r: { start: number; end: number }) => (r.end !== r.start ? `paragraphs ${r.start}-${r.end}` : `paragraph ${r.start}`);
    if (loc.para.start < 1 || loc.para.end > paragraphs.length) return { status: 'broken', detail: `${where(loc.para)} doesn't exist (${paragraphs.length} paragraphs)` };
    if (title && !quoteIn(paragraphs, loc.para, title)) {
      const now = findParagraphs(paragraphs, title, loc.para.start);
      const live = !rev && !!ref.at;
      if (now && live) {
        status = 'moved';
        detail = `The quoted text is now in ${where(now)}; the app follows it`;
      } else if (now) {
        status = 'warning';
        detail = `Quote is in ${where(now)}, not ${where(loc.para)}`;
      } else {
        status = live ? 'changed' : 'warning';
        detail = live ? `The quoted text is no longer in ${path}` : `Quote not found in ${where(loc.para)}`;
      }
    }
  } else if (isLegacyOffice(path) && (loc.slide || loc.para)) {
    status = 'warning';
    detail = `${path} is in the old binary Office format: Locus opens it as a whole file, not at a slide or paragraph`;
  } else if (kind === 'slides' && loc.slide) {
    const slides = await readSlides(await readBytes(ws, path, rev));
    if (loc.slide > slides.length) return { status: 'broken', detail: `Slide ${loc.slide} doesn't exist (${slides.length} slides)` };
    // A drawn box quotes the words inside it in screen order, which need not be the file's order:
    // for a box, every word being on the slide is enough.
    const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const onSlide = (text: string) =>
      findSlide([text], title!) !== null || (!!loc.viewrect && title!.split(/\s+/).every((w) => !letters(w) || letters(text).includes(letters(w))));
    if (title && !onSlide(slides[loc.slide - 1])) {
      const near = slides.map((_, i) => i + 1).filter((n) => onSlide(slides[n - 1])).sort((a, b) => Math.abs(a - loc.slide!) - Math.abs(b - loc.slide!));
      const now = near[0] ?? null;
      const live = !rev && !!ref.at;
      if (now && live) {
        status = 'moved';
        detail = `The quoted text is now on slide ${now}; the app follows it`;
      } else if (now) {
        status = 'warning';
        detail = `Quote is on slide ${now}, not slide ${loc.slide}`;
      } else {
        status = live ? 'changed' : 'warning';
        detail = live ? `The quoted text is no longer in ${path}` : `Quote not found on slide ${loc.slide}`;
      }
    }
  } else if (kind === 'sheet' && loc.sheet) {
    const wb = await readWorkbook(await readBytes(ws, path, rev), path);
    const { sheet, range } = loc.sheet;
    if (sheet && !wb.sheets.some((s) => s.name === sheet)) return { status: 'broken', detail: `No sheet "${sheet}"` };
    if (!sheet && !parseA1Range(range) && !wb.names.some((n) => n.name.toLowerCase() === range.toLowerCase())) {
      return { status: 'broken', detail: `No named range "${range}"` };
    }
  }
  if (warnings.length && status === 'ok') {
    status = 'warning';
    detail = warnings.join('; ');
  }
  return { status, detail };
}

function headingExists(md: string, slug: string): boolean {
  return md.split(/\r?\n/).some((l) => {
    const m = l.match(/^#{1,6}\s+(.*)$/);
    return m && slugify(m[1]) === slug;
  });
}

/** Checks a note or a flowchart; in a flowchart, a link's line is the line of its box. */
export async function validateFile(ws: Workspace, path: string, text: string): Promise<LinkCheck[]> {
  if (!isCanvas(path)) return validateNote(ws, path, text);
  const doc = parseCanvas(text);
  const lines = text.split(/\r?\n/);
  const out: LinkCheck[] = [];
  for (const n of doc.nodes) {
    if (typeof n.text !== 'string') continue;
    const line = lines.findIndex((l) => l.includes(`"id":${JSON.stringify(n.id)}`)) + 1;
    for (const c of await validateNote(ws, path, n.text)) out.push({ ...c, line, label: `box "${n.id}": ${c.label}` });
  }
  return out;
}

export interface FlowchartBox {
  id: string;
  text?: string;
  shape?: Shape;
  loop?: string;
  cite?: ReferenceRequest[];
}

/** Lays out a flowchart from boxes, loops and arrows, with verified citations in the boxes. */
export async function writeFlowchart(
  ws: Workspace,
  req: { path: string; boxes: FlowchartBox[]; loops?: DraftLoop[]; arrows: DraftArrow[] },
): Promise<{ path: string; text: string }> {
  const p = wsPath(ws, req.path);
  if (!isCanvas(p)) throw new Error('Flowcharts must be .canvas files');
  const boxes = [];
  for (const b of req.boxes) {
    const links: string[] = [];
    for (const c of b.cite ?? []) {
      try {
        links.push((await makeReference(ws, { ...c, notePath: p })).markdown);
      } catch (e) {
        throw new Error(`Box "${b.id}": ${(e as Error).message}`);
      }
    }
    boxes.push({ id: b.id, shape: b.shape, loop: b.loop, text: [b.text?.trim() ?? '', ...links].filter(Boolean).join('\n') });
  }
  const text = serializeCanvas(await layoutDraft({ boxes, loops: req.loops, arrows: req.arrows }));
  const full = absPath(ws, p);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
  return { path: p, text };
}

/** A flowchart as readable text: loops, boxes (with the loop they sit in) and arrows. */
export function describeCanvas(path: string, text: string): string {
  const doc = parseCanvas(text);
  const groups = doc.nodes.filter((n) => n.type === 'group');
  const within = (n: { x: number; y: number; width: number; height: number }) =>
    groups
      .filter((g) => g !== n && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  const one = (s: string) => s.replace(/\s*\n\s*/g, ' / ');
  const out = [`Flowchart "${path.split('/').pop()}": ${doc.nodes.length - groups.length} boxes, ${groups.length} loop${groups.length === 1 ? '' : 's'}, ${doc.edges.length} arrows.`];
  if (groups.length) {
    out.push('', 'Loops:');
    for (const g of groups) out.push(`- ${g.id} "${g.label ?? ''}"${within(g) ? ` (in ${within(g)!.id})` : ''}`);
  }
  out.push('', 'Boxes:');
  for (const n of doc.nodes.filter((n) => n.type !== 'group')) {
    const loop = within(n);
    out.push(`- ${n.id} [${n.shape ?? 'process'}]${loop ? ` (in ${loop.id})` : ''}: ${one(n.text ?? n.file ?? n.url ?? '')}`);
  }
  out.push('', 'Arrows:');
  for (const e of doc.edges) out.push(`- ${e.fromNode} → ${e.toNode}${e.label ? ` "${e.label}"` : ''}${e.style === 'dashed' ? ' (dashed)' : ''}`);
  return out.join('\n');
}

export async function writeNote(ws: Workspace, path: string, content: string): Promise<string> {
  const p = wsPath(ws, path);
  if (isCanvas(p)) throw new Error('Use write_flowchart for .canvas flowcharts');
  if (!/\.md$/i.test(p)) throw new Error('Notes must be .md files');
  const full = absPath(ws, p);
  await fs.mkdir(dirname(full), { recursive: true });
  // A note that something links to keeps its hidden identity when it is rewritten.
  const old = await fs.readFile(full, 'utf8').catch(() => '');
  const id = splitNoteId(old).id;
  const { body } = splitNoteId(content);
  await fs.writeFile(full, joinNoteId(body, id, body.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
  return p;
}

export { git };
