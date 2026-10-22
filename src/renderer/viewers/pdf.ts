// Shared PDF.js setup and a document cache used by the viewer and hover-card thumbnails.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Rect } from '../../core/link';

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
