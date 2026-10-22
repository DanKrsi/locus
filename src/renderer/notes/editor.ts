// Markdown note editor: CodeMirror 6 with Obsidian-style live preview, reference widgets,
// the inline rename box used when citing, and hover cards (UI spec §4).
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  hoverTooltip,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { SyntaxNode } from '@lezer/common';
import { escapeLabel, fileKind, parseDestination, splitLinkTarget, type Reference } from '../../core/link';
import { iconSvg, kindIcon } from '../icons';

export interface LinkInfo {
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  label: string;
  dest: string;
  title?: string;
  ref: Reference;
  image: boolean;
}

export type RefStatus = { state: 'ok' | 'broken' | 'unknown'; reason?: string; badge?: string };

export interface NoteEditorOptions {
  doc: string;
  eol: string;
  onChange(): void;
  onSave(): void;
  onFollow(info: LinkInfo): void;
  refStatus(info: LinkInfo): RefStatus;
  imageUrl(info: LinkInfo): string | null;
  renderHoverCard(info: LinkInfo, view: EditorView): HTMLElement;
}

/** Ask the editor to rebuild decorations (e.g. after async link checks finish). */
export const refreshEffect = StateEffect.define<null>();

// ---------- Links ----------

function unescapeLabel(s: string): string {
  return s.replace(/\\([\\\[\]])/g, '$1');
}

function linkFromNode(state: EditorState, node: SyntaxNode): LinkInfo | null {
  const marks = node.getChildren('LinkMark');
  const url = node.getChild('URL');
  if (!url || marks.length < 3) return null;
  const image = node.name === 'Image';
  const open = marks[0];
  const close = marks.find((m) => state.sliceDoc(m.from, m.to) === ']');
  if (!close) return null;
  const paren = marks.find((m) => m.from >= close.to && state.sliceDoc(m.from, m.to) === '(');
  const end = marks[marks.length - 1];
  if (!paren || state.sliceDoc(end.from, end.to) !== ')') return null;
  const inner = state.sliceDoc(paren.to, end.from);
  const { dest, title } = splitLinkTarget(inner);
  const ref = parseDestination(dest);
  if (!ref) return null;
  const labelFrom = open.to;
  const labelTo = close.from;
  return {
    from: node.from,
    to: node.to,
    labelFrom,
    labelTo,
    label: unescapeLabel(state.sliceDoc(labelFrom, labelTo)),
    dest,
    title,
    ref,
    image,
  };
}

export function linkAt(state: EditorState, pos: number): LinkInfo | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Link' || n.name === 'Image') return linkFromNode(state, n);
    }
  }
  return null;
}

export function allLinks(state: EditorState): LinkInfo[] {
  const out: LinkInfo[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === 'Link' || n.name === 'Image') {
        const info = linkFromNode(state, n.node);
        if (info) out.push(info);
        return false;
      }
    },
  });
  return out;
}

// ---------- Rename box ----------

interface RenameState {
  labelFrom: number;
  labelTo: number;
  linkTo: number;
  defaultLabel: string;
}

const startRename = StateEffect.define<RenameState>();
const endRename = StateEffect.define<null>();

const renameField = StateField.define<RenameState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(startRename)) return e.value;
      if (e.is(endRename)) return null;
    }
    if (value && tr.docChanged) {
      return {
        ...value,
        labelFrom: tr.changes.mapPos(value.labelFrom, -1),
        labelTo: tr.changes.mapPos(value.labelTo, 1),
        linkTo: tr.changes.mapPos(value.linkTo, 1),
      };
    }
    return value;
  },
});

/** Ends the rename when the cursor leaves the label, restoring the default if it was emptied. */
const renameFilter = EditorState.transactionFilter.of((tr) => {
  const r = tr.startState.field(renameField, false);
  if (!r || tr.effects.some((e) => e.is(endRename) || e.is(startRename))) return tr;
  if (!tr.selection && !tr.docChanged) return tr;
  const from = tr.changes.mapPos(r.labelFrom, -1);
  const to = tr.changes.mapPos(r.labelTo, 1);
  const head = (tr.selection ?? tr.startState.selection.map(tr.changes)).main.head;
  if (head >= from && head <= to) return tr;
  return [
    tr,
    {
      changes: from === to ? { from, insert: escapeLabel(r.defaultLabel) } : undefined,
      effects: endRename.of(null),
      sequential: true,
    },
  ];
});

