import { useEffect, useMemo, useRef, useState } from 'react';
import { basename, colLetters, formatA1Range, formatSheetRef, parseSheetRef, type CellBox } from '../../core/link';
import { Icon } from '../icons';
import { CiteButton } from './CiteButton';
import { cellKey, loadWorkbook, nameForBox, resolveSheetRef, type CellModel, type SheetModel, type WorkbookModel } from './sheetModel';
import type { ViewerProps } from './types';

/** Header sizes at 100%; the grid scales them (and every row and column) with the zoom. */
const HEAD_H_100 = 22;
const HEAD_W_100 = 46;
const MAX_ROW = 1048576;
const MAX_COL = 16384;
/** Extra blank rows/columns beyond the used range, like Excel. */
const PAD_ROWS = 30;
const PAD_COLS = 8;

interface Pt {
  r: number;
  c: number;
}

function prefix(sizes: number[], extra: number, def: number): number[] {
  const out = [0];
  for (let i = 1; i < sizes.length; i++) out.push(out[i - 1] + sizes[i]);
  for (let i = 0; i < extra; i++) out.push(out[out.length - 1] + def);
  return out;
}

/** Index i (1-based) such that pos lies in [pre[i-1], pre[i]). */
function locate(pre: number[], pos: number): number {
  let lo = 1;
  let hi = pre.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pre[mid] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/**
 * Font colour for a cell. Cells with their own fill keep dark text (fills are light);
 * in dark mode a dark font on the dark grid falls back to the normal grid text.
 */
function cellColor(cell: CellModel | undefined): string | undefined {
  if (!cell) return undefined;
  if (cell.fill) return cell.color ?? '#1f2328';
  const dark = document.documentElement.dataset.mode === 'dark';
  if (cell.color && dark && luminance(cell.color) < 0.2) return undefined;
  return cell.color;
}

const boxOf = (a: Pt, b: Pt): CellBox => ({
  top: Math.min(a.r, b.r),
  left: Math.min(a.c, b.c),
  bottom: Math.max(a.r, b.r),
  right: Math.max(a.c, b.c),
});

export function SheetViewer({ data, path, reveal, onCite, handle, zoom = 1, children }: ViewerProps) {
  const HEAD_H = Math.round(HEAD_H_100 * zoom);
  const HEAD_W = Math.round(HEAD_W_100 * zoom);
  const [wb, setWb] = useState<WorkbookModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<Pt>({ r: 1, c: 1 });
  const [focus, setFocus] = useState<Pt>({ r: 1, c: 1 });
  const [cited, setCited] = useState<{ sheet: number; box: CellBox } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0, w: 800, h: 600 });
  const [nameInput, setNameInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setWb(null);
    loadWorkbook(data, basename(path))
      .then((m) => !cancelled && setWb(m))
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [data, path]);

  const sheet: SheetModel | undefined = wb?.sheets[active];
  const colPre = useMemo(() => (sheet ? prefix(sheet.colW, PAD_COLS, 72).map((x) => x * zoom) : [0]), [sheet, zoom]);
  const rowPre = useMemo(() => (sheet ? prefix(sheet.rowH, PAD_ROWS, 21).map((x) => x * zoom) : [0]), [sheet, zoom]);
  const nCols = colPre.length - 1;
  const nRows = rowPre.length - 1;

  const mergeAt = useMemo(() => {
    const top = new Map<number, CellBox>();
    const covered = new Set<number>();
    for (const m of sheet?.merges ?? []) {
      top.set(cellKey(m.top, m.left), m);
      for (let r = m.top; r <= m.bottom; r++) for (let c = m.left; c <= m.right; c++) if (r !== m.top || c !== m.left) covered.add(cellKey(r, c));
    }
    return { top, covered };
  }, [sheet]);

  const sel = boxOf(anchor, focus);
  const selRef = (): string => {
    if (!sheet || !wb) return '';
    const named = nameForBox(wb, sheet.name, sel);
    if (named) return named;
    let range = formatA1Range(sel);
    if (sel.top === 1 && sel.bottom >= MAX_ROW) range = `${colLetters(sel.left)}:${colLetters(sel.right)}`;
    else if (sel.left === 1 && sel.right >= MAX_COL) range = `${sel.top}:${sel.bottom}`;
    return formatSheetRef({ sheet: sheet.name, range });
  };

  useEffect(() => setNameInput(selRef()), [anchor, focus, active, wb]);

  const scrollIntoView = (box: CellBox) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = rowPre[Math.min(box.top, nRows) - 1];
    const left = colPre[Math.min(box.left, nCols) - 1];
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - HEAD_H - 40) el.scrollTop = Math.max(0, top - 60);
    if (left < el.scrollLeft || left > el.scrollLeft + el.clientWidth - HEAD_W - 80) el.scrollLeft = Math.max(0, left - 40);
  };

  const select = (box: CellBox) => {
    setAnchor({ r: box.top, c: box.left });
    setFocus({ r: box.bottom, c: box.right });
  };

  useEffect(() => {
    if (!wb || !reveal?.loc.sheet) return;
    const hit = resolveSheetRef(wb, reveal.loc.sheet);
    if (!hit) return;
    setActive(hit.sheet);
    setCited(hit);
    select(hit.box);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollIntoView(hit.box)));
  }, [reveal, wb]);

  useEffect(() => {
    handle({
      citeTarget: () => {
        if (!sheet || !wb) return null;
        const ref = parseSheetRef(selRef());
        const quote: string[] = [];
        for (let c = sel.left; c <= Math.min(sel.right, sel.left + 5); c++) {
          const t = sheet.cells.get(cellKey(sel.top, c))?.text;
          if (t) quote.push(t);
        }
        return { loc: { sheet: ref }, quote: quote.join(' | ') || undefined };
      },
    });
    return () => handle(null);
  }, [wb, active, anchor, focus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setScroll({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wb]);

  const cellAt = (e: React.MouseEvent): Pt | null => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft - HEAD_W;
    const y = e.clientY - rect.top + el.scrollTop - HEAD_H;
    if (x < 0 || y < 0) return null;
    return { r: Math.min(locate(rowPre, y), nRows), c: Math.min(locate(colPre, x), nCols) };
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const next = { r: Math.max(1, Math.min(nRows, focus.r + m[0])), c: Math.max(1, Math.min(nCols, focus.c + m[1])) };
    setFocus(next);
    if (!e.shiftKey) setAnchor(next);
    scrollIntoView({ top: next.r, left: next.c, bottom: next.r, right: next.c });
  };

  const goToName = () => {
    if (!wb) return;
    const ref = parseSheetRef(nameInput.trim());
    const hit = resolveSheetRef(wb, ref.sheet ? ref : { sheet: ref.range.includes(':') || /\d/.test(ref.range) ? sheet?.name : undefined, range: ref.range });
    if (!hit) return;
    setActive(hit.sheet);
    select(hit.box);
    requestAnimationFrame(() => scrollIntoView(hit.box));
  };

  if (error) return <div className="empty"><h3>This spreadsheet couldn't be opened</h3><div>{error}</div></div>;

  const focusCell = sheet?.cells.get(cellKey(focus.r, focus.c));

  // Visible window.
  const r0 = sheet ? Math.max(1, locate(rowPre, scroll.top) - 1) : 1;
  const r1 = sheet ? Math.min(nRows, locate(rowPre, scroll.top + scroll.h) + 1) : 0;
  const c0 = sheet ? Math.max(1, locate(colPre, scroll.left) - 1) : 1;
  const c1 = sheet ? Math.min(nCols, locate(colPre, scroll.left + scroll.w) + 1) : 0;

  const boxRect = (b: CellBox) => {
    const top = rowPre[Math.min(b.top, nRows) - 1];
    const left = colPre[Math.min(b.left, nCols) - 1];
    return {
      top: HEAD_H + top,
      left: HEAD_W + left,
      height: rowPre[Math.min(b.bottom, nRows)] - top,
      width: colPre[Math.min(b.right, nCols)] - left,
    };
  };

  const cells: React.ReactNode[] = [];
  if (sheet) {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = cellKey(r, c);
        if (mergeAt.covered.has(key)) continue;
        const cell = sheet.cells.get(key);
        const merge = mergeAt.top.get(key);
        let width = colPre[c] - colPre[c - 1];
        let height = rowPre[r] - rowPre[r - 1];
        if (merge) {
          width = colPre[Math.min(merge.right, nCols)] - colPre[c - 1];
          height = rowPre[Math.min(merge.bottom, nRows)] - rowPre[r - 1];
        }
        let spill = false;
        if (cell && !cell.num && !merge && cell.text) {
          // Text spills over empty neighbours, like Excel.
          let cc = c + 1;
          while (cc <= Math.min(nCols, c + 12) && !sheet.cells.get(cellKey(r, cc))?.text && !mergeAt.covered.has(cellKey(r, cc))) {
            width += colPre[cc] - colPre[cc - 1];
            cc++;
          }
          spill = cc > c + 1;
        }
        cells.push(
          <div
            key={key}
            className={'cell' + (cell?.num ? ' num' : '')}
            style={{
              top: HEAD_H + rowPre[r - 1],
              left: HEAD_W + colPre[c - 1],
              width,
              height,
              lineHeight: `${Math.max(height - 1, 16)}px`,
              fontWeight: cell?.bold ? 700 : undefined,
              fontStyle: cell?.italic ? 'italic' : undefined,
              background: cell?.fill,
              color: cellColor(cell),
              textAlign: cell?.align,
              zIndex: spill ? 1 : undefined,
            }}
          >
            {cell?.text}
          </div>,
        );
      }
    }
  }

  const heads: React.ReactNode[] = [];
  if (sheet) {
    for (let c = c0; c <= c1; c++) {
      heads.push(
        <div
          key={'c' + c}
          className={'col-head' + (c >= sel.left && c <= sel.right ? ' sel' : '')}
          style={{ top: scroll.top, left: HEAD_W + colPre[c - 1], width: colPre[c] - colPre[c - 1], height: HEAD_H, zIndex: 6 }}
          onMouseDown={(e) => {
            e.preventDefault();
            if (e.shiftKey) setFocus({ r: MAX_ROW, c });
            else {
              setAnchor({ r: 1, c });
              setFocus({ r: MAX_ROW, c });
            }
          }}
        >
          {colLetters(c)}
        </div>,
      );
    }
    for (let r = r0; r <= r1; r++) {
      heads.push(
        <div
          key={'r' + r}
          className={'row-head' + (r >= sel.top && r <= sel.bottom ? ' sel' : '')}
          style={{ left: scroll.left, top: HEAD_H + rowPre[r - 1], width: HEAD_W, height: rowPre[r] - rowPre[r - 1], lineHeight: `${rowPre[r] - rowPre[r - 1] - 1}px`, zIndex: 6 }}
          onMouseDown={(e) => {
            e.preventDefault();
            if (e.shiftKey) setFocus({ r, c: MAX_COL });
            else {
              setAnchor({ r, c: 1 });
              setFocus({ r, c: MAX_COL });
            }
          }}
        >
          {r}
        </div>,
      );
    }
  }

  return (
    <>
      <div className="toolbar">
        {children}
        <input
          className="name-box"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && goToName()}
          onFocus={(e) => e.target.select()}
          title="Type a reference (B4:D12, 'Load cases'!C7, or a named range) and press Enter"
        />
        <span className="muted" style={{ fontStyle: 'italic', fontFamily: 'Georgia, serif', padding: '0 4px' }}>fx</span>
        <div className="formula" title={focusCell?.formula}>{focusCell?.formula ?? ''}</div>
        <CiteButton icon="grid" label="Cite range" title="Insert a link to these cells into the note (Ctrl+Shift+L)" onCite={onCite} />
      </div>
      <div className="sheet">
        <div
          className="grid-scroll"
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            const el = e.currentTarget;
            setScroll({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
          }}
          onMouseDown={(e) => {
            const p = cellAt(e);
            if (!p) return;
            e.currentTarget.focus();
            dragging.current = true;
            if (e.shiftKey) setFocus(p);
            else {
              setAnchor(p);
              setFocus(p);
            }
          }}
          onMouseMove={(e) => {
            if (!dragging.current) return;
            const p = cellAt(e);
            if (p) setFocus(p);
          }}
          onMouseUp={() => (dragging.current = false)}
          onMouseLeave={() => (dragging.current = false)}
        >
          {sheet && (
            <div className="grid-inner" style={{ width: HEAD_W + colPre[nCols], height: HEAD_H + rowPre[nRows], ['--sheet-zoom' as string]: zoom }}>
              {cells}
              {heads}
              <div className="corner" style={{ top: scroll.top, left: scroll.left, width: HEAD_W, height: HEAD_H, zIndex: 7 }} />
              {cited && cited.sheet === active && <div className="cited-box" style={boxRect(cited.box)} />}
              <div className="sel-box" style={boxRect(sel)} />
            </div>
          )}
          {!wb && <div className="empty">Reading {basename(path)}…</div>}
        </div>
        {wb && wb.sheets.length > 0 && (
          <div className="sheet-tabs">
            {wb.sheets.map((s, i) => (
              <div
                key={s.name}
                className={'sheet-tab' + (i === active ? ' active' : '')}
                style={s.tabColor ? { borderBottomColor: s.tabColor } : undefined}
                onClick={() => {
                  setActive(i);
                  setAnchor({ r: 1, c: 1 });
                  setFocus({ r: 1, c: 1 });
                }}
              >
                {s.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
