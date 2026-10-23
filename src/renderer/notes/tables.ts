// Markdown tables in notes always render as real tables (UI spec §4). A clicked cell is edited in
// place with a small editor of its own, and a toolbar adds or removes rows and columns; the
// markdown is never shown. Block replacements must come from a state field, not a view plugin,
// so this lives apart from the rest of the live preview.
import { EditorState, Prec, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { fileKind, parseDestination } from '../../core/link';
import { extractLinks } from '../../core/mdlinks';
import { iconSvg, kindIcon } from '../icons';
import { inlineEditorExtensions, linkAt, refBadges, refreshEffect, type LinkInfo, type NoteEditorOptions, type RefStatus } from './editor';

interface Cell {
  text: string;
  /** Document offset of the cell's first character (for an empty cell, where text would go). */
  from: number;
}

/** Splits a table row into cells, ignoring pipes inside code, link targets and link titles. */
export function splitRow(line: string, offset: number): Cell[] {
  const cells: Cell[] = [];
  let start = 0;
  let code = false;
  let dest = 0;
  let quote = false;
  const push = (end: number) => {
    const raw = line.slice(start, end);
    const text = raw.trim();
    const lead = text ? raw.length - raw.trimStart().length : Math.min(1, raw.length);
    cells.push({ text, from: offset + start + lead });
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`' && !dest) code = !code;
    else if (code) continue;
    else if (dest) {
      if (ch === '"') quote = !quote;
      else if (!quote && ch === '(') dest++;
      else if (!quote && ch === ')') dest--;
    } else if (ch === '(' && line[i - 1] === ']') dest = 1;
    else if (ch === '|') {
      if (i > 0) push(i);
      start = i + 1;
    }
  }
  if (line.slice(start).trim()) push(line.length);
  return cells;
}

function alignments(sep: string[]): ('left' | 'center' | 'right' | undefined)[] {
  return sep.map((text) => {
    const l = text.startsWith(':');
    const r = text.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
  });
}

/** Light inline formatting for cell text: **bold**, *italic*, `code`. */
function appendInline(parent: HTMLElement, text: string) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parent.append(unescapePipes(text.slice(last, m.index)));
    const t = m[0];
    const el = document.createElement(t.startsWith('**') ? 'strong' : t.startsWith('`') ? 'code' : 'em');
    el.textContent = unescapePipes(t.startsWith('**') ? t.slice(2, -2) : t.slice(1, -1));
    parent.append(el);
    last = m.index! + t.length;
  }
  if (last < text.length) parent.append(unescapePipes(text.slice(last)));
}

const unescapePipes = (s: string) => s.replace(/\\\|/g, '|');
const escapePipes = (s: string) => s.replace(/\\\|/g, '|').replace(/\|/g, '\\|');

// ---------- The table in the document ----------

interface Table {
  from: number;
  to: number;
  /** Header row first, then the body rows (the alignment row is kept apart). */
  rows: Cell[][];
  sep: string[];
  cols: number;
}

function readTable(state: EditorState, pos: number): Table | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== 'Table') continue;
    const from = state.doc.lineAt(n.from).from;
    const to = state.doc.lineAt(n.to).to;
    const lines = [];
    for (let p = from; p <= to; ) {
      const line = state.doc.lineAt(p);
      lines.push(line);
      p = line.to + 1;
    }
    const header = splitRow(lines[0].text, lines[0].from);
    const sep = lines[1] ? splitRow(lines[1].text, 0).map((c) => c.text) : [];
    const rows = [header, ...lines.slice(2).map((l) => splitRow(l.text, l.from))];
    return { from, to, rows, sep, cols: header.length };
  }
  return null;
}

function formatTable(rows: string[][], sep: string[]): string {
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
  return [line(rows[0]), line(sep), ...rows.slice(1).map(line)].join('\n');
}

/** A cell to start editing once the table has been redrawn after a change. */
let pendingFocus: { view: EditorView; from: number; row: number; col: number; select?: boolean } | null = null;

const wrapOpts = new WeakMap<HTMLElement, NoteEditorOptions>();

/** Dispatches a change to the note, then moves straight into the pending cell so no keys are lost. */
function dispatchThenFocus(view: EditorView, spec: Parameters<EditorView['dispatch']>[0]) {
  view.dispatch(spec);
  const p = pendingFocus;
  const wrap = p && p.view === view ? view.dom.querySelector<HTMLElement>(`.cm-md-table[data-from="${p.from}"]`) : null;
  const opts = wrap && wrapOpts.get(wrap);
  if (!p || !wrap || !opts) return;
  pendingFocus = null;
  startEdit(view, wrap, p.row, p.col, opts, p.select);
}