function finishRename(view: EditorView, restoreDefault: boolean): boolean {
  const r = view.state.field(renameField, false);
  if (!r) return false;
  const current = view.state.sliceDoc(r.labelFrom, r.labelTo);
  const replace = restoreDefault || current.trim() === '' ? escapeLabel(r.defaultLabel) : null;
  const delta = replace === null ? 0 : replace.length - (r.labelTo - r.labelFrom);
  view.dispatch({
    changes: replace === null ? undefined : { from: r.labelFrom, to: r.labelTo, insert: replace },
    selection: { anchor: r.linkTo + delta },
    effects: endRename.of(null),
    userEvent: 'input.rename',
  });
  return true;
}

const renameKeymap = Prec.highest(
  keymap.of([
    { key: 'Enter', run: (v) => finishRename(v, false) },
    { key: 'Escape', run: (v) => finishRename(v, true) },
    { key: 'Tab', run: (v) => finishRename(v, false) },
  ]),
);

/** Inserts a reference at the cursor and opens the rename box over its label. */
export function insertReference(view: EditorView, build: (label: string) => string, defaultLabel: string) {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to).trim();
  const label = selected && !selected.includes('\n') && !/[\[\]()]/.test(selected) ? selected : defaultLabel;
  const text = build(label);
  const labelFrom = sel.from + 1;
  const labelTo = labelFrom + escapeLabel(label).length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: EditorSelection.range(labelFrom, labelTo),
    effects: startRename.of({ labelFrom, labelTo, linkTo: sel.from + text.length, defaultLabel: label }),
    scrollIntoView: true,
    userEvent: 'input.cite',
  });
  view.focus();
}

export function renameLink(view: EditorView, info: LinkInfo) {
  view.dispatch({
    selection: EditorSelection.range(info.labelFrom, info.labelTo),
    effects: startRename.of({ labelFrom: info.labelFrom, labelTo: info.labelTo, linkTo: info.to, defaultLabel: info.label }),
    scrollIntoView: true,
  });
  view.focus();
}

export function removeLink(view: EditorView, info: LinkInfo) {
  view.dispatch({ changes: { from: info.from, to: info.to, insert: escapeLabel(info.label) } });
}

/** Shows the raw markdown of a link so its target can be edited by hand. */
export function revealLink(view: EditorView, info: LinkInfo) {
  view.dispatch({ selection: { anchor: info.labelTo + 2 }, scrollIntoView: true });
  view.focus();
}

export function replaceLink(view: EditorView, info: LinkInfo, text: string) {
  view.dispatch({ changes: { from: info.from, to: info.to, insert: text } });
}

/** Briefly highlights a link (tour mode / "flash"). */
export function flashRange(view: EditorView, from: number, to: number) {
  view.dispatch({ effects: [flashEffect.of({ from, to }), EditorView.scrollIntoView(from, { y: 'center' })] });
  setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1600);
}

/** The link currently shown by tour mode, highlighted in the note. */
const setActiveEffect = StateEffect.define<number | null>();
const activeLinkField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveEffect)) return e.value;
    return value !== null && tr.docChanged ? tr.changes.mapPos(value, 1) : value;
  },
});

export function setActiveLink(view: EditorView, from: number | null) {
  view.dispatch({ effects: [setActiveEffect.of(from), ...(from !== null ? [EditorView.scrollIntoView(from, { y: 'center' })] : [])] });
}

