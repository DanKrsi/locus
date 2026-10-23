// Shared PDF.js setup and a document cache used by the viewer and hover-card thumbnails.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Rect } from '../../core/link';
import { findQuote, type TextRun } from '../../core/quote';

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
