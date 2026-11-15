// Shared PDF.js setup and a document cache used by the viewer and hover-card thumbnails.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Rect } from '../../core/link';
import { findQuote, type TextRun } from '../../core/quote';
import { BLANK, crop, detail, findPicture, fromRgba, judgePicture, resize, SAME_PICTURE, type Gray, type PageBox, type PictureVerdict } from '../../core/picture';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

const docs = new WeakMap<Uint8Array, Promise<PDFDocumentProxy>>();

/** Opens a PDF once per byte buffer (PDF.js takes ownership of the data, so pass a copy). */
export function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  let p = docs.get(data);
  if (!p) {
    p = pdfjs.getDocument({ data: data.slice() }).promise;
    docs.set(data, p);
  }
  return p;
}

/** Renders a small page thumbnail with an optional area box (hover cards). */
export async function renderThumb(data: Uint8Array, pageNo: number, width: number, area?: Rect): Promise<HTMLElement> {
  const doc = await openPdf(data);
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const viewport = page.getViewport({ scale: scale * 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.append(canvas);
  if (area) {
    const box = document.createElement('div');
    box.className = 'hover-area';
    Object.assign(box.style, {
      left: `${area.x * scale}px`,
      top: `${area.y * scale}px`,
      width: `${area.w * scale}px`,
      height: `${area.h * scale}px`,
    });
    wrap.append(box);
  }
  return wrap;
}

/** Text runs of one page, in PDF points from the top-left (the units references use). */
export async function pageRuns(data: Uint8Array, pageNo: number): Promise<TextRun[]> {
  const doc = await openPdf(data);
  if (pageNo < 1 || pageNo > doc.numPages) return [];
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [, , , d, e, f] = item.transform as number[];
    const h = item.height || Math.abs(d);
    runs.push({ str: item.str, x: e, y: vp.height - f - h, w: item.width, h });
  }
  return runs;
}

/**
 * The words inside an area of a page, in reading order. A box drawn by hand quotes them, so the
 * link can find the same place again after the document changes, the way a quoted link does.
 */
export async function textInRect(data: Uint8Array, pageNo: number, rect: Rect, limit = 400): Promise<string> {
  const runs = await pageRuns(data, pageNo);
  const inside = runs.filter((r) => {
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  });
  if (!inside.length) return '';
  // Runs come in the order the page draws them, which is not always the order it reads in.
  const lines: { y: number; runs: TextRun[] }[] = [];
  for (const run of [...inside].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - run.y) <= Math.max(2, run.h * 0.6));
    if (line) line.runs.push(run);
    else lines.push({ y: run.y, runs: [run] });
  }
  const text = lines
    .map((l) => l.runs.sort((a, b) => a.x - b.x).map((r) => r.str.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A whole-page box would quote the whole page: enough to find it again is enough.
  return text.length > limit ? text.slice(0, limit).replace(/\s+\S*$/, '') : text;
}

/** Finds quoted text, searching outward from the page it was on; null when it is gone. */
export async function locateQuote(data: Uint8Array, quote: string, near: number): Promise<{ page: number; rect: Rect } | null> {
  const doc = await openPdf(data);
  const pages = [near];
  for (let d = 1; d < doc.numPages; d++) pages.push(near - d, near + d);
  for (const p of pages) {
    if (p < 1 || p > doc.numPages) continue;
    const m = findQuote(await pageRuns(data, p), quote);
    if (m) return { page: p, rect: m.rect };
  }
  return null;
}

// ---------- Finding a cited picture again ----------

/** Rendered pages in grey, per PDF and page: the same file is often searched for several boxes. */
const grays = new WeakMap<Uint8Array, Map<string, Promise<Gray | null>>>();

/** One page in grey at `scale` pixels per point, on white paper. */
function pageGray(data: Uint8Array, pageNo: number, scale: number): Promise<Gray | null> {
  let m = grays.get(data);
  if (!m) grays.set(data, (m = new Map()));
  const key = `${pageNo}|${scale}`;
  let p = m.get(key);
  if (!p) {
    p = (async () => {
      const doc = await openPdf(data);
      if (pageNo < 1 || pageNo > doc.numPages) return null;
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      return fromRgba(canvas.width, canvas.height, ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    })().catch(() => null);
    m.set(key, p);
  }
  return p;
}

/** Sizes tried when the picture isn't found at its old size (Word and others resize on re-layout). */
const SIZES = [0.95, 1.05, 0.9, 1.1, 0.85, 1.18, 0.8, 1.25, 0.75, 1.33, 0.7, 1.4];
/** Pages searched, outward from the cited one, and how long that may take: the user is waiting. */
const MAX_PAGES = 60;
const BUDGET_MS = 6000;

/**
 * Looks for the picture inside a box of one version of a PDF (`was`) in another (`now`): the same
 * page first, then outward. A box with no words to quote can only be found again this way.
 */
export async function locatePicture(was: Uint8Array, page: number, rect: Rect, now: Uint8Array): Promise<PictureVerdict> {
  const oldDoc = await openPdf(was);
  const newDoc = await openPdf(now);
  if (page < 1 || page > oldDoc.numPages) return { kind: 'gone' };
  // About one pixel per point; a huge drawing sheet is rendered smaller so a page stays quick.
  const size = (await oldDoc.getPage(page)).getViewport({ scale: 1 });
  const scale = Math.min(1, 1400 / Math.max(size.width, size.height));
  const oldPage = await pageGray(was, page, scale);
  if (!oldPage) return { kind: 'gone' };
  const tpl = crop(oldPage, rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
  if (tpl.w < 4 || tpl.h < 4 || detail(tpl) < BLANK) return { kind: 'blank' };
  const box = (n: number, h: { x: number; y: number; w: number; h: number; score: number }): PageBox => ({ page: n, x: h.x / scale, y: h.y / scale, w: h.w / scale, h: h.h / scale, score: h.score });

  const order = [page];
  for (let d = 1; d < newDoc.numPages; d++) order.push(page - d, page + d);
  const pages = order.filter((n) => n >= 1 && n <= newDoc.numPages).slice(0, MAX_PAGES);
  const hits: PageBox[] = [];
  const start = performance.now();
  for (const n of pages) {
    if (performance.now() - start > BUDGET_MS) break;
    const g = await pageGray(now, n, scale);
    if (!g) continue;
    const r = findPicture(g, tpl);
    if (r.best) hits.push(box(n, r.best));
    if (r.runnerUp) hits.push(box(n, r.runnerUp));
    // Found in the same place: nothing moved, no need to look further.
    if (n === page && r.best && r.best.score >= 0.97 && Math.abs(r.best.x / scale - rect.x) <= 3 && Math.abs(r.best.y / scale - rect.y) <= 3 && !(r.runnerUp && r.runnerUp.score >= r.best.score - 0.06)) break;
  }
  if (!hits.some((h) => h.score >= SAME_PICTURE)) {
    // Perhaps resized: try other sizes on the pages that came closest at the old size.
    const closest = [...new Set([...hits].sort((a, b) => b.score - a.score).map((h) => h.page))].slice(0, 3);
    for (const n of closest) {
      const g = await pageGray(now, n, scale);
      if (!g) continue;
      for (const f of SIZES) {
        if (performance.now() - start > BUDGET_MS * 1.5) break;
        const r = findPicture(g, resize(tpl, tpl.w * f, tpl.h * f));
        if (r.best) hits.push(box(n, r.best));
        if (r.best && r.best.score >= SAME_PICTURE) break;
      }
    }
  }
  return judgePicture({ page, ...rect }, hits);
}