/** Scrolls to a line and flashes it ("Cited in" jumps). */
export function flashLine(view: EditorView, line: number) {
  const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
  flashRange(view, l.from, l.to);
}

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        value = e.value ? Decoration.set([Decoration.mark({ class: 'cm-flash' }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- Widgets ----------

class RefWidget extends WidgetType {
  constructor(
    readonly info: LinkInfo,
    readonly status: RefStatus,
    readonly onFollow: (info: LinkInfo) => void,
    readonly active = false,
  ) {
    super();
  }
  eq(other: RefWidget) {
    return (
      other.info.label === this.info.label &&
      other.info.dest === this.info.dest &&
      other.status.state === this.status.state &&
      other.status.badge === this.status.badge &&
      other.active === this.active
    );
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    const broken = this.status.state === 'broken';
    span.className = 'cm-ref' + (broken ? ' broken' : '') + (this.active ? ' active' : '');
    if (broken && this.status.reason) span.title = this.status.reason;
    span.innerHTML = iconSvg(kindIcon(fileKind(this.info.ref.path)));
    span.append(this.info.label);
    if (this.status.badge) {
      const b = document.createElement('span');
      b.className = 'badge mark';
      b.textContent = this.status.badge;
      span.append(b);
    }
    span.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const fresh = linkAt(view.state, view.posAtDOM(span)) ?? this.info;
      this.onFollow(fresh);
    });
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

class WebLinkWidget extends WidgetType {
  constructor(readonly label: string, readonly href: string) {
    super();
  }
  eq(o: WebLinkWidget) {
    return o.label === this.label && o.href === this.href;
  }
  toDOM() {
    const a = document.createElement('span');
    a.className = 'cm-weblink';
    a.textContent = this.label;
    a.title = this.href;
    a.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.open(this.href, '_blank');
    });
    return a;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-image';
    img.src = this.src;
    img.alt = this.alt;
    return img;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-hr-widget';
    return s;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly done: boolean, readonly pos: number) {
    super();
  }
  eq(o: TaskWidget) {
    return o.done === this.done && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = 'cm-task' + (this.done ? ' done' : '');
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.done ? ' ' : 'x' } });
    });
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: HintWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-rename-hint';
    s.textContent = this.text;
    return s;
  }
}

// ---------- Live preview ----------

const hide = Decoration.replace({});
const markCls = (cls: string) => Decoration.mark({ class: cls });

