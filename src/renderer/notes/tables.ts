// Markdown tables in notes render as real tables while the cursor is outside them (UI spec §4).
// Block replacements must come from a state field, not a view plugin, so this lives apart from
// the rest of the live preview.
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { fileKind, parseDestination } from '../../core/link';
import { extractLinks } from '../../core/mdlinks';
import { iconSvg, kindIcon } from '../icons';
import { linkAt, refreshEffect, type LinkInfo, type NoteEditorOptions } from './editor';

interface Cell {
  text: string;
  /** Document offset of the cell's first character. */
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
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), from: offset + start + lead });
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

function alignments(sep: string): ('left' | 'center' | 'right' | undefined)[] {
  return splitRow(sep, 0).map(({ text }) => {
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
    if (m.index! > last) parent.append(text.slice(last, m.index));
    const t = m[0];
    const el = document.createElement(t.startsWith('**') ? 'strong' : t.startsWith('`') ? 'code' : 'em');
    el.textContent = t.startsWith('**') ? t.slice(2, -2) : t.slice(1, -1);
    parent.append(el);
    last = m.index! + t.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

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
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table';
    const table = document.createElement('table');
    wrap.append(table);
    const lines = this.source.split('\n');
    let offset = this.from;
    const rows: Cell[][] = [];
    for (const line of lines) {
      rows.push(splitRow(line.replace(/\r$/, ''), offset));
      offset += line.length + 1;
    }
    const align = lines[1] ? alignments(lines[1]) : [];
    rows.forEach((cells, r) => {
      if (r === 1) return;
      const tr = document.createElement('tr');
      cells.forEach((cell, c) => {
        const td = document.createElement(r === 0 ? 'th' : 'td');
        if (align[c]) td.style.textAlign = align[c]!;
        this.fillCell(td, cell, view);
        tr.append(td);
      });
      table.append(tr);
    });
    // Double-clicking the table (not a link) puts the cursor in it to edit the markdown.
    wrap.title = 'Double-click to edit the table';
    wrap.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.cm-ref, a')) return;
      e.preventDefault();
      if (e.detail < 2) return;
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  private fillCell(td: HTMLElement, cell: Cell, view: EditorView) {
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
      const status = info ? this.opts.refStatus(info) : { state: 'unknown' as const };
      const span = document.createElement('span');
      span.className = 'cm-ref' + (status.state === 'broken' ? ' broken' : '');
      span.innerHTML = iconSvg(kindIcon(fileKind(ref.path)));
      span.append(link.label);
      if (status.badge) {
        const b = document.createElement('span');
        b.className = 'badge mark';
        b.textContent = status.badge;
        span.append(b);
      }
      span.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const fresh: LinkInfo | null = linkAt(view.state, pos);
        if (fresh) this.opts.onFollow(fresh);
      });
      td.append(span);
    }
    appendInline(td, cell.text.slice(last));
  }
  ignoreEvent() {
    return true;
  }
}

function buildTables(state: EditorState, opts: NoteEditorOptions): DecorationSet {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const decos: Range<Decoration>[] = [];
  const sel = state.selection;
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'Table') return;
      const from = state.doc.lineAt(n.from).from;
      const to = state.doc.lineAt(n.to).to;
      if (sel.ranges.some((r) => r.from <= to && r.to >= from)) return false;
      const source = state.sliceDoc(from, to);
      // Statuses go into the key so badges and broken marks refresh after link checks.
      const key = extractLinks(source)
        .map((l) => {
          const info = linkAt(state, from + l.from + 1);
          const st = info ? opts.refStatus(info) : null;
          return `${st?.state}:${st?.badge ?? ''}`;
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
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshEffect))) return buildTables(tr.state, opts);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