/** Inserts a new table below the cursor and starts editing its first header cell. */
export function insertTable(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const pos = line.length ? line.to : line.from;
  const before = line.length ? '\n\n' : line.number > 1 && state.doc.line(line.number - 1).length ? '\n' : '';
  const text = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';
  pendingFocus = { view, from: pos + before.length, row: 0, col: 0, select: true };
  dispatchThenFocus(view, {
    changes: { from: pos, insert: before + text + '\n\n' },
    selection: { anchor: pos + before.length + text.length + 2 },
    scrollIntoView: true,
  });
}

// ---------- Editing cells ----------

interface Editing {
  row: number;
  col: number;
  editor: EditorView;
  original: string;
}

const editing = new WeakMap<HTMLElement, Editing>();

const cellText = (ed: EditorView) => escapePipes(ed.state.doc.toString().replace(/\s*\n\s*/g, ' ').trim());

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly key: string,
    readonly opts: NoteEditorOptions,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source && o.key === this.key && o.from === this.from;
  }
  toDOM(view: EditorView) {
    const opts = this.opts;
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table';
    wrap.dataset.from = String(this.from);
    wrapOpts.set(wrap, opts);
    const table = document.createElement('table');
    wrap.append(table, tableTools(view, wrap, opts));
    const t = readTable(view.state, this.from);
    if (!t) return wrap;
    const align = alignments(t.sep);
    t.rows.forEach((cells, r) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < t.cols; c++) {
        const td = document.createElement(r === 0 ? 'th' : 'td');
        td.dataset.row = String(r);
        td.dataset.col = String(c);
        if (align[c]) td.style.textAlign = align[c]!;
        fillCell(td, cells[c] ?? { text: '', from: -1 }, view, opts);
        td.addEventListener('mousedown', (e) => {
          if ((e.target as HTMLElement).closest('.cm-ref, .cm-weblink, a, .editing-cell')) return;
          e.preventDefault();
          startEdit(view, wrap, r, c, opts);
        });
        tr.append(td);
      }
      table.append(tr);
    });
    // Normally dispatchThenFocus starts the pending cell at once; this catches redraws it misses.
    if (pendingFocus && pendingFocus.view === view && pendingFocus.from === this.from) {
      requestAnimationFrame(() => {
        const p = pendingFocus;
        if (!p || p.view !== view || p.from !== this.from || !wrap.isConnected) return;
        pendingFocus = null;
        startEdit(view, wrap, p.row, p.col, opts, p.select);
      });
    }
    return wrap;
  }
  destroy(dom: HTMLElement) {
    editing.get(dom)?.editor.destroy();
    editing.delete(dom);
  }
  ignoreEvent() {
    return true;
  }
}

function fillCell(td: HTMLElement, cell: Cell, view: EditorView, opts: NoteEditorOptions) {
  td.textContent = '';
  let last = 0;
  for (const link of extractLinks(cell.text)) {
    appendInline(td, cell.text.slice(last, link.from));
    last = link.to;
    const ref = parseDestination(link.dest);
    if (!ref) continue;
    if (ref.pathKind === 'web') {
      const a = document.createElement('a');
      a.className = 'cm-weblink';
      a.textContent = link.label;
      a.title = link.dest;
      a.addEventListener('mousedown', (e) => {
        e.preventDefault();
        window.open(link.dest, '_blank');
      });
      td.append(a);
      continue;
    }
    const pos = cell.from + link.from + 1;
    const info = linkAt(view.state, pos);
    const status: RefStatus = info ? opts.refStatus(info) : { state: 'unknown' };
    const span = document.createElement('span');
    span.className = 'cm-ref' + (status.state === 'broken' ? ' broken' : '');
    span.innerHTML = iconSvg(kindIcon(fileKind(ref.path)));
    span.append(link.label, ...refBadges(status));
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fresh: LinkInfo | null = linkAt(view.state, pos);
      if (fresh) opts.onFollow(fresh);
    });
    td.append(span);
  }
  appendInline(td, cell.text.slice(last));
}

/** Where the table starts in the document (widgets are redrawn whenever that changes). */
const tableFrom = (wrap: HTMLElement) => Number(wrap.dataset.from);

