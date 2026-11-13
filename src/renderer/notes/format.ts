// Formatting commands for the note editor. They work from the note's structure (the markdown
// syntax tree), so italic on bold text keeps the bold and un-bolding part of a phrase leaves the
// rest bold.
import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { redoDepth, undoDepth } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

export type InlineMark = '**' | '*' | '~~' | '`';
export type LinePrefix = '- ' | '1. ' | '- [ ] ' | '> ';

const NODE_OF: Record<InlineMark, string> = { '**': 'StrongEmphasis', '*': 'Emphasis', '~~': 'Strikethrough', '`': 'InlineCode' };

/** What applies at the cursor: drives which toolbar buttons are lit. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  /** 0 = paragraph. */
  heading: number;
  list: 'bullet' | 'number' | 'task' | null;
  quote: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export const NO_FORMAT: FormatState = { bold: false, italic: false, strike: false, code: false, heading: 0, list: null, quote: false, canUndo: false, canRedo: false };

/** Quote and list markers at the start of a line, then a heading marker if there is one. */
const BLOCK_PREFIX = /^((?:\s*>\s?)*\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?)(#{1,6}\s+)?/;

/** The innermost node of the given kind that contains the whole range. */
function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  // Straight after typing, the background parse may not have reached the cursor yet.
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 100) ?? syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(from, side); n; n = n.parent) {
      if (n.name === name && n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

export function formatState(state: EditorState): FormatState {
  const r = state.selection.main;
  const inside = (mark: InlineMark) => !!enclosing(state, r.from, r.to, NODE_OF[mark]);
  const text = state.doc.lineAt(r.head).text;
  const m = text.match(BLOCK_PREFIX)!;
  const marker = m[1];
  return {
    bold: inside('**'),
    italic: inside('*'),
    strike: inside('~~'),
    code: inside('`'),
    heading: m[2] ? m[2].trim().length : 0,
    list: /\[[ xX]\]\s+$/.test(marker) ? 'task' : /\d+[.)]\s+$/.test(marker) ? 'number' : /[-*+]\s+$/.test(marker) ? 'bullet' : null,
    quote: /^\s*>/.test(marker),
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

/** The parts of a selection to format: one per line, without block markers or outer spaces. */
function segments(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  if (from === to) return [{ from, to }];
  const out: { from: number; to: number }[] = [];
  for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) {
    const line = state.doc.line(l);
    let a = Math.max(from, line.from + line.text.match(BLOCK_PREFIX)![0].length);
    let b = Math.min(to, line.to);
    while (a < b && /\s/.test(state.sliceDoc(a, a + 1))) a++;
    while (b > a && /\s/.test(state.sliceDoc(b - 1, b))) b--;
    if (a < b) out.push({ from: a, to: b });
  }
  return out;
}

/** Bold, italic, strikethrough or inline code on the selection (or at the cursor). */
export function toggleWrap(view: EditorView, mark: InlineMark) {
  const state = view.state;
  const name = NODE_OF[mark];
  view.dispatch(
    state.changeByRange((r) => {
      const changes: ChangeSpec[] = [];
      const segs = segments(state, r.from, r.to);
      const remove = segs.length > 0 && segs.every((s) => enclosing(state, s.from, s.to, name));
      let cursor: number | null = null;
      for (const s of segs) {
        const node = enclosing(state, s.from, s.to, name);
        if (remove && node) {
          const open = node.firstChild!;
          const close = node.lastChild!;
          let a = Math.max(s.from, open.to);
          let b = Math.min(s.to, close.from);
          // Other marks between the selection and this node's own marks (bold inside italic) don't count as text.
          const atStart = /^[*_~`]*$/.test(state.sliceDoc(open.to, a));
          const atEnd = /^[*_~`]*$/.test(state.sliceDoc(b, close.from));
          if (a >= b || (atStart && atEnd)) {
            // The cursor is in it, or all of it is selected: take the marks away.
            changes.push({ from: open.from, to: open.to }, { from: close.from, to: close.to });
          } else {
            // Part of it: end the formatting before the selection and start it again after. A mark
            // must touch the word it belongs to, so spaces stay outside.
            while (a > open.to && /\s/.test(state.sliceDoc(a - 1, a))) a--;
            while (b < close.from && /\s/.test(state.sliceDoc(b, b + 1))) b++;
            if (atStart) changes.push({ from: open.from, to: open.to });
            else changes.push({ from: a, insert: mark });
            if (atEnd) changes.push({ from: close.from, to: close.to });
            else changes.push({ from: b, insert: mark });
          }
        } else if (!remove && !node) {
          if (s.from === s.to) {
            changes.push({ from: s.from, insert: mark + mark });
            cursor = s.from;
          } else {
            // Formatting of the same kind already inside the selection is merged into the new one.
            syntaxTree(state).iterate({
              from: s.from,
              to: s.to,
              enter: (n) => {
                if (n.name !== name || n.from < s.from || n.to > s.to) return;
                const inner = n.node;
                changes.push({ from: inner.firstChild!.from, to: inner.firstChild!.to }, { from: inner.lastChild!.from, to: inner.lastChild!.to });
              },
            });
            changes.push({ from: s.from, insert: mark }, { from: s.to, insert: mark });
          }
        }
      }
      const set = state.changes(changes);
      const range = cursor !== null ? EditorSelection.cursor(set.mapPos(cursor, -1) + mark.length) : EditorSelection.range(set.mapPos(r.anchor, r.anchor <= r.head ? 1 : -1), set.mapPos(r.head, r.head < r.anchor ? 1 : -1));
      return { changes: set, range };
    }),
  );
  view.focus();
}

/** Applies changes at the starts of lines; a cursor sitting there ends up after what was inserted. */
function apply(view: EditorView, changes: ChangeSpec[]) {
  const set = view.state.changes(changes);
  view.dispatch({ changes: set, selection: view.state.selection.map(set, 1) });
}

function selectedLines(view: EditorView) {
  const lines = new Map<number, { from: number; text: string }>();
  for (const r of view.state.selection.ranges) {
    for (let l = view.state.doc.lineAt(r.from).number; l <= view.state.doc.lineAt(r.to).number; l++) {
      const line = view.state.doc.line(l);
      lines.set(line.from, { from: line.from, text: line.text });
    }
  }
  return [...lines.values()];
}

/** Paragraph (0) or heading 1-6. A heading inside a quote or list keeps the quote or bullet. */
export function setHeading(view: EditorView, level: number) {
  const changes = selectedLines(view).map(({ from, text }) => {
    const m = text.match(BLOCK_PREFIX)!;
    const at = from + m[1].length;
    return { from: at, to: at + (m[2]?.length ?? 0), insert: level > 0 ? '#'.repeat(level) + ' ' : '' };
  });
  apply(view, changes);
  view.focus();
}

const INDENT = /^\s*/;
const LIST_MARK = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE_MARK = /^>\s?/;

const kindOf = (rest: string): LinePrefix | null =>
  /^[-*+]\s+\[[ xX]\]\s/.test(rest) ? '- [ ] ' : /^[-*+]\s/.test(rest) ? '- ' : /^\d+[.)]\s/.test(rest) ? '1. ' : null;

/** Bulleted, numbered or task list, or quote. A list changes kind in place; the same button again removes it. */
export function toggleLinePrefix(view: EditorView, prefix: LinePrefix) {
  const lines = selectedLines(view).filter((l, _i, all) => all.length === 1 || l.text.trim());
  const parts = lines.map((l) => {
    const indent = l.text.match(INDENT)![0];
    return { ...l, indent, rest: l.text.slice(indent.length) };
  });
  const quote = prefix === '> ';
  const has = (rest: string) => (quote ? QUOTE_MARK.test(rest) : kindOf(rest) === prefix);
  const remove = parts.length > 0 && parts.every((l) => has(l.rest));
  const counters = new Map<string, number>();
  const changes = parts.map(({ from, indent, rest }) => {
    const at = from + indent.length;
    if (quote) return remove ? { from: at, to: at + rest.match(QUOTE_MARK)![0].length } : { from: at, insert: '> ' };
    const old = rest.match(LIST_MARK)?.[0].length ?? 0;
    // Numbers count separately at each level of nesting.
    const n = (counters.get(indent) ?? 0) + 1;
    counters.set(indent, n);
    return { from: at, to: at + old, insert: remove ? '' : prefix === '1. ' ? `${n}. ` : prefix };
  });
  apply(view, changes);
  view.focus();
}

/** Tab and Shift+Tab on list items: one level in or out. False when the cursor isn't in a list. */
export function nestList(view: EditorView, dir: 1 | -1): boolean {
  const lines = selectedLines(view);
  const items = lines.map((l) => {
    const indent = l.text.match(INDENT)![0];
    const mark = l.text.slice(indent.length).match(LIST_MARK)?.[0];
    return { ...l, indent, mark };
  });
  if (!items.length || items.some((l) => !l.mark)) return false;
  const changes: ChangeSpec[] = [];
  for (const l of items) {
    // A nested item starts under its parent's text: two spaces for a bullet, three for "1. ".
    const step = /^\d/.test(l.mark!) ? 3 : 2;
    if (dir > 0) changes.push({ from: l.from, insert: ' '.repeat(step) });
    else if (l.indent.length) changes.push({ from: l.from, to: l.from + Math.min(step, l.indent.length) });
  }
  if (changes.length) apply(view, changes);
  return true;
}
