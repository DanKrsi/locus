// Reads .xlsx (ExcelJS) and .csv into a light model the grid can draw quickly.
import ExcelJS from 'exceljs';
import { colLetters, formatA1Range, parseA1Range, type CellBox, type SheetRef } from '../../core/link';

export interface CellModel {
  text: string;
  num: boolean;
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  color?: string;
  align?: 'left' | 'right' | 'center';
  /** Formula (without "=") or raw value for the formula bar. */
  formula?: string;
}

export interface SheetModel {
  name: string;
  tabColor?: string;
  rows: number;
  cols: number;
  colW: number[];
  rowH: number[];
  cells: Map<number, CellModel>;
  merges: CellBox[];
}

export interface WorkbookModel {
  sheets: SheetModel[];
  /** Defined names → sheet + range. */
  names: { name: string; sheet: string; range: string }[];
}

export const cellKey = (r: number, c: number) => r * 20000 + c;

const DEFAULT_COL_W = 72;
const DEFAULT_ROW_H = 21;

function argb(color?: { argb?: string }): string | undefined {
  const v = color?.argb;
  if (!v || v.length < 6) return undefined;
  return '#' + v.slice(-6);
}

function decimals(fmt: string): number {
  const m = fmt.match(/\.(0+)/);
  return m ? m[1].length : 0;
}

export function formatValue(value: unknown, fmt?: string): { text: string; num: boolean } {
  if (value === null || value === undefined) return { text: '', num: false };
  if (value instanceof Date) {
    const hasTime = fmt ? /h|s/i.test(fmt.replace(/"[^"]*"/g, '')) : false;
    return { text: hasTime ? value.toLocaleString() : value.toLocaleDateString(), num: true };
  }
  if (typeof value === 'number') {
    const f = fmt && fmt !== 'General' ? fmt.split(';')[0] : '';
    if (!f) {
      const t = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
      return { text: t, num: true };
    }
    if (f.includes('%')) return { text: (value * 100).toFixed(decimals(f)) + '%', num: true };
    const d = decimals(f);
    const grouped = f.includes(',');
    let text = Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: grouped,
    });
    if (/[$€£]/.test(f)) text = (f.match(/[$€£]/)![0]) + text;
    if (value < 0) text = (fmt?.includes('(') ? `(${text})` : `-${text}`);
    return { text, num: true };
  }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', num: false };
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v || 'formula' in v || 'sharedFormula' in v) return formatValue(v.result, fmt);
    if (Array.isArray(v.richText)) return { text: (v.richText as { text: string }[]).map((r) => r.text).join(''), num: false };
    if ('text' in v) return { text: String(v.text), num: false };
    if ('error' in v) return { text: String(v.error), num: false };
  }
  return { text: String(value), num: false };
}