const cellAt = (wrap: HTMLElement, row: number, col: number) =>
  wrap.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);

function startEdit(view: EditorView, wrap: HTMLElement, row: number, col: number, opts: NoteEditorOptions, select = false) {
  const current = editing.get(wrap);
  if (current) {
    if (current.row !== row || current.col !== col) finishEdit(view, wrap, opts, { row, col, select });
    return;
  }
  const td = cellAt(wrap, row, col);
  const t = readTable(view.state, tableFrom(wrap));
  if (!td || !t) return;
  const original = t.rows[row]?.[col]?.text ?? '';
  td.textContent = '';
  td.classList.add('editing-cell');
  const move = (r: number, c: number) => {
    finishEdit(view, wrap, opts, { row: r, col: c, select: true });
    return true;
  };
  const rows = t.rows.length;
  const editor = new EditorView({
    parent: td,
    state: EditorState.create({
      doc: unescapePipes(original),
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: 'Tab',
              run: () =>
                col + 1 < t.cols
                  ? move(row, col + 1)
                  : row + 1 < rows
                    ? move(row + 1, 0)
                    : (changeTable(view, wrap, opts, 'rowBelow', { row: row + 1, col: 0 }), true),
            },
            { key: 'Shift-Tab', run: () => (col > 0 ? move(row, col - 1) : row > 0 ? move(row - 1, t.cols - 1) : true) },
            { key: 'Enter', run: () => (row + 1 < rows ? move(row + 1, col) : (changeTable(view, wrap, opts, 'rowBelow'), true)) },
            { key: 'ArrowUp', run: () => (row > 0 ? move(row - 1, col) : false) },
            { key: 'ArrowDown', run: () => (row + 1 < rows ? move(row + 1, col) : false) },
            {
              key: 'Escape',
              run: () => {
                finishEdit(view, wrap, opts);
                view.focus();
                return true;
              },
            },
            {
              key: 'Mod-s',
              run: () => {
                finishEdit(view, wrap, opts);
                opts.onSave();
                return true;
              },
            },
          ]),
        ),
        inlineEditorExtensions(opts),
        EditorView.domEventHandlers({
          blur: () => {
            // Leaving the table (not moving to another cell or the toolbar) saves the cell.
            setTimeout(() => {
              const e = editing.get(wrap);
              if (e && e.editor === editor && !editor.hasFocus) finishEdit(view, wrap, opts);
            }, 0);
          },
        }),
      ],
    }),
  });
  editing.set(wrap, { row, col, editor, original });
  wrap.classList.add('editing');
  for (const b of wrap.querySelectorAll<HTMLButtonElement>('.cm-table-tools button')) {
    const op = b.dataset.op;
    b.disabled = (row === 0 && (op === 'rowAbove' || op === 'deleteRow')) || (t.cols < 2 && op === 'deleteCol');
  }
  editor.focus();
  const len = editor.state.doc.length;
  editor.dispatch({ selection: select ? { anchor: 0, head: len } : { anchor: len } });
}

/** Saves the cell being edited; then starts editing `next`, if given. */
function finishEdit(view: EditorView, wrap: HTMLElement, opts: NoteEditorOptions, next?: { row: number; col: number; select?: boolean }) {
  const e = editing.get(wrap);
  if (!e) return;
  const text = cellText(e.editor);
  const t = readTable(view.state, tableFrom(wrap));
  const cell = t?.rows[e.row]?.[e.col];
  editing.delete(wrap);
  if (!t || text === e.original) {
    // Nothing changed: show the cell again and move on without touching the document.
    e.editor.destroy();
    const td = cellAt(wrap, e.row, e.col);
    if (td) {
      td.classList.remove('editing-cell');
      fillCell(td, cell ?? { text: '', from: -1 }, view, opts);
    }
    wrap.classList.remove('editing');
    if (next) startEdit(view, wrap, next.row, next.col, opts, next.select);
    return;
  }
  if (!cell) {
    // The row is short of cells: rewrite the whole table (changeTable keeps the edit).
    editing.set(wrap, e);
    return changeTable(view, wrap, opts, null, next);
  }
  e.editor.destroy();
  pendingFocus = next ? { view, from: t.from, ...next } : null;
  dispatchThenFocus(view, { changes: { from: cell.from, to: cell.from + cell.text.length, insert: text }, userEvent: 'input.table' });
}

