// Parsing and formatting of references (see docs/spec/link-format.md).
// Pure functions with no Electron or DOM dependencies, so the MCP server can reuse them.

export type PathKind = 'root' | 'relative' | 'external' | 'web';

export interface SheetRef {
  sheet?: string;
  /** A1-style range ("B4:D12", "4:12", "F:H", "C7") or a named range. */
  range: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Location {
  lines?: { start: number; end: number };
  page?: number;
  /** PDF points from the page's top-left. */
  viewrect?: Rect;
  slide?: number;
  sheet?: SheetRef;
  heading?: string;
  /** Seconds. */
  time?: number;
  /** Image pixels. */
  rect?: Rect;
}

export interface Reference {
  path: string;
  pathKind: PathKind;
  loc: Location;
  /** Pinned version. */
  rev?: string;
  /** Version the live location was recorded at. */
  at?: string;
  /** Unknown fragment parts, kept so round-tripping never loses data. */
  extra: string[];
}

export type FileKind = 'pdf' | 'code' | 'sheet' | 'markdown' | 'image' | 'media' | 'slides' | 'doc' | 'other';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', csv: 'sheet', tsv: 'sheet',
  md: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  mp3: 'media', m4a: 'media', wav: 'media', ogg: 'media', mp4: 'media', webm: 'media', mov: 'media',
  pptx: 'slides', ppt: 'slides',
  docx: 'doc', doc: 'doc',
};

export function fileKind(path: string): FileKind {
  const ext = extname(path);
  if (ext in EXT_KIND) return EXT_KIND[ext];
  return 'code';
}

export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : i === 0 ? '/' : '';
}

/** Joins and normalises a workspace path ("/a/b/../c" → "/a/c"). Always returns a root-relative path. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

/** Resolves a reference path to a root-relative workspace path, given the note's own path. */
export function resolvePath(ref: Pick<Reference, 'path' | 'pathKind'>, notePath: string): string {
  if (ref.pathKind === 'root') return normalizePath(ref.path);
  if (ref.pathKind === 'relative') return normalizePath(dirname(notePath) + '/' + ref.path);
  return ref.path;
}

// ---------- Excel references ----------

export function parseSheetRef(text: string): SheetRef {
  if (text.startsWith("'")) {
    let i = 1;
    let sheet = '';
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          sheet += "'";
          i += 2;
          continue;
        }
        break;
      }
      sheet += text[i++];
    }
    const rest = text.slice(i + 1);
    return { sheet, range: rest.startsWith('!') ? rest.slice(1) : rest };
  }
  const bang = text.indexOf('!');
  if (bang >= 0) return { sheet: text.slice(0, bang), range: text.slice(bang + 1) };
  return { range: text };
}

export function formatSheetRef(ref: SheetRef): string {
  if (!ref.sheet) return ref.range;
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(ref.sheet);
  const sheet = plain ? ref.sheet : `'${ref.sheet.replace(/'/g, "''")}'`;
  return `${sheet}!${ref.range}`;
}

