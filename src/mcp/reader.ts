// Turns workspace files into text Claude can read and cite: numbered code lines, PDF pages
// with positioned text, and spreadsheet cells with their addresses.
import './domPolyfill';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { basename, colLetters, fileKind } from '../core/link';
import type { TextRun } from '../core/quote';

// PDF.js runs its "worker" on the main thread in Node when the worker module is preloaded.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfWorker;

export interface PdfPage {
  page: number;
  label?: string;
  width: number;
  height: number;
  runs: TextRun[];
  text: string;
}

export async function readPdf(data: Uint8Array): Promise<PdfPage[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, verbosity: 0 }).promise;
  const labels = await doc.getPageLabels().catch(() => null);
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const [, , , d, e, f] = item.transform as number[];
      const h = item.height || Math.abs(d);
      // PDF space has its origin at the bottom-left; links use the top-left.
      if (item.str.trim()) runs.push({ str: item.str, x: e, y: vp.height - f - h, w: item.width, h });
      text += item.str + (item.hasEOL ? '\n' : '');
    }
    pages.push({ page: p, label: labels?.[p - 1] ?? undefined, width: vp.width, height: vp.height, runs, text: text.replace(/[ \t]+\n/g, '\n').trim() });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

/** Slide texts in presentation order (slide 1 first). */
export async function readSlides(data: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(data);
  const pres = (await zip.file('ppt/presentation.xml')?.async('string')) ?? '';
  const rels = (await zip.file('ppt/_rels/presentation.xml.rels')?.async('string')) ?? '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/Id="([^"]+)"/)?.[1];
    const t = m[0].match(/Target="([^"]+)"/)?.[1];
    if (id && t) target.set(id, t.replace(/^\//, '').replace(/^(?!ppt\/)/, 'ppt/'));
  }
  const order = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => target.get(m[1])).filter(Boolean) as string[];
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const out: string[] = [];
  for (const path of order) {
    const xml = (await zip.file(path)?.async('string')) ?? '';
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1])).join(''))
      .filter((t) => t.trim());
    out.push(paras.join('\n'));
  }
  return out;
}

export interface SheetDump {
  name: string;
  /** Row number → [column letter, display text][] */
  rows: Map<number, [string, string][]>;
  dims: string;
}

export interface WorkbookDump {
  sheets: SheetDump[];
  names: { name: string; ref: string }[];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('text' in o) return String(o.text);
    if ('error' in o) return String(o.error);
  }
  return String(v);
}

export async function readWorkbook(data: Uint8Array, fileName: string): Promise<WorkbookDump> {
  if (/\.(csv|tsv)$/i.test(fileName)) {
    const sep = fileName.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const rows = new Map<number, [string, string][]>();
    new TextDecoder()
      .decode(data)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!line) return;
        rows.set(i + 1, line.split(sep).map((v, c) => [colLetters(c + 1), v.replace(/^"|"$/g, '')] as [string, string]));
      });
    return { sheets: [{ name: basename(fileName).replace(/\.[^.]+$/, ''), rows, dims: '' }], names: [] };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  const sheets: SheetDump[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows = new Map<number, [string, string][]>();
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const cells: [string, string][] = [];
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.isMerged && cell.master !== cell) return;
        const v = cell.value as { formula?: string } | null;
        let t = cellText(cell.value);
        if (v && typeof v === 'object' && 'formula' in v && v.formula) t += `  (=${v.formula})`;
        if (t) cells.push([colLetters(c), t]);
      });
      if (cells.length) rows.set(r, cells);
    });
    sheets.push({ name: ws.name, rows, dims: ws.dimensions?.toString?.() ?? '' });
  });
  const model = (wb.definedNames as unknown as { model?: { name: string; ranges: string[] }[] }).model ?? [];
  return { sheets, names: model.map((n) => ({ name: n.name, ref: n.ranges?.[0] ?? '' })) };
}

export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export interface ReadOptions {
  startLine?: number;
  endLine?: number;
  pages?: [number, number];
  sheet?: string;
}

const MAX_CHARS = 60000;

/** A readable rendering of any supported file, with the coordinates needed to cite it. */
export async function renderForClaude(path: string, data: Uint8Array, opts: ReadOptions = {}): Promise<string> {
  const kind = fileKind(path);
  let out = '';
  if (kind === 'pdf') {
    const pages = await readPdf(data);
    const [a, b] = opts.pages ?? [1, pages.length];
    out += `PDF "${basename(path)}", ${pages.length} pages. Cite with page=<n> (file page number below).\n`;
    for (const p of pages.slice(a - 1, b)) {
      out += `\n=== page ${p.page}${p.label && p.label !== String(p.page) ? ` (printed "${p.label}")` : ''} ===\n${p.text}\n`;
      if (out.length > MAX_CHARS) {
        out += `\n[truncated: read more with pages=[${p.page + 1}, ${Math.min(pages.length, p.page + 20)}]]\n`;
        break;
      }
    }
    return out;
  }
  if (kind === 'sheet') {
    const wb = await readWorkbook(data, basename(path));
    out += `Workbook "${basename(path)}". Cite ranges as Sheet!A1:B2 (quote sheet names with spaces: 'Load cases'!B4:D12) or a named range.\n`;
    if (wb.names.length) out += `Named ranges: ${wb.names.map((n) => `${n.name} = ${n.ref}`).join('; ')}\n`;
    for (const s of wb.sheets) {
      if (opts.sheet && s.name !== opts.sheet) continue;
      out += `\n=== sheet ${quoteSheetName(s.name)} ${s.dims ? `(${s.dims})` : ''} ===\n`;
      for (const [r, cells] of s.rows) {
        out += `${r}: ${cells.map(([c, t]) => `${c}${r}=${t}`).join(' | ')}\n`;
        if (out.length > MAX_CHARS) {
          out += `[truncated: pass sheet to read one sheet]\n`;
          break;
        }
      }
    }
    return out;
  }
  if (kind === 'code' || kind === 'markdown') {
    const text = new TextDecoder().decode(data).replace(/^﻿/, '');
    if (/\u0000/.test(text.slice(0, 8000))) return `${basename(path)} looks like a binary file and can't be shown as text.`;
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, opts.startLine ?? 1);
    const end = Math.min(lines.length, opts.endLine ?? lines.length);
    const width = String(end).length;
    out += `${basename(path)}, lines ${start}-${end} of ${lines.length}. Cite with L<a>-L<b>.\n`;
    for (let i = start; i <= end; i++) {
      out += `${String(i).padStart(width)} | ${lines[i - 1]}\n`;
      if (out.length > MAX_CHARS) {
        out += `[truncated: read from start_line=${i + 1}]\n`;
        break;
      }
    }
    return out;
  }
  if (kind === 'slides') {
    const slides = await readSlides(data);
    out += `Presentation "${basename(path)}", ${slides.length} slides. Cite with slide=<n>.\n`;
    slides.forEach((t, i) => (out += `\n=== slide ${i + 1} ===\n${t}\n`));
    return out;
  }
  return `${basename(path)} is a ${kind} file. It can be cited as a whole file${kind === 'media' ? ' or at a time (t=m:ss)' : ''}, but its contents can't be read as text.`;
}