type TableOp = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'deleteRow' | 'deleteCol' | 'deleteTable';

/** Rewrites the table with a row or column added or removed, keeping any cell edit in progress. */
function changeTable(view: EditorView, wrap: HTMLElement, opts: NoteEditorOptions, op: TableOp | null, next?: { row: number; col: number }) {
  const t = readTable(view.state, tableFrom(wrap));
  const e = editing.get(wrap);
  if (!t) return;
  editing.delete(wrap);
  e?.editor.destroy();
  if (op === 'deleteTable') {
    const end = view.state.sliceDoc(t.to, t.to + 1) === '\n' ? t.to + 1 : t.to;
    view.dispatch({ changes: { from: t.from, to: end }, selection: { anchor: t.from }, userEvent: 'delete.table' });
    view.focus();
    return;
  }
  const rows = t.rows.map((cells) => Array.from({ length: t.cols }, (_, c) => cells[c]?.text ?? ''));
  const sep = Array.from({ length: t.cols }, (_, c) => t.sep[c] || '---');
  let row = e?.row ?? 0;
  let col = e?.col ?? 0;
  if (e) rows[e.row][e.col] = cellText(e.editor);
  const blank = () => Array.from({ length: rows[0].length }, () => '');
  switch (op) {
    case 'rowAbove':
      rows.splice(Math.max(1, row), 0, blank());
      row = Math.max(1, row);
      break;
    case 'rowBelow':
      rows.splice(row + 1, 0, blank());
      row += 1;
      break;
    case 'colLeft':
      rows.forEach((r) => r.splice(col, 0, ''));
      sep.splice(col, 0, '---');
      break;
    case 'colRight':
      rows.forEach((r) => r.splice(col + 1, 0, ''));
      sep.splice(col + 1, 0, '---');
      col += 1;
      break;
    case 'deleteRow':
      if (row > 0) rows.splice(row, 1);
      row = Math.min(row, rows.length - 1);
      break;
    case 'deleteCol':
      if (rows[0].length > 1) {
        rows.forEach((r) => r.splice(col, 1));
        sep.splice(col, 1);
      }
      col = Math.min(col, rows[0].length - 1);
      break;
  }
  if (next) ({ row, col } = next);
  pendingFocus = { view, from: t.from, row, col };
  dispatchThenFocus(view, { changes: { from: t.from, to: t.to, insert: formatTable(rows, sep) }, userEvent: 'input.table' });
}

const TOOLS: [TableOp, string, string][] = [
  ['rowAbove', '↑ Row', 'Insert a row above'],
  ['rowBelow', '↓ Row', 'Insert a row below'],
  ['colLeft', '← Column', 'Insert a column to the left'],
  ['colRight', '→ Column', 'Insert a column to the right'],
  ['deleteRow', 'Delete row', 'Delete this row'],
  ['deleteCol', 'Delete column', 'Delete this column'],
  ['deleteTable', 'Delete table', 'Delete the whole table'],
];

function tableTools(view: EditorView, wrap: HTMLElement, opts: NoteEditorOptions): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'cm-table-tools';
  for (const [op, label, title] of TOOLS) {
    const b = document.createElement('button');
    b.dataset.op = op;
    b.textContent = label;
    b.title = title;
    if (op.startsWith('delete')) b.className = 'danger';
    // Keep focus in the cell being edited.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => changeTable(view, wrap, opts, op));
    bar.append(b);
  }
  return bar;
}

// ---------- Decorations ----------

function buildTables(state: EditorState, opts: NoteEditorOptions): DecorationSet {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const decos: Range<Decoration>[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'Table') return;
      const from = state.doc.lineAt(n.from).from;
      const to = state.doc.lineAt(n.to).to;
      const source = state.sliceDoc(from, to);
      // Statuses go into the key so badges and broken marks refresh after link checks.
      const key = extractLinks(source)
        .map((l) => {
          const info = linkAt(state, from + l.from + 1);
          const st = info ? opts.refStatus(info) : null;
          return `${st?.state}:${st?.badge ?? ''}:${st?.changed ?? ''}`;
        })
        .join(',');
      decos.push(Decoration.replace({ widget: new TableWidget(source, from, key, opts), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(decos, true);
}

export function renderedTables(opts: NoteEditorOptions): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildTables(state, opts),
    update(value, tr) {
      if (tr.docChanged || tr.effects.some((e) => e.is(refreshEffect))) return buildTables(tr.state, opts);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
