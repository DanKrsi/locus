// Embedded views (UI spec §4.9): a "!" reference to a document shows what it cites in the note.
// A box on a PDF page or a slide (or the whole page or slide) becomes a picture; a range of cells
// becomes a table of their values. A live reference draws the file as it is now and draws again
// when the file changes; a pinned one draws the version it is pinned to, which never changes.
// Nothing here knows about the editor: it turns a request into something to show, and keeps it.
import { init } from 'pptx-preview';
import { basename, fileKind, formatSheetRef, type Location, type Rect } from '../../core/link';
import { api } from '../api';
import { loadBytes, onInvalidate, sourceKey } from '../files';
import { openPdf } from '../viewers/pdf';
import { cellKey, loadWorkbook, resolveSheetRef } from '../viewers/sheetModel';
import { sanitize, slideElements } from '../viewers/SlidesViewer';

export interface EmbedCell {
  text: string;
  num: boolean;
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  color?: string;
  align?: 'left' | 'right' | 'center';
  colspan?: number;
  rowspan?: number;
}

export interface EmbedTable {
  /** Rows of cells; a cell covered by a merged one above or to its left is null. */
  rows: (EmbedCell | null)[][];
  /** Width of each shown column, in pixels at 100%. */
  colW: number[];
  /** Set when the range is bigger than what is shown. */
  cut?: { rows: number; cols: number; shownRows: number; shownCols: number };
}

export type EmbedContent =
  | { kind: 'loading'; ratio?: number; width?: number }
  /** width and height: the picture's own size in pixels at 100% (what it is shown at unless resized). */
  /** `blob` is the picture itself, for exports (the page may not fetch its own blob addresses). */
  | { kind: 'picture'; url: string; blob: Blob; width: number; height: number; note?: string }
  | { kind: 'table'; table: EmbedTable; note?: string }
  | { kind: 'error'; message: string; help: string };

export interface EmbedRequest {
  path: string;
  external: boolean;
  /** The version to draw; undefined for the file as it is now. */
  rev?: string;
  /** For a live reference: the version it was cited from, drawn if the file has left the workspace. */
  fallbackRev?: string;
  loc: Location;
}

/** Most rows and columns a table shows; the rest is a click away. */
export const MAX_ROWS = 200;
export const MAX_COLS = 30;
/** A box on a slide is in points of a 960 x 540 slide (as the slide viewer writes it). */
const SLIDE_W = 960;
const SLIDE_H = 540;

// ---------- Pictures of PDF pages ----------

/** A box inside the page, or null when nothing of it is on the page. */
function clampRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.min(r.x, r.x + r.w));
  const y0 = Math.max(0, Math.min(r.y, r.y + r.h));
  const x1 = Math.min(w, Math.max(r.x, r.x + r.w));
  const y1 = Math.min(h, Math.max(r.y, r.y + r.h));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Scale for drawing a box `w` x `h` (in its own units) sharp but within a sane canvas. */
function drawScale(w: number, h: number, wanted: number): number {
  return Math.max(0.05, Math.min(wanted, 4096 / w, 4096 / h, Math.sqrt(16e6 / (w * h))));
}

function canvasPicture(canvas: HTMLCanvasElement): Promise<{ url: string; blob: Blob }> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve({ url: URL.createObjectURL(b), blob: b }) : reject(new Error('The picture could not be made'))), 'image/png'),
  );
}

/** PDF points to CSS pixels: a page at 100% is shown at 96 dpi. */
const PT = 96 / 72;

async function pdfPicture(data: Uint8Array, loc: Location, name: string): Promise<EmbedContent> {
  const doc = await openPdf(data);
  const n = loc.page ?? 1;
  if (n < 1 || n > doc.numPages)
    return {
      kind: 'error',
      message: `${name} has ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}, so page ${n} can't be shown.`,
      help: 'Pages were taken out of the file since this view was made. Change area opens the file so you can draw the box again.',
    };
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const r = loc.viewrect ? clampRect(loc.viewrect, base.width, base.height) : { x: 0, y: 0, w: base.width, h: base.height };
  if (!r)
    return {
      kind: 'error',
      message: `The box on page ${n} of ${name} is outside the page or has no size.`,
      help: 'The page may have changed size since the box was drawn. Change area opens the file so you can draw it again.',
    };
  const scale = drawScale(r.w, r.h, PT * Math.max(2, window.devicePixelRatio || 1));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(r.w * scale));
  canvas.height = Math.max(1, Math.round(r.h * scale));
  await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -r.x * scale, -r.y * scale] }).promise;
  return { kind: 'picture', ...(await canvasPicture(canvas)), width: r.w * PT, height: r.h * PT };
}