function buildDecorations(view: EditorView, opts: NoteEditorOptions): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const sel = state.selection;
  const rename = state.field(renameField, false);
  const activeLines = new Set<number>();
  for (const r of sel.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) activeLines.add(l);
  }
  const lineActive = (pos: number) => activeLines.has(state.doc.lineAt(pos).number);
  // A construct is "being edited" when the cursor is strictly inside it or a selection overlaps it.
  const editing = (from: number, to: number) =>
    sel.ranges.some((r) => (r.empty ? r.head > from && r.head < to : r.from < to && r.to > from));
  const lineDecos = new Set<string>();
  const lineDeco = (pos: number, cls: string) => {
    const line = state.doc.lineAt(pos);
    const key = `${line.from}:${cls}`;
    if (lineDecos.has(key)) return;
    lineDecos.add(key);
    decos.push(Decoration.line({ class: cls }).range(line.from));
  };
  const eachLine = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      lineDeco(line.from, cls);
      pos = line.to + 1;
    }
  };
  const hideMarks = (node: SyntaxNode, markName: string, active: boolean) => {
    for (const m of node.getChildren(markName)) {
      decos.push((active ? markCls('cm-mdmark') : hide).range(m.from, m.to));
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const node = ref.node;
        const name = ref.name;
        const heading = name.match(/^ATXHeading(\d)$/);
        if (heading) {
          lineDeco(node.from, `cm-h${heading[1]}`);
          const mark = node.getChild('HeaderMark');
          if (mark) {
            if (lineActive(node.from)) decos.push(markCls('cm-hmark').range(mark.from, mark.to));
            else {
              const end = state.sliceDoc(mark.to, mark.to + 1) === ' ' ? mark.to + 1 : mark.to;
              decos.push(hide.range(mark.from, end));
            }
          }
          return;
        }
        switch (name) {
          case 'StrongEmphasis':
          case 'Emphasis':
          case 'Strikethrough': {
            const cls = name === 'StrongEmphasis' ? 'cm-strong' : name === 'Emphasis' ? 'cm-em' : 'cm-strike';
            decos.push(markCls(cls).range(node.from, node.to));
            hideMarks(node, name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark', editing(node.from, node.to) || lineActive(node.from));
            return;
          }
          case 'InlineCode': {
            decos.push(markCls('cm-inline-code').range(node.from, node.to));
            hideMarks(node, 'CodeMark', editing(node.from, node.to));
            return false;
          }
          case 'Link':
          case 'Image': {
            const info = linkFromNode(state, node);
            if (!info) return false;
            if (rename && rename.labelFrom === info.labelFrom) {
              decos.push(hide.range(info.from, info.labelFrom));
              if (info.labelTo > info.labelFrom) decos.push(markCls('cm-renaming').range(info.labelFrom, info.labelTo));
              decos.push(hide.range(info.labelTo, info.to));
              decos.push(
                Decoration.widget({ widget: new HintWidget(`Enter to name · Esc keeps "${rename.defaultLabel}"`), side: 1 }).range(info.to),
              );
              return false;
            }
            if (editing(info.from, info.to)) {
              const paren = state.sliceDoc(info.labelTo, info.labelTo + 2) === '](' ? info.labelTo : -1;
              if (paren >= 0) decos.push(markCls('cm-mdmark').range(paren, info.to));
              return false;
            }
            if (info.image) {
              const src = opts.imageUrl(info);
              if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src, info.label) }).range(info.from, info.to));
              return false;
            }
            const widget =
              info.ref.pathKind === 'web'
                ? new WebLinkWidget(info.label, info.dest)
                : new RefWidget(info, opts.refStatus(info), opts.onFollow, state.field(activeLinkField, false) === info.from);
            decos.push(Decoration.replace({ widget }).range(info.from, info.to));
            return false;
          }
          case 'Blockquote': {
            eachLine(node.from, node.to, 'cm-quote');
            return;
          }
          case 'QuoteMark': {
            if (!lineActive(node.from)) {
              const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
              decos.push(hide.range(node.from, end));
            }
            return;
          }
          case 'FencedCode': {
            eachLine(node.from, node.to, 'cm-codeblock');
            return false;
          }
          case 'Table': {
            eachLine(node.from, node.to, 'cm-table');
            return false;
          }
          case 'HorizontalRule': {
            if (!lineActive(node.from)) decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
            return;
          }
          case 'ListMark': {
            const text = state.sliceDoc(node.from, node.to);
            if (lineActive(node.from) || !/^[-*+]$/.test(text)) {
              decos.push(markCls('cm-listmark').range(node.from, node.to));
              return;
            }
            // Task items show only their checkbox; plain items get a bullet.
            const isTask = /^\s?\[[ xX]\]/.test(state.sliceDoc(node.to, node.to + 5));
            const end = isTask && state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            decos.push((isTask ? hide : Decoration.replace({ widget: new BulletWidget() })).range(node.from, end));
            return;
          }
          case 'TaskMarker': {
            if (!editing(node.from - 1, node.to + 1)) {
              const done = /x/i.test(state.sliceDoc(node.from, node.to));
              decos.push(Decoration.replace({ widget: new TaskWidget(done, node.from) }).range(node.from, node.to));
            }
            return;
          }
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

function livePreview(opts: NoteEditorOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect) || e.is(startRename) || e.is(endRename) || e.is(setActiveEffect)))
        ) {
          this.decorations = buildDecorations(u.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------- Formatting commands ----------

export function toggleWrap(view: EditorView, mark: string) {
  view.dispatch(
    view.state.changeByRange((r) => {
      const before = view.state.sliceDoc(r.from - mark.length, r.from);
      const after = view.state.sliceDoc(r.to, r.to + mark.length);
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: r.from - mark.length, to: r.from },
            { from: r.to, to: r.to + mark.length },
          ],
          range: EditorSelection.range(r.from - mark.length, r.to - mark.length),
        };
      }
      return {
        changes: [
          { from: r.from, insert: mark },
          { from: r.to, insert: mark },
        ],
        range: EditorSelection.range(r.from + mark.length, r.to + mark.length),
      };
    }),
  );
  view.focus();
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