async function loadXlsx(data: Uint8Array): Promise<WorkbookModel> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const sheets: SheetModel[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows = Math.max(ws.rowCount, 1);
    const cols = Math.max(ws.columnCount, 1);
    const colW = [0];
    for (let c = 1; c <= cols; c++) {
      const w = ws.getColumn(c).width;
      colW.push(w ? Math.round(w * 7 + 5) : DEFAULT_COL_W);
    }
    const rowH = [0];
    for (let r = 1; r <= rows; r++) {
      const h = ws.getRow(r).height;
      rowH.push(h ? Math.round((h * 4) / 3) : DEFAULT_ROW_H);
    }
    const cells = new Map<number, CellModel>();
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.isMerged && cell.master !== cell) return;
        const { text, num } = formatValue(cell.value, cell.numFmt);
        const fill = cell.fill && cell.fill.type === 'pattern' && cell.fill.pattern === 'solid' ? argb(cell.fill.fgColor) : undefined;
        const v = cell.value as { formula?: string; sharedFormula?: string } | null;
        const formula = v && typeof v === 'object' && (v.formula || v.sharedFormula) ? '=' + (v.formula ?? v.sharedFormula) : text;
        const horizontal = cell.alignment?.horizontal;
        cells.set(cellKey(r, c), {
          text,
          num,
          bold: cell.font?.bold,
          italic: cell.font?.italic,
          fill,
          color: argb(cell.font?.color),
          align: horizontal === 'center' || horizontal === 'right' || horizontal === 'left' ? horizontal : undefined,
          formula,
        });
      });
    });
    const merges: CellBox[] = [];
    const rawMerges: string[] = (ws as unknown as { model?: { merges?: string[] } }).model?.merges ?? [];
    for (const m of rawMerges) {
      const b = parseA1Range(m);
      if (b) merges.push(b);
    }
    sheets.push({ name: ws.name, tabColor: argb(ws.properties?.tabColor), rows, cols, colW, rowH, cells, merges });
  });
  const names: WorkbookModel['names'] = [];
  const model = (wb.definedNames as unknown as { model?: { name: string; ranges: string[] }[] }).model ?? [];
  for (const dn of model) {
    const first = dn.ranges?.[0];
    if (!first) continue;
    const bang = first.lastIndexOf('!');
    const sheet = first.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
    names.push({ name: dn.name, sheet, range: first.slice(bang + 1).replace(/\$/g, '') });
  }
  return { sheets, names };
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function loadCsv(data: Uint8Array, name: string, sep: string): WorkbookModel {
  const rowsData = parseCsv(new TextDecoder().decode(data), sep);
  const cols = Math.max(1, ...rowsData.map((r) => r.length));
  const cells = new Map<number, CellModel>();
  rowsData.forEach((row, ri) =>
    row.forEach((v, ci) => {
      if (v === '') return;
      const n = Number(v);
      const num = v.trim() !== '' && Number.isFinite(n);
      cells.set(cellKey(ri + 1, ci + 1), { text: v, num, formula: v });
    }),
  );
  return {
    sheets: [
      {
        name,
        rows: Math.max(1, rowsData.length),
        cols,
        colW: [0, ...Array(cols).fill(DEFAULT_COL_W + 20)],
        rowH: [0, ...Array(Math.max(1, rowsData.length)).fill(DEFAULT_ROW_H)],
        cells,
        merges: [],
      },
    ],
    names: [],
  };
}

const models = new WeakMap<Uint8Array, Promise<WorkbookModel>>();

export function loadWorkbook(data: Uint8Array, fileName: string): Promise<WorkbookModel> {
  let p = models.get(data);
  if (!p) {
    const ext = fileName.toLowerCase().split('.').pop();
    const stem = fileName.replace(/\.[^.]+$/, '');
    p = ext === 'csv' || ext === 'tsv' ? Promise.resolve(loadCsv(data, stem, ext === 'tsv' ? '\t' : ',')) : loadXlsx(data);
    models.set(data, p);
  }
  return p;
}

/** Finds the sheet and box a reference points at (sheet range or defined name). */
export function resolveSheetRef(wb: WorkbookModel, ref: SheetRef): { sheet: number; box: CellBox } | null {
  let sheetName = ref.sheet;
  let range = ref.range;
  if (!sheetName) {
    const named = wb.names.find((n) => n.name.toLowerCase() === ref.range.toLowerCase());
    if (named) {
      sheetName = named.sheet;
      range = named.range;
    }
  }
  let sheet = sheetName ? wb.sheets.findIndex((s) => s.name === sheetName) : 0;
  // A single-sheet file (CSV) matches whatever name a link used for it.
  if (sheet < 0 && wb.sheets.length === 1) sheet = 0;
  const box = parseA1Range(range);
  if (sheet < 0 || !box) return null;
  return { sheet, box };
}

/** If a box exactly matches a defined name, returns that name. */
export function nameForBox(wb: WorkbookModel, sheet: string, box: CellBox): string | undefined {
  const a1 = formatA1Range(box);
  return wb.names.find((n) => n.sheet === sheet && formatA1Range(parseA1Range(n.range) ?? box) === a1 && parseA1Range(n.range))?.name;
}

export { colLetters };