// ---------- Pictures of slides ----------

interface Deck {
  host: HTMLElement;
  slides: HTMLElement[];
  /** Each slide drawn once as a picture, at twice its size; boxes are cut from it. */
  shots: Map<number, Promise<HTMLCanvasElement>>;
  destroy(): void;
}

/** Decks drawn off screen, newest last; only a few are kept. */
const decks = new Map<Uint8Array, Promise<Deck>>();

/** Resolves once the element has stopped changing for `quiet` ms (charts animate in), or after `max`. */
function settle(el: HTMLElement, quiet = 250, max = 2500): Promise<void> {
  return new Promise((resolve) => {
    let timer = window.setTimeout(done, quiet);
    const cap = window.setTimeout(done, max);
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(done, quiet);
    });
    mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() {
      mo.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    }
  });
}

function drawDeck(data: Uint8Array): Promise<Deck> {
  const had = decks.get(data);
  if (had) {
    decks.delete(data);
    decks.set(data, had);
    return had;
  }
  const p = (async () => {
    const host = document.createElement('div');
    host.className = 'embed-deck-host';
    // Laid out (so the slides have sizes) but never seen or reached.
    Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: `${SLIDE_W}px`, visibility: 'hidden', pointerEvents: 'none' });
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);
    const previewer = init(host, { width: SLIDE_W, height: SLIDE_H, mode: 'list' });
    const destroy = () => {
      try {
        previewer.destroy?.();
      } catch {
        /* already gone */
      }
      host.remove();
    };
    try {
      await previewer.preview(await sanitize(data));
      await settle(host);
    } catch (e) {
      destroy();
      throw e;
    }
    return { host, slides: slideElements(host), shots: new Map(), destroy };
  })();
  decks.set(data, p);
  p.catch(() => decks.delete(data));
  while (decks.size > 3) {
    const [oldest, deck] = decks.entries().next().value!;
    decks.delete(oldest);
    void deck.then((d) => d.destroy()).catch(() => undefined);
  }
  return p;
}

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

/**
 * A picture of a slide as drawn on screen. The slide is copied into an SVG (which can hold HTML)
 * and the SVG drawn onto a canvas; everything it uses has to be inside it, so pictures held as
 * blob addresses and charts drawn on canvases are written into the copy as data first.
 */
async function shootSlide(slide: HTMLElement): Promise<HTMLCanvasElement> {
  await settle(slide, 150, 1500);
  const clone = slide.cloneNode(true) as HTMLElement;
  const from = slide.querySelectorAll('canvas');
  clone.querySelectorAll('canvas').forEach((c, i) => {
    const img = document.createElement('img');
    try {
      img.src = from[i].toDataURL();
    } catch {
      return;
    }
    img.style.cssText = from[i].style.cssText;
    img.style.width = from[i].style.width || `${from[i].clientWidth}px`;
    img.style.height = from[i].style.height || `${from[i].clientHeight}px`;
    c.replaceWith(img);
  });
  const blobs = new Map<string, Promise<string>>();
  const inline = (url: string) => {
    let p = blobs.get(url);
    if (!p) blobs.set(url, (p = fetch(url).then((r) => r.blob()).then(toDataUrl).catch(() => url)));
    return p;
  };
  for (const img of clone.querySelectorAll('img')) if (img.src.startsWith('blob:')) img.src = await inline(img.src);
  for (const svgImg of clone.querySelectorAll('image')) {
    const href = svgImg.getAttribute('href') ?? svgImg.getAttribute('xlink:href');
    if (href?.startsWith('blob:')) svgImg.setAttribute('href', await inline(href));
  }
  for (const el of clone.querySelectorAll<HTMLElement>('[style*="blob:"]')) {
    let css = el.getAttribute('style') ?? '';
    for (const m of css.matchAll(/url\(["']?(blob:[^"')]+)["']?\)/g)) css = css.replace(m[1], await inline(m[1]));
    el.setAttribute('style', css);
  }
  clone.style.margin = '0';
  const w = slide.offsetWidth || SLIDE_W;
  const h = slide.offsetHeight || SLIDE_H;
  const cs = getComputedStyle(slide);
  const font = `font-family:${cs.fontFamily.replace(/"/g, "'")};color:${cs.color};font-size:${cs.fontSize};line-height:${cs.lineHeight}`;
  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${font}">${xml}</div></foreignObject></svg>`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The slide could not be drawn'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const k = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);
  ctx.drawImage(img, 0, 0);
  return canvas;
}

