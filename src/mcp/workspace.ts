// Workspace access for the MCP server: locating the workspace, reading files at any version,
// building references and checking them (the same rules the app uses).
import { promises as fs } from 'node:fs';
import { basename as pathBase, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  defaultLabel,
  fileKind,
  formatReference,
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
import { findQuote } from '../core/quote';
import { mapLines } from '../core/remap';
import * as git from '../main/git';
import { readPdf, readWorkbook, type PdfPage } from './reader';

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
  heading?: string;
  time?: string;
  version?: string;
  notePath?: string;
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
      for (const p of candidates) {
        const m = findQuote(p.runs, quote);
        if (m) {
          hit = { page: p, rect: m.rect };
          break;
        }
      }
      if (!hit) throw new Error(`Couldn't find the quote ${page ? `on page ${page}` : 'anywhere'} in ${path}. Quote the text exactly as it appears (read_file shows it).`);
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
    if (!ref.sheet && parseA1Range(ref.range)) ref.sheet = wb.sheets[0]?.name;
    loc.sheet = ref;
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
    const sha = await git.ensureVersion(ws.root, path, ws.managed);
    if (sha) {
      reference.at = sha.slice(0, 10);
      version = `live, recorded at ${sha.slice(0, 10)}`;
    }
  }
  const label = req.label?.trim() || defaultLabel(path, loc, pageLabel);
  return { markdown: formatReference(label, reference, quote), location: describe(loc), version, notes };
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
      checks.push({ ...base, ...(await checkReference(ws, notePath, ref, link.title, head)) });
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
  if (!rev && !ref.at && ws.isRepo && fileKind(path) !== 'markdown') warnings.push('No version recorded (at=): the app cannot follow this file through changes');

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

export async function writeNote(ws: Workspace, path: string, content: string): Promise<string> {
  const p = wsPath(ws, path);
  if (!/\.md$/i.test(p)) throw new Error('Notes must be .md files');
  const full = absPath(ws, p);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return p;
}

export { git };