/** Column letters → 1-based index ("A" → 1, "AA" → 27). */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function colLetters(index: number): string {
  let s = '';
  while (index > 0) {
    const r = (index - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    index = Math.floor((index - 1) / 26);
  }
  return s;
}

export interface CellBox {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

const MAX_ROW = 1048576;
const MAX_COL = 16384;

/** Parses "B4:D12", "C7", "4:12" or "F:H" into a 1-based box. Returns undefined for named ranges. */
export function parseA1Range(range: string): CellBox | undefined {
  const cell = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;
  const col = /^\$?([A-Za-z]{1,3})$/;
  const row = /^\$?(\d+)$/;
  const [a, b = a] = range.split(':');
  let m1: RegExpMatchArray | null, m2: RegExpMatchArray | null;
  if ((m1 = a.match(cell)) && (m2 = b.match(cell))) {
    return box(+m1[2], colIndex(m1[1]), +m2[2], colIndex(m2[1]));
  }
  if ((m1 = a.match(row)) && (m2 = b.match(row))) return box(+m1[1], 1, +m2[1], MAX_COL);
  if ((m1 = a.match(col)) && (m2 = b.match(col))) return box(1, colIndex(m1[1]), MAX_ROW, colIndex(m2[1]));
  return undefined;
}

function box(r1: number, c1: number, r2: number, c2: number): CellBox {
  return { top: Math.min(r1, r2), left: Math.min(c1, c2), bottom: Math.max(r1, r2), right: Math.max(c1, c2) };
}

export function formatA1Range(b: CellBox): string {
  const a = `${colLetters(b.left)}${b.top}`;
  const z = `${colLetters(b.right)}${b.bottom}`;
  return a === z ? a : `${a}:${z}`;
}

// ---------- Destinations ----------

function parseRect(text: string): Rect | undefined {
  const n = text.split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return undefined;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

function parseTime(text: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTime(seconds: number): string {
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const pad = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Splits a fragment on '&', keeping quoted sheet names intact. */
function splitFragment(fragment: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (ch === "'") {
      if (quoted && fragment[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (ch === '&' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Parses a markdown link destination (without angle brackets). Returns undefined for empty input. */
export function parseDestination(dest: string): Reference | undefined {
  dest = dest.trim();
  if (!dest) return undefined;
  const hash = dest.indexOf('#');
  const rawPath = hash >= 0 ? dest.slice(0, hash) : dest;
  const fragment = hash >= 0 ? dest.slice(hash + 1) : '';

  let pathKind: PathKind;
  let path = safeDecode(rawPath);
  if (/^https?:/i.test(rawPath) || /^mailto:/i.test(rawPath)) {
    return { path: dest, pathKind: 'web', loc: {}, extra: [] };
  } else if (/^file:/i.test(rawPath)) {
    pathKind = 'external';
    path = path.replace(/^file:\/*/i, '');
  } else if (/^[A-Za-z]:[\\/]/.test(path)) {
    pathKind = 'external';
  } else if (path.startsWith('/')) {
    pathKind = 'root';
  } else {
    pathKind = 'relative';
  }

  const ref: Reference = { path, pathKind, loc: {}, extra: [] };
  // A bare "#heading" link points inside the note itself.
  if (!path && hash >= 0) ref.pathKind = 'relative';
  const kind = fileKind(path);
  const loc = ref.loc;

  for (const raw of splitFragment(fragment)) {
    const part = safeDecode(raw);
    const eq = part.indexOf('=');
    const key = eq > 0 && !part.includes('!') ? part.slice(0, eq) : '';
    const value = key ? part.slice(eq + 1) : '';
    let m: RegExpMatchArray | null;
    if (!key && (m = part.match(/^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/))) {
      const start = +m[1];
      loc.lines = { start, end: m[2] ? +m[2] : start };
    } else if (key === 'page' && /^\d+$/.test(value)) loc.page = +value;
    else if (key === 'viewrect') loc.viewrect = parseRect(value);
    else if (key === 'slide' && /^\d+$/.test(value)) loc.slide = +value;
    else if (key === 't') loc.time = parseTime(value);
    else if (key === 'rect') loc.rect = parseRect(value);
    else if (key === 'rev' && /^[0-9a-f]{7,40}$/i.test(value)) ref.rev = value.toLowerCase();
    else if (key === 'at' && /^[0-9a-f]{7,40}$/i.test(value)) ref.at = value.toLowerCase();
    else if (!key && kind === 'sheet') loc.sheet = parseSheetRef(part);
    else if (!key && (kind === 'markdown' || !path)) loc.heading = part;
    else ref.extra.push(raw);
  }
  return ref;
}

export function formatLocation(loc: Location): string[] {
  const parts: string[] = [];
  if (loc.lines) {
    parts.push(loc.lines.end !== loc.lines.start ? `L${loc.lines.start}-L${loc.lines.end}` : `L${loc.lines.start}`);
  }
  if (loc.page !== undefined) parts.push(`page=${loc.page}`);
  if (loc.viewrect) parts.push(`viewrect=${rectText(loc.viewrect)}`);
  if (loc.slide !== undefined) parts.push(`slide=${loc.slide}`);
  if (loc.sheet) parts.push(formatSheetRef(loc.sheet));
  if (loc.heading) parts.push(loc.heading);
  if (loc.time !== undefined) parts.push(`t=${formatTime(loc.time)}`);
  if (loc.rect) parts.push(`rect=${rectText(loc.rect)}`);
  return parts;
}

function rectText(r: Rect): string {
  return [r.x, r.y, r.w, r.h].map((v) => Math.round(v)).join(',');
}

export function formatDestination(ref: Reference): string {
  const parts = formatLocation(ref.loc);
  if (ref.rev) parts.push(`rev=${ref.rev}`);
  if (ref.at) parts.push(`at=${ref.at}`);
  parts.push(...ref.extra);
  let path = ref.path;
  if (ref.pathKind === 'external') path = 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '');
  const dest = parts.length ? `${path}#${parts.join('&')}` : path;
  return /[\s()<>]/.test(dest) ? `<${dest}>` : dest;
}

export function escapeLabel(label: string): string {
  return label.replace(/([\\\[\]])/g, '\\$1');
}

export function formatReference(label: string, ref: Reference, quote?: string): string {
  let title = '';
  if (quote) {
    const q = quote.replace(/\s+/g, ' ').trim().slice(0, 200).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (q) title = ` "${q}"`;
  }
  return `[${escapeLabel(label)}](${formatDestination(ref)}${title})`;
}

/** The default label for a new reference (link-format spec §3). */
export function defaultLabel(path: string, loc: Location, pageLabel?: string): string {
  const name = basename(path);
  const s = stem(path);
  if (loc.page !== undefined) return `${s} p${pageLabel ?? loc.page}`;
  if (loc.slide !== undefined) return `${s} slide ${loc.slide}`;
  if (loc.lines) {
    const { start, end } = loc.lines;
    return end !== start ? `${name} L${start}-${end}` : `${name} L${start}`;
  }
  if (loc.sheet) return `${s} ${formatSheetRef(loc.sheet)}`;
  if (loc.time !== undefined) return `${s} ${formatTime(loc.time)}`;
  return s;
}

/** Splits the inside of "(...)" into destination and optional title. */
export function splitLinkTarget(inner: string): { dest: string; title?: string } {
  inner = inner.trim();
  let dest: string;
  let rest: string;
  if (inner.startsWith('<')) {
    const close = inner.indexOf('>');
    dest = close >= 0 ? inner.slice(1, close) : inner.slice(1);
    rest = close >= 0 ? inner.slice(close + 1) : '';
  } else {
    const m = inner.match(/^(\S*)([\s\S]*)$/)!;
    dest = m[1];
    rest = m[2];
  }
  const t = rest.trim().match(/^(["'(])([\s\S]*)["')]$/);
  const title = t ? t[2].replace(/\\(["\\])/g, '$1') : undefined;
  return { dest, title };
}

/** GitHub-style heading slug. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}