export function setHeading(view: EditorView, level: number) {
  const changes = selectedLines(view).map(({ from, text }) => {
    const m = text.match(/^#{1,6}\s+/);
    const insert = level > 0 ? '#'.repeat(level) + ' ' : '';
    return { from, to: from + (m ? m[0].length : 0), insert };
  });
  view.dispatch({ changes });
  view.focus();
}

const LINE_PREFIXES = [/^\s*- \[[ xX]\]\s/, /^\s*[-*+]\s/, /^\s*\d+[.)]\s/, /^\s*>\s?/];

export function toggleLinePrefix(view: EditorView, prefix: '- ' | '1. ' | '- [ ] ' | '> ') {
  const lines = selectedLines(view);
  const has = (text: string) =>
    prefix === '- [ ] '
      ? LINE_PREFIXES[0].test(text)
      : prefix === '- '
        ? LINE_PREFIXES[1].test(text) && !LINE_PREFIXES[0].test(text)
        : prefix === '1. '
          ? LINE_PREFIXES[2].test(text)
          : LINE_PREFIXES[3].test(text);
  const remove = lines.every((l) => has(l.text));
  const changes = lines.map(({ from, text }, i) => {
    const existing = LINE_PREFIXES.map((re) => text.match(re)).find(Boolean);
    const len = existing ? existing[0].length : 0;
    const insert = remove ? '' : prefix === '1. ' ? `${i + 1}. ` : prefix;
    return { from, to: from + len, insert };
  });
  view.dispatch({ changes });
  view.focus();
}

export function insertBlock(view: EditorView, text: string, cursorOffset?: number) {
  const r = view.state.selection.main;
  const line = view.state.doc.lineAt(r.from);
  const atLineStart = r.from === line.from;
  const prefix = atLineStart ? '' : '\n';
  const insert = prefix + text + '\n';
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: r.from + prefix.length + (cursorOffset ?? text.length) },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertLink(view: EditorView) {
  const r = view.state.selection.main;
  const text = view.state.sliceDoc(r.from, r.to) || 'link';
  const insert = `[${text}](https://)`;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: r.from + text.length + 3, head: r.from + insert.length - 1 },
  });
  view.focus();
}

export const editorUndo = (view: EditorView) => undo(view);
export const editorRedo = (view: EditorView) => redo(view);

// ---------- Setup ----------

const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#7c3aed' },
  { tag: [tags.string, tags.special(tags.string)], color: '#0f7b45' },
  { tag: tags.comment, color: '#8a918c', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b45309' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#1d4f91' },
  { tag: [tags.typeName, tags.className], color: '#9c4221' },
  { tag: tags.monospace, fontFamily: "'Cascadia Code', Consolas, monospace" },
]);

export function createNoteEditor(parent: HTMLElement, opts: NoteEditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      EditorState.lineSeparator.of(opts.eol),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(codeHighlight),
      highlightSelectionMatches(),
      renameField,
      renameFilter,
      renameKeymap,
      flashField,
      activeLinkField,
      livePreview(opts),
      hoverTooltip(
        (view, pos) => {
          const info = linkAt(view.state, pos);
          if (!info || info.ref.pathKind === 'web' || info.image) return null;
          if (view.state.field(renameField, false)) return null;
          return { pos: info.from, end: info.to, above: false, create: () => ({ dom: opts.renderHoverCard(info, view) }) };
        },
        { hoverTime: 400 },
      ),
      keymap.of([
        { key: 'Mod-s', run: () => (opts.onSave(), true) },
        { key: 'Mod-b', run: (v) => (toggleWrap(v, '**'), true) },
        { key: 'Mod-i', run: (v) => (toggleWrap(v, '*'), true) },
        { key: 'Mod-e', run: (v) => (toggleWrap(v, '`'), true) },
        { key: 'Mod-k', run: (v) => (insertLink(v), true) },
        ...[0, 1, 2, 3, 4, 5, 6].map((l) => ({ key: `Mod-${l}`, run: (v: EditorView) => (setHeading(v, l), true) })),
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange();
      }),
    ],
  });
  return new EditorView({ state, parent });
}

/** Text of the document using its original line endings. */
export function docText(view: EditorView): string {
  return view.state.sliceDoc();
}