async function slidePicture(data: Uint8Array, loc: Location, name: string): Promise<EmbedContent> {
  const deck = await drawDeck(data);
  const n = loc.slide ?? 1;
  if (n < 1 || n > deck.slides.length)
    return {
      kind: 'error',
      message: `${name} has ${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'}, so slide ${n} can't be shown.`,
      help: 'Slides were taken out of the deck since this view was made. Change area opens the deck so you can pick the slide again.',
    };
  let shot = deck.shots.get(n);
  if (!shot) deck.shots.set(n, (shot = shootSlide(deck.slides[n - 1])));
  shot.catch(() => deck.shots.delete(n));
  const full = await shot;
  const r = loc.viewrect ? clampRect(loc.viewrect, SLIDE_W, SLIDE_H) : { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };
  if (!r)
    return {
      kind: 'error',
      message: `The box on slide ${n} of ${name} is outside the slide or has no size.`,
      help: 'Change area opens the deck so you can draw the box again.',
    };
  const sx = full.width / SLIDE_W;
  const sy = full.height / SLIDE_H;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(r.w * sx));
  canvas.height = Math.max(1, Math.round(r.h * sy));
  canvas.getContext('2d')!.drawImage(full, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, canvas.width, canvas.height);
  return { kind: 'picture', ...(await canvasPicture(canvas)), width: r.w, height: r.h };
}

// ---------- Tables of cells ----------

async function sheetTable(data: Uint8Array, loc: Location, name: string): Promise<EmbedContent> {
  if (!loc.sheet)
    return {
      kind: 'error',
      message: `This view of ${name} doesn't say which cells to show.`,
      help: 'Change cells opens the workbook: select the cells, then press Use these cells.',
    };
  const wb = await loadWorkbook(data, name);
  const hit = resolveSheetRef(wb, loc.sheet);
  const where = formatSheetRef(loc.sheet);
  if (!hit)
    return {
      kind: 'error',
      message: `${where} isn't in ${name} any more.`,
      help: 'The sheet or named range was renamed or deleted. Change cells opens the workbook so you can pick them again.',
    };
  const sheet = wb.sheets[hit.sheet];
  const { top, left } = hit.box;
  // A whole column or row ("F:H", "4:12") runs to the end of Excel's grid: stop where the sheet does.
  const bottom = Math.min(hit.box.bottom, Math.max(sheet.rows, top));
  const right = Math.min(hit.box.right, Math.max(sheet.cols, left));
  const lastRow = Math.min(bottom, top + MAX_ROWS - 1);
  const lastCol = Math.min(right, left + MAX_COLS - 1);
  const covered = new Set<number>();
  /** Merged cells, by their first cell in the range; the value lives in the merge's own first cell. */
  const spans = new Map<number, { colspan: number; rowspan: number; from: number }>();
  for (const m of sheet.merges) {
    if (m.bottom < top || m.top > lastRow || m.right < left || m.left > lastCol) continue;
    // A merge that starts outside the range shows from where the range starts.
    const t = Math.max(m.top, top);
    const l = Math.max(m.left, left);
    const b = Math.min(m.bottom, lastRow);
    const r = Math.min(m.right, lastCol);
    spans.set(cellKey(t, l), { colspan: r - l + 1, rowspan: b - t + 1, from: cellKey(m.top, m.left) });
    for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) if (y !== t || x !== l) covered.add(cellKey(y, x));
  }
  const rows: (EmbedCell | null)[][] = [];
  for (let y = top; y <= lastRow; y++) {
    const row: (EmbedCell | null)[] = [];
    for (let x = left; x <= lastCol; x++) {
      const key = cellKey(y, x);
      if (covered.has(key)) {
        row.push(null);
        continue;
      }
      const span = spans.get(key);
      const cell = sheet.cells.get(span?.from ?? key);
      row.push({
        text: cell?.text ?? '',
        num: !!cell?.num,
        bold: cell?.bold,
        italic: cell?.italic,
        fill: cell?.fill,
        color: cell?.color,
        align: cell?.align,
        ...(span && (span.colspan > 1 || span.rowspan > 1) ? { colspan: span.colspan, rowspan: span.rowspan } : {}),
      });
    }
    rows.push(row);
  }
  const colW: number[] = [];
  for (let x = left; x <= lastCol; x++) colW.push(sheet.colW[x] ?? 72);
  const totalRows = bottom - top + 1;
  const totalCols = right - left + 1;
  const table: EmbedTable = { rows, colW };
  if (totalRows > rows.length || totalCols > colW.length) table.cut = { rows: totalRows, cols: totalCols, shownRows: rows.length, shownCols: colW.length };
  return { kind: 'table', table };
}

/** The table as an element: values only, nothing to edit. Used in the note and in exports. */
/** A colour light enough to read on a dark page: dark ones are mixed toward white. */
function lighten(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (lum >= 0.55) return hex;
  const t = 0.55 - lum + 0.15;
  return '#' + rgb.map((c) => Math.round(c + (255 - c) * Math.min(0.8, t * 1.4)).toString(16).padStart(2, '0')).join('');
}

export function tableElement(t: EmbedTable, fixed: boolean): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'embed-table';
  const total = t.colW.reduce((a, b) => a + b, 0) || 1;
  const cols = document.createElement('colgroup');
  for (const w of t.colW) {
    const col = document.createElement('col');
    col.style.width = fixed ? `${((w / total) * 100).toFixed(2)}%` : `calc(${w}px * var(--zoom, 1))`;
    cols.append(col);
  }
  table.append(cols);
  const body = document.createElement('tbody');
  for (const row of t.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      if (!cell) continue;
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.colspan) td.colSpan = cell.colspan;
      if (cell.rowspan) td.rowSpan = cell.rowspan;
      const s = td.style;
      if (cell.bold) s.fontWeight = '600';
      if (cell.italic) s.fontStyle = 'italic';
      s.textAlign = cell.align ?? (cell.num ? 'right' : '');
      // A filled cell keeps dark writing, so it reads in dark mode too.
      if (cell.fill) {
        s.background = cell.fill;
        s.color = cell.color ?? '#1f2328';
      } else if (cell.color && !/^#0{6}$/i.test(cell.color)) {
        // Coloured writing on no fill: a dark colour is lightened in dark mode so it still reads.
        td.classList.add('tinted');
        s.setProperty('--c', cell.color);
        s.setProperty('--c-dark', lighten(cell.color));
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

// ---------- Drawing, kept ----------

interface Entry {
  req: EmbedRequest;
  /** The bytes the result was drawn from: a file read again unchanged needs no new drawing. */
  bytes?: Uint8Array;
  /** Whether those bytes came from the version cited (the file having left the workspace). */
  fellBack?: boolean;
  result?: EmbedContent;
  /** The file may have changed since: look again next time this view is asked for. */
  stale: boolean;
  loading?: Promise<void>;
  listeners: Set<() => void>;
  used: number;
}

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 300;

const locKey = (loc: Location) => JSON.stringify([loc.page, loc.viewrect, loc.slide, loc.sheet]);
export const embedKey = (req: EmbedRequest) => `${sourceKey(req)}|${req.fallbackRev ?? ''}|${locKey(req.loc)}`;

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** A picture no longer shown is let go a little later, once nothing can still be drawing it. */
function release(c: EmbedContent | undefined) {
  if (c?.kind === 'picture') setTimeout(() => URL.revokeObjectURL(c.url), 10000);
}

async function draw(data: Uint8Array, req: EmbedRequest): Promise<EmbedContent> {
  const name = basename(req.path);
  const kind = fileKind(req.path);
  if (kind === 'pdf') return pdfPicture(data, req.loc, name);
  if (kind === 'slides') return slidePicture(data, req.loc, name);
  if (kind === 'sheet') return sheetTable(data, req.loc, name);
  return { kind: 'error', message: `${name} can't be shown in a note.`, help: 'Only PDFs, slide decks and spreadsheets can be shown this way.' };
}

/** Why a file couldn't be read, in words, once the reading failed. */
async function unreadable(req: EmbedRequest): Promise<EmbedContent> {
  const name = basename(req.path);
  if (req.rev)
    return {
      kind: 'error',
      message: `The version of ${name} this view is pinned to isn't in this workspace.`,
      help: 'It may have come from a copy of the workspace with more history. Edit in the … menu can point it at a version that is here.',
    };
  const there = req.external ? true : await api.exists(req.path).catch(() => true);
  if (!there)
    return {
      kind: 'error',
      message: `${req.path.replace(/^\//, '')} isn't in the workspace.`,
      help: 'Nothing is at that path now, and no version of it is recorded. Put the file back, or use Edit in the … menu to point this view at another file.',
    };
  return {
    kind: 'error',
    message: `${name} couldn't be read.`,
    help: 'It may be open and half saved in another program. This view tries again whenever the file changes.',
  };
}

async function load(e: Entry) {
  const { req } = e;
  let data: Uint8Array | null = null;
  let note: string | undefined;
  try {
    data = await loadBytes(req);
  } catch {
    // A live view of a file that has left the workspace shows the version it was cited from.
    if (req.fallbackRev && !req.rev && !(await api.exists(req.path).catch(() => true))) {
      data = await loadBytes({ path: req.path, external: false, rev: req.fallbackRev }).catch(() => null);
      if (data) note = `${basename(req.path)} is no longer in the workspace. This shows the version it was cited from.`;
    }
  }
  let next: EmbedContent;
  if (!data) {
    // A half-written file keeps showing what it showed last.
    if (e.result && e.result.kind !== 'error' && e.result.kind !== 'loading') return;
    next = await unreadable(req);
  } else if (e.bytes && e.result && e.fellBack === !!note && sameBytes(e.bytes, data)) {
    return; // read again, unchanged
  } else {
    try {
      next = await draw(data, req);
    } catch (err) {
      if (e.result && e.result.kind !== 'error' && e.result.kind !== 'loading') return;
      next = { kind: 'error', message: `${basename(req.path)} couldn't be drawn.`, help: `The file may be damaged or in a form Locus can't read (${String((err as Error)?.message ?? err).slice(0, 120)}).` };
    }
    if (note && (next.kind === 'picture' || next.kind === 'table')) next = { ...next, note };
    e.bytes = data;
    e.fellBack = !!note;
  }
  const old = e.result;
  e.result = next;
  if (old !== next) release(old);
  for (const l of e.listeners) l();
}

/**
 * What an embedded view shows now. The first ask starts the drawing and says it is loading; when
 * the drawing lands (or changes, for a live view of a file that changed) `onChange` is called and
 * the next ask has it. While a changed file is drawn again, the old picture stays up.
 */
export function embedContent(req: EmbedRequest, onChange: () => void): EmbedContent {
  const key = embedKey(req);
  let e = entries.get(key);
  if (!e) {
    e = { req, stale: true, listeners: new Set(), used: 0 };
    entries.set(key, e);
    trim();
  }
  e.used = Date.now();
  e.listeners.add(onChange);
  look(e);
  return e.result ?? loadingFor(req);
}

/** Reads and draws a view whose file may have changed; a change landing mid-drawing is looked at after. */
function look(e: Entry) {
  if (!e.stale || e.loading) return;
  e.stale = false;
  e.loading = load(e)
    .catch(() => undefined)
    .finally(() => {
      e.loading = undefined;
      look(e);
    });
}

/** The picture or table once drawn (for exports). */
export async function embedReady(req: EmbedRequest): Promise<EmbedContent> {
  embedContent(req, () => undefined);
  const e = entries.get(embedKey(req))!;
  while (e.loading) await e.loading;
  return e.result ?? loadingFor(req);
}

/** The space to keep while a view loads, so the note doesn't jump when it lands. */
function loadingFor(req: EmbedRequest): EmbedContent {
  const r = req.loc.viewrect;
  const kind = fileKind(req.path);
  if (kind === 'pdf') return r ? { kind: 'loading', ratio: r.h / r.w, width: r.w * PT } : { kind: 'loading', ratio: 11 / 8.5, width: 612 * PT };
  if (kind === 'slides') return r ? { kind: 'loading', ratio: r.h / r.w, width: r.w } : { kind: 'loading', ratio: SLIDE_H / SLIDE_W, width: SLIDE_W };
  return { kind: 'loading' };
}

/** Files may have changed on disk: every live view looks again the next time it is shown. */
export function embedsStale() {
  for (const e of entries.values()) if (!e.req.rev) e.stale = true;
}
onInvalidate(embedsStale);

function trim() {
  if (entries.size <= MAX_ENTRIES) return;
  const old = [...entries.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, entries.size - MAX_ENTRIES);
  for (const [key, e] of old) {
    entries.delete(key);
    release(e.result);
  }
}
