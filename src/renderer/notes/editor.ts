// Markdown note editor: CodeMirror 6 with Obsidian-style live preview, reference widgets,
// the inline rename box used when citing, and hover cards (UI spec §4).
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  Transaction,
  findClusterBreak,
  type ChangeSpec,
  type Extension,
  type Range,
} from '@codemirror/state';
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
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent, isolateHistory, redo, undo } from '@codemirror/commands';
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { SyntaxNode } from '@lezer/common';
import { basename, embedKind, escapeLabel, fileKind, isEmbed, parseDestination, splitLinkTarget, type Reference } from '../../core/link';
import { iconSvg, kindIcon } from '../icons';
import { tableElement, type EmbedContent } from './embeds';
import { renderedTables } from './tables';
import { editorZoom } from '../zoom';
import { nestList, setHeading, toggleLinePrefix, toggleWrap } from './format';

export { formatState, setHeading, toggleLinePrefix, toggleWrap, NO_FORMAT, type FormatState } from './format';

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

/**
 * A link's state; `changed` marks a live link whose cited content changed since (reason says how).
 * `gone` is a file that has left the workspace but whose cited version can still be shown, so the
 * link still works and is not drawn as broken.
 */
export type RefStatus = { state: 'ok' | 'broken' | 'gone' | 'unknown'; reason?: string; badge?: string; changed?: boolean };

export interface NoteEditorOptions {
  doc: string;
  onChange(): void;
  onSave(): void;
  onFollow(info: LinkInfo): void;
  refStatus(info: LinkInfo): RefStatus;
  imageUrl(info: LinkInfo): string | null;
  renderHoverCard(info: LinkInfo, view: EditorView): HTMLElement;
  /** Notes zoom (1 = 100%). */
  zoom?: number;
  /** Viewing a note on the right: formatted and clickable, but nothing can change it. */
  readOnly?: boolean;
  /** The cursor moved or the text changed: what applies at the cursor may be different now. */
  onCursor?(): void;
  /** Saves a pasted or dropped picture into the workspace and returns its path. */
  saveImage?(file: File): Promise<string | null>;
  /**
   * What an embedded view (a "!" link to a PDF, Word document, slide deck or workbook) shows now. `redraw` is
   * called when that changes (the drawing landed, or the file changed), to show it.
   */
  embedContent?(info: LinkInfo, redraw: () => void): EmbedContent;
  /** An embedded view's own buttons: pick the area or cells again, or show it as a plain link. */
  onEmbed?(info: LinkInfo, action: 'reselect' | 'link', view: EditorView): void;
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

/** Link details for a reference found in markdown text outside an editor (flowchart boxes). */
export function linkInfoFromMd(link: { from: number; to: number; label: string; dest: string; title?: string; image: boolean }): LinkInfo | null {
  const ref = parseDestination(link.dest);
  if (!ref) return null;
  return { from: link.from, to: link.to, labelFrom: link.from + 1, labelTo: link.from + 1 + link.label.length, label: link.label, dest: link.dest, title: link.title, ref, image: link.image };
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

/**
 * Inserts an embedded view ("![label](…)") on a line of its own, after the line the cursor is on
 * (or on it, when it is empty), and opens the rename box over its caption.
 */
export function insertEmbed(view: EditorView, build: (label: string) => string, defaultLabel: string) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const filled = (n: number) => n >= 1 && n <= state.doc.lines && !!state.doc.line(n).text.trim();
  const blank = !line.text.trim();
  const at = blank ? line.from : line.to;
  // A paragraph of its own: a blank line between it and any text above or below.
  const before = blank ? (filled(line.number - 1) ? '\n' : '') : '\n\n';
  const text = build(defaultLabel);
  const after = filled(line.number + 1) ? '\n' : '';
  const start = at + before.length;
  const labelFrom = start + 2;
  const labelTo = labelFrom + escapeLabel(defaultLabel).length;
  view.dispatch({
    changes: { from: at, to: blank ? line.to : at, insert: before + text + after },
    selection: EditorSelection.range(labelFrom, labelTo),
    effects: startRename.of({ labelFrom, labelTo, linkTo: start + text.length, defaultLabel }),
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

/** The one link shown as raw markdown ("Edit target"), until the cursor leaves it. */
const revealEffect = StateEffect.define<{ from: number; to: number } | null>();
const revealField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(revealEffect)) return e.value;
    if (!value) return value;
    if (tr.docChanged) value = { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    const head = tr.state.selection.main.head;
    return tr.selection && (head < value.from || head > value.to) ? null : value;
  },
});

/** Shows the raw markdown of a link so its target can be edited by hand. */
export function revealLink(view: EditorView, info: LinkInfo) {
  view.dispatch({
    selection: { anchor: info.labelTo + 2 },
    effects: revealEffect.of({ from: info.from, to: info.to }),
    scrollIntoView: true,
  });
  view.focus();
}

export function replaceLink(view: EditorView, info: LinkInfo, text: string) {
  view.dispatch({ changes: { from: info.from, to: info.to, insert: text } });
}

/** Briefly highlights a link (tour mode / "flash"). */
export function flashRange(view: EditorView, from: number, to: number) {
  flashRanges(view, [{ from, to }]);
}

/** Flashes several places at once and scrolls to the first ("Show me" on a banner). */
export function flashRanges(view: EditorView, ranges: { from: number; to: number }[]) {
  if (!ranges.length) return;
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  centreOn(view, sorted[0].from, undefined, [flashEffect.of(sorted)]);
  setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1600);
}

/**
 * The links a notice is about, marked in the note for as long as the notice is up. The flash on
 * "Show me" fades in a second and a half; this does not, so the note itself says which links.
 */
const attentionEffect = StateEffect.define<string[] | null>();
const attentionField = StateField.define<Set<string> | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(attentionEffect)) return e.value && e.value.length ? new Set(e.value) : null;
    return value;
  },
});

/** Marks the links with these destinations (null clears the marks). */
export function setAttention(view: EditorView, dests: string[] | null) {
  view.dispatch({ effects: attentionEffect.of(dests) });
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
  view.dispatch({ effects: setActiveEffect.of(from) });
  if (from !== null) centreOn(view, from, () => view.state.field(activeLinkField, false) === from);
}

/**
 * Scrolls a place to the middle of the note and keeps it there while pictures near it finish
 * loading: a picture above it arrives with no height, then pushes everything below it down. It
 * stops following after a few seconds, when `still` says the place no longer matters, or as soon as
 * the reader scrolls or types.
 */
function centreOn(view: EditorView, pos: number, still: () => boolean = () => true, extra: StateEffect<unknown>[] = []) {
  view.dispatch({ effects: [...extra, EditorView.scrollIntoView(pos, { y: 'center' })] });
  const scroller = view.scrollDOM;
  const recentre = (e: Event) => {
    if (!(e.target as HTMLElement).classList?.contains('cm-image')) return;
    if (!still() || pos > view.state.doc.length) return stop();
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  };
  const stop = () => {
    clearTimeout(timer);
    clearTimeout(late);
    checks = 99;
    view.dom.removeEventListener('load', recentre, true);
    scroller.removeEventListener('wheel', stop);
    scroller.removeEventListener('mousedown', stop);
    view.dom.removeEventListener('keydown', stop);
  };
  // Scrolling goes by the heights the editor knows, and lines it has not drawn for a while (or a
  // picture it has not measured since it loaded) can be off. Look where the place really is once
  // drawn, and scroll again if it is not near the middle.
  let checks = 0;
  const check = () => {
    if (!still() || pos > view.state.doc.length || checks++ > 3) return;
    const at = view.coordsAtPos(pos);
    const box = scroller.getBoundingClientRect();
    const off = at ? (at.top + at.bottom) / 2 - (box.top + box.height / 2) : Infinity;
    if (Math.abs(off) > Math.max(24, box.height * 0.08)) {
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      requestAnimationFrame(() => requestAnimationFrame(check));
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(check));
  const late = setTimeout(check, 350);
  const timer = setTimeout(stop, 4000);
  view.dom.addEventListener('load', recentre, true);
  scroller.addEventListener('wheel', stop, { passive: true });
  scroller.addEventListener('mousedown', stop);
  view.dom.addEventListener('keydown', stop);
}

/** Scrolls to a line and flashes it ("Cited in" jumps). */
export function flashLine(view: EditorView, line: number) {
  const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
  flashRange(view, l.from, l.to);
}

const flashEffect = StateEffect.define<{ from: number; to: number }[] | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        value = e.value
          ? Decoration.set(e.value.map((r) => Decoration.mark({ class: 'cm-flash' }).range(r.from, r.to)))
          : Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- Changes Claude makes (UI spec §6.3) ----------

/**
 * A change Claude made in the editor: where its new text is now, that text, and the text it
 * replaced. The places are kept in step with everything typed since, so Undo in the chat takes
 * back just Claude's change even after the user has typed elsewhere (or undone and redone it).
 */
interface ClaudeChange {
  ranges: { from: number; to: number }[];
  texts: string[];
  olds: string[];
}
const claudeChangeEffect = StateEffect.define<{ id: string; change: ClaudeChange | null }>();
const claudeChangesField = StateField.define<Map<string, ClaudeChange>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    if (!tr.changes.empty && value.size) {
      next = new Map();
      for (const [id, c] of value)
        next.set(id, { ...c, ranges: c.ranges.map((r) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) })) });
    }
    for (const e of tr.effects) {
      if (!e.is(claudeChangeEffect)) continue;
      if (next === value) next = new Map(value);
      if (e.value.change) next.set(e.value.id, e.value.change);
      else next.delete(e.value.id);
    }
    return next;
  },
});

/**
 * Makes Claude's change in the editor as one undo step of its own (never merged with the user's
 * typing), leaves the user's cursor where it was, and highlights what changed.
 */
export function applyClaudeChange(view: EditorView, specs: ChangeSpec, id: string): { from: number; to: number }[] {
  const changes = view.state.changes(specs);
  if (changes.empty) return [];
  const after = changes.apply(view.state.doc);
  const ranges: { from: number; to: number }[] = [];
  const olds: string[] = [];
  changes.iterChanges((fromA, toA, fromB, toB) => {
    ranges.push({ from: fromB, to: toB });
    olds.push(view.state.sliceDoc(fromA, toA));
  });
  const change: ClaudeChange = { ranges, olds, texts: ranges.map((r) => after.sliceString(r.from, r.to)) };
  view.dispatch({ changes, annotations: isolateHistory.of('full'), effects: claudeChangeEffect.of({ id, change }) });
  showClaudeChange(view, id);
  return ranges;
}

/** Scrolls to a change Claude made and highlights it; false when it's no longer there. */
export function showClaudeChange(view: EditorView, id: string): boolean {
  const c = view.state.field(claudeChangesField, false)?.get(id);
  if (!c) return false;
  const doc = view.state.doc;
  // A deletion has no new text to light up: light up its line instead.
  const lit = c.ranges.map((r) => (r.to > r.from ? r : { from: doc.lineAt(r.from).from, to: doc.lineAt(r.from).to }));
  flashRanges(view, lit);
  return true;
}

/**
 * Takes back one change Claude made. "changed" when its text has since been edited or undone
 * (then Ctrl+Z is the way), "gone" when this editor doesn't know the change.
 */
export function undoClaudeChange(view: EditorView, id: string): 'ok' | 'changed' | 'gone' {
  const c = view.state.field(claudeChangesField, false)?.get(id);
  if (!c) return 'gone';
  if (c.ranges.some((r, i) => view.state.sliceDoc(r.from, r.to) !== c.texts[i])) return 'changed';
  view.dispatch({
    changes: c.ranges.map((r, i) => ({ from: r.from, to: r.to, insert: c.olds[i] })),
    annotations: isolateHistory.of('full'),
    effects: claudeChangeEffect.of({ id, change: null }),
  });
  return 'ok';
}

// ---------- Widgets ----------

/**
 * Badges after a reference. Nothing is written beside a link any more: whether it is pinned, and
 * what happened to what it cites, is in its hover card, and Save version asks about changes.
 */
export function refBadges(_status: RefStatus): HTMLElement[] {
  return [];
}

class RefWidget extends WidgetType {
  constructor(
    readonly info: LinkInfo,
    readonly status: RefStatus,
    readonly onFollow: (info: LinkInfo) => void,
    readonly active = false,
    readonly attention = false,
  ) {
    super();
  }
  eq(other: RefWidget) {
    return (
      other.info.label === this.info.label &&
      other.info.dest === this.info.dest &&
      other.status.state === this.status.state &&
      other.status.badge === this.status.badge &&
      other.status.changed === this.status.changed &&
      other.active === this.active &&
      other.attention === this.attention
    );
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    const state = this.status.state;
    span.className =
      'cm-ref' + (state === 'broken' ? ' broken' : state === 'gone' ? ' gone' : '') + (this.active ? ' active' : '') + (this.attention ? ' cm-attention' : '');
    if (state !== 'ok' && this.status.reason) span.title = this.status.reason;
    span.innerHTML = iconSvg(kindIcon(fileKind(this.info.ref.path)));
    span.append(this.info.label, ...refBadges(this.status));
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

/** The link whose label ends exactly at pos, when its target is hidden after it. */
function labelEndingAt(state: EditorState, pos: number): LinkInfo | null {
  const info = linkAt(state, pos);
  if (!info || info.image || info.labelTo !== pos || info.labelTo === info.labelFrom) return null;
  if (state.field(renameField, false) || state.field(revealField, false)?.from === info.from) return null;
  return info;
}

/** Follows the link at a position: web links open in the browser, references in the viewer. */
function followAt(view: EditorView, pos: number, onFollow: (info: LinkInfo) => void) {
  const info = linkAt(view.state, pos);
  if (!info) return;
  if (info.ref.pathKind === 'web') window.open(info.dest, '_blank');
  else onFollow(info);
}

/** Stands in for a reference's hidden "[": its file-type icon. */
class LinkIconWidget extends WidgetType {
  constructor(
    readonly icon: ReturnType<typeof kindIcon>,
    readonly cls: string,
    readonly onFollow: (info: LinkInfo) => void,
  ) {
    super();
  }
  eq(o: LinkIconWidget) {
    return o.icon === this.icon && o.cls === this.cls;
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = this.cls + ' cm-ref-icon';
    span.innerHTML = iconSvg(this.icon);
    span.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      followAt(view, view.posAtDOM(span) + 1, this.onFollow);
    });
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** Stands in for a reference's hidden "](target)": its version and "changed" badges. */
class LinkBadgeWidget extends WidgetType {
  constructor(readonly status: RefStatus) {
    super();
  }
  eq(o: LinkBadgeWidget) {
    return o.status.badge === this.status.badge && o.status.changed === this.status.changed && o.status.reason === this.status.reason;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-ref-badge';
    wrap.append(...refBadges(this.status));
    return wrap;
  }
}

/** Width chosen for a picture ("#w=320" on its address), in pixels at 100% zoom. */
export function imageWidth(dest: string): number | null {
  const m = dest.match(/[#&]w=(\d+)(?:&|$)/);
  return m ? +m[1] : null;
}

/** Records (or with null, forgets) the width of the picture drawn by `dom`. */
function setImageWidth(view: EditorView, dom: HTMLElement, width: number | null) {
  const pos = view.posAtDOM(dom);
  const info = allLinks(view.state).find((l) => l.image && l.from === pos);
  if (!info) return;
  const at = view.state.sliceDoc(info.from, info.to).lastIndexOf(info.dest);
  if (at < 0) return;
  let dest = info.dest.replace(/([#&])w=\d+(&|$)/, (_m, lead: string, tail: string) => (tail ? lead : ''));
  if (width) dest += `${dest.includes('#') ? '&' : '#'}w=${width}`;
  if (dest !== info.dest) view.dispatch({ changes: { from: info.from + at, to: info.from + at + info.dest.length, insert: dest } });
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: number | null) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.width === this.width;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-image-wrap';
    const img = document.createElement('img');
    img.className = 'cm-image';
    // Its height is known only once it loads: measure again so scrolling knows where things are.
    img.addEventListener('load', () => view.requestMeasure());
    img.src = this.src;
    img.alt = this.alt;
    img.draggable = false;
    const size = (w: number | null) => {
      img.classList.toggle('sized', w !== null);
      img.style.width = w === null ? '' : `calc(${w}px * var(--zoom, 1))`;
    };
    size(this.width);
    wrap.append(img);
    if (view.state.readOnly) return wrap;
    // A corner handle: drag for a width, double-click for the picture's own size.
    const handle = document.createElement('span');
    handle.className = 'cm-image-handle';
    handle.title = 'Drag to resize · double-click for full size';
    handle.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const zoom = parseFloat(getComputedStyle(wrap).getPropertyValue('--zoom')) || 1;
      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      let width = Math.round(startW / zoom);
      let moved = false;
      wrap.classList.add('resizing');
      const onMove = (ev: MouseEvent) => {
        moved = true;
        width = Math.max(40, Math.round((startW + ev.clientX - startX) / zoom));
        size(width);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        wrap.classList.remove('resizing');
        // The picture never draws wider than the note, so record what is actually shown.
        if (moved) setImageWidth(view, wrap, Math.round(img.getBoundingClientRect().width / zoom));
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    handle.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setImageWidth(view, wrap, null);
    };
    wrap.append(handle);
    return wrap;
  }
  ignoreEvent(e: Event) {
    return (e.target as HTMLElement).classList?.contains('cm-image-handle');
  }
}

/**
 * A corner handle that resizes `frame` by dragging (the width is written into the link as "w=")
 * and puts it back to its own size on a double-click.
 */
function resizeHandle(view: EditorView, wrap: HTMLElement, frame: HTMLElement, size: (w: number | null) => void): HTMLElement {
  const handle = document.createElement('span');
  handle.className = 'cm-image-handle';
  handle.title = 'Drag to resize · double-click for full size';
  handle.onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const zoom = parseFloat(getComputedStyle(wrap).getPropertyValue('--zoom')) || 1;
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    let moved = false;
    wrap.classList.add('resizing');
    const onMove = (ev: MouseEvent) => {
      moved = true;
      size(Math.max(40, Math.round((startW + ev.clientX - startX) / zoom)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      wrap.classList.remove('resizing');
      // Never drawn wider than the note, so record what is actually shown.
      if (moved) setImageWidth(view, wrap, Math.round(frame.getBoundingClientRect().width / zoom));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  handle.ondblclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setImageWidth(view, wrap, null);
  };
  handle.onclick = (e) => e.stopPropagation();
  return handle;
}

/** The details card of an embedded view, opened from its "…" button, until a click elsewhere. */
function showEmbedCard(view: EditorView, anchor: HTMLElement, info: LinkInfo, opts: NoteEditorOptions) {
  document.querySelector('.cm-embed-popover')?.remove();
  const pop = document.createElement('div');
  pop.className = 'cm-embed-popover';
  pop.append(opts.renderHoverCard(info, view));
  document.body.append(pop);
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8))}px`;
  pop.style.top = `${a.bottom + h + 8 > window.innerHeight ? Math.max(8, a.top - h - 4) : a.bottom + 4}px`;
  const close = () => {
    pop.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', key, true);
    view.scrollDOM.removeEventListener('scroll', close);
  };
  const outside = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  // A button in the card does its work and the card goes.
  pop.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) setTimeout(close, 0);
  });
  setTimeout(() => {
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', key, true);
    view.scrollDOM.addEventListener('scroll', close, { passive: true });
  }, 0);
}

/**
 * An embedded view: the picture of a box on a PDF page or slide, or the cells of a range, drawn
 * from the file (UI spec §4.9). It shows the source and whether it is live or pinned under it;
 * clicking it opens the file at that place, and its tools appear while the pointer is over it.
 * Nothing in it can be edited: the cells are the workbook's, shown as they are.
 */
class EmbedWidget extends WidgetType {
  constructor(
    readonly info: LinkInfo,
    readonly content: EmbedContent,
    readonly width: number | null,
    readonly status: RefStatus,
    readonly opts: NoteEditorOptions,
  ) {
    super();
  }
  eq(o: EmbedWidget) {
    const sameContent = o.content === this.content || (o.content.kind === 'loading' && this.content.kind === 'loading');
    return (
      sameContent &&
      o.info.dest === this.info.dest &&
      o.info.label === this.info.label &&
      o.info.title === this.info.title &&
      o.width === this.width &&
      o.status.state === this.status.state &&
      o.status.changed === this.status.changed &&
      o.status.reason === this.status.reason
    );
  }
  toDOM(view: EditorView) {
    const { info, content, status, opts } = this;
    const el = (tag: string, cls: string, text?: string) => {
      const e = document.createElement(tag);
      e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const zoomed = (px: number) => `calc(${Math.round(px)}px * var(--zoom, 1))`;
    const isTable = embedKind(info.ref.path) === 'table';
    const wrap = el('span', `cm-embed ${content.kind}${isTable ? ' is-table' : ''}`);
    const frame = el('span', 'cm-embed-frame');
    const fresh = () => linkAt(view.state, view.posAtDOM(wrap)) ?? info;
    let note: string | undefined;
    let resizable = false;
    if (content.kind === 'picture') {
      const img = document.createElement('img');
      img.className = 'cm-embed-picture';
      img.alt = info.label;
      img.draggable = false;
      img.addEventListener('load', () => view.requestMeasure());
      img.src = content.url;
      frame.style.width = zoomed(this.width ?? content.width);
      frame.append(img);
      note = content.note;
      resizable = true;
    } else if (content.kind === 'table') {
      const scroller = el('span', 'cm-embed-table-scroll');
      scroller.append(tableElement(content.table, this.width !== null));
      if (this.width) frame.style.width = zoomed(this.width);
      frame.append(scroller);
      const cut = content.table.cut;
      if (cut) {
        const parts = [];
        if (cut.rows > cut.shownRows) parts.push(`the first ${cut.shownRows} of ${cut.rows} rows`);
        if (cut.cols > cut.shownCols) parts.push(`the first ${cut.shownCols} of ${cut.cols} columns`);
        frame.append(el('span', 'cm-embed-cut', `Showing ${parts.join(' and ')}. Open the workbook to see them all.`));
      }
      note = content.note;
      resizable = true;
    } else if (content.kind === 'loading') {
      if (content.width) frame.style.width = zoomed(this.width ?? content.width);
      if (content.ratio) frame.style.aspectRatio = String(1 / content.ratio);
      frame.append(el('span', 'cm-embed-wait', isTable ? 'Reading the cells…' : 'Drawing…'));
    } else {
      const head = el('span', 'cm-embed-msg', content.message);
      frame.append(head, el('span', 'cm-embed-help', content.help));
    }
    // Clicking what it shows opens the file there (a drag to select a value doesn't).
    let down: { x: number; y: number } | null = null;
    frame.addEventListener('mousedown', (e) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    });
    frame.addEventListener('click', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && frame.contains(sel.anchorNode)) return;
      e.preventDefault();
      opts.onFollow(fresh());
    });
    frame.title = content.kind === 'error' ? '' : 'Click to open the file at this place';

    const caption = el('span', 'cm-embed-caption');
    const icon = el('span', 'cm-embed-icon');
    icon.innerHTML = iconSvg(kindIcon(fileKind(info.ref.path)));
    const label = el('span', 'cm-embed-label', info.label || basename(info.ref.path));
    label.title = 'Click to open the file at this place';
    label.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      opts.onFollow(fresh());
    });
    caption.append(icon, label);
    const external = info.ref.pathKind === 'external';
    const mode = el('span', 'cm-embed-mode ' + (external ? 'outside' : info.ref.rev ? 'pinned' : 'live'), external ? 'Outside the workspace' : info.ref.rev ? 'Pinned' : 'Live');
    mode.title = external
      ? 'A file outside the workspace: shown as it is now, with no versions.'
      : info.ref.rev
        ? 'Pinned: always shows the version it is pinned to, even after the file changes.'
        : 'Live: shows the file as it is now, and draws again when it changes.';
    caption.append(mode);
    if (status.changed) {
      const changed = el('span', 'cm-embed-changed', 'Changed');
      changed.title = `${status.reason ?? 'Changed since it was cited'}. The … menu can update the link or compare the versions.`;
      caption.append(changed);
    }

    const tools = el('span', 'cm-embed-tools');
    const tool = (text: string, title: string, run: (b: HTMLElement) => void) => {
      const b = el('button', 'cm-embed-tool', text);
      b.title = title;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        run(b);
      });
      tools.append(b);
    };
    tool('Open', 'Open the file at this place on the right', () => opts.onFollow(fresh()));
    if (!view.state.readOnly && opts.onEmbed) {
      tool(
        isTable ? 'Change cells' : 'Change area',
        isTable ? 'Open the workbook and pick the cells this table shows' : 'Open the file and draw the box this picture shows',
        () => opts.onEmbed!(fresh(), 'reselect', view),
      );
      tool('Show as link', 'Turn this view back into a plain link (the same reference, nothing lost)', () => opts.onEmbed!(fresh(), 'link', view));
    }
    tool('…', 'More: pin or make live, compare, rename, edit, remove', (b) => showEmbedCard(view, b, fresh(), opts));

    caption.append(tools);
    wrap.append(frame, caption);
    if (note) wrap.append(el('span', 'cm-embed-note', note));
    if (resizable && !view.state.readOnly) {
      frame.append(
        resizeHandle(view, wrap, frame, (w) => {
          frame.style.width = w === null ? '' : zoomed(w);
        }),
      );
    }
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** One redraw per editor, at most once a frame, however many embedded views land at once. */
const redrawers = new WeakMap<EditorView, () => void>();
function redrawer(view: EditorView): () => void {
  let fn = redrawers.get(view);
  if (!fn) {
    let queued = false;
    fn = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (view.dom.isConnected) view.dispatch({ effects: refreshEffect.of(null) });
      });
    };
    redrawers.set(view, fn);
  }
  return fn;
}

/** A picture on the clipboard or in a drop, if there is one. */
function imageFiles(data: DataTransfer | null): File[] {
  return data ? [...data.files].filter((f) => f.type.startsWith('image/')) : [];
}

async function insertImages(view: EditorView, files: File[], pos: { from: number; to: number }, save: (file: File) => Promise<string | null>) {
  const links: string[] = [];
  for (const file of files) {
    const path = await save(file);
    if (path) links.push(`![](${/[\s()<>]/.test(path) ? `<${path}>` : path})`);
  }
  if (!links.length) return;
  const insert = links.join('\n\n');
  const from = Math.min(pos.from, view.state.doc.length);
  const to = Math.min(pos.to, view.state.doc.length);
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true });
  view.focus();
}

/** Paste or drop a picture into the note: it is saved as a file and shown where the cursor is. */
function imagePasting(opts: NoteEditorOptions): Extension {
  const save = opts.saveImage;
  if (!save || opts.readOnly) return [];
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = imageFiles(e.clipboardData);
      // Cells copied from a spreadsheet come with a picture of them too: the text wins.
      if (!files.length || e.clipboardData?.getData('text/plain')) return false;
      e.preventDefault();
      const sel = view.state.selection.main;
      void insertImages(view, files, { from: sel.from, to: sel.to }, save);
      return true;
    },
    drop(e, view) {
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return false;
      e.preventDefault();
      const at = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      void insertImages(view, files, { from: at, to: at }, save);
      return true;
    },
  });
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
      if (view.state.readOnly) return;
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

interface Preview {
  decorations: DecorationSet;
  /** Hidden markup: the cursor steps over it and deleting skips past it. */
  hidden: RangeSet<Decoration>;
  /** Widgets standing for content (images, rules): deleted as one piece. */
  objects: RangeSet<Decoration>;
}

// Markup stays hidden while editing, so the note always looks formatted (no raw markdown).
function buildDecorations(view: EditorView, opts: NoteEditorOptions): Preview {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const objects: Range<Decoration>[] = [];
  const rename = state.field(renameField, false);
  const revealed = state.field(revealField, false);
  const conceal = (deco: Decoration, from: number, to: number) => {
    if (to <= from) return;
    decos.push(deco.range(from, to));
    hidden.push(hide.range(from, to));
  };
  const object = (deco: Decoration, from: number, to: number) => {
    decos.push(deco.range(from, to));
    objects.push(hide.range(from, to));
  };
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
  const hideMarks = (node: SyntaxNode, markName: string) => {
    for (const m of node.getChildren(markName)) conceal(hide, m.from, m.to);
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
          if (mark) conceal(hide, mark.from, state.sliceDoc(mark.to, mark.to + 1) === ' ' ? mark.to + 1 : mark.to);
          return;
        }
        switch (name) {
          case 'StrongEmphasis':
          case 'Emphasis':
          case 'Strikethrough': {
            const cls = name === 'StrongEmphasis' ? 'cm-strong' : name === 'Emphasis' ? 'cm-em' : 'cm-strike';
            decos.push(markCls(cls).range(node.from, node.to));
            hideMarks(node, name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark');
            return;
          }
          case 'InlineCode': {
            decos.push(markCls('cm-inline-code').range(node.from, node.to));
            hideMarks(node, 'CodeMark');
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
            if (revealed && revealed.from === info.from) {
              const paren = state.sliceDoc(info.labelTo, info.labelTo + 2) === '](' ? info.labelTo : -1;
              if (paren >= 0) decos.push(markCls('cm-mdmark').range(paren, info.to));
              return false;
            }
            if (info.image && opts.embedContent && isEmbed(info.ref, true)) {
              const widget = new EmbedWidget(info, opts.embedContent(info, redrawer(view)), imageWidth(info.dest), opts.refStatus(info), opts);
              object(Decoration.replace({ widget }), info.from, info.to);
              return false;
            }
            if (info.image) {
              const src = opts.imageUrl(info);
              if (src) object(Decoration.replace({ widget: new ImageWidget(src, info.label, imageWidth(info.dest)) }), info.from, info.to);
              return false;
            }
            const web = info.ref.pathKind === 'web';
            const status = web ? null : opts.refStatus(info);
            const active = state.field(activeLinkField, false) === info.from;
            const attention = !web && !!state.field(attentionField, false)?.has(info.dest);
            if (info.labelTo === info.labelFrom) {
              // No label to edit as text: show the whole link as one piece.
              const widget = web ? new WebLinkWidget(info.dest, info.dest) : new RefWidget(info, status!, opts.onFollow, active, attention);
              object(Decoration.replace({ widget }), info.from, info.to);
              return false;
            }
            // The label is ordinary text; only "[" and "](target)" are hidden.
            // A web link has no status to read: only workspace links can be broken or gone.
            const mark = web ? '' : status!.state === 'broken' ? ' broken' : status!.state === 'gone' ? ' gone' : '';
            const cls = web ? 'cm-weblink' : 'cm-ref' + mark + (active ? ' active' : '') + (attention ? ' cm-attention' : '');
            conceal(
              web ? hide : Decoration.replace({ widget: new LinkIconWidget(kindIcon(fileKind(info.ref.path)), cls, opts.onFollow) }),
              info.from,
              info.labelFrom,
            );
            const title = web ? info.dest : mark ? status!.reason : undefined;
            decos.push(Decoration.mark({ class: cls + ' cm-link-label', attributes: title ? { title } : undefined }).range(info.labelFrom, info.labelTo));
            conceal(status?.badge || status?.changed ? Decoration.replace({ widget: new LinkBadgeWidget(status) }) : hide, info.labelTo, info.to);
            // Bold, italic and code in the label are drawn too.
            return;
          }
          case 'Blockquote': {
            eachLine(node.from, node.to, 'cm-quote');
            return;
          }
          case 'QuoteMark': {
            conceal(hide, node.from, state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to);
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
            // "****" is what Bold leaves on an empty line, about to be typed into: not a rule.
            if (state.sliceDoc(node.from, node.to) === '****') return;
            object(Decoration.replace({ widget: new HrWidget() }), node.from, node.to);
            return;
          }
          case 'ListMark': {
            const text = state.sliceDoc(node.from, node.to);
            // The space after a list marker belongs to it: the text starts after it.
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            if (!/^[-*+]$/.test(text)) {
              decos.push(markCls('cm-listmark').range(node.from, end));
              return;
            }
            // Task items show only their checkbox; plain items get a bullet.
            const isTask = /^\s?\[[ xX]\]/.test(state.sliceDoc(node.to, node.to + 5));
            conceal(isTask ? hide : Decoration.replace({ widget: new BulletWidget() }), node.from, end);
            return;
          }
          case 'TaskMarker': {
            const done = /x/i.test(state.sliceDoc(node.from, node.to));
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            conceal(Decoration.replace({ widget: new TaskWidget(done, node.from) }), node.from, end);
            return;
          }
          case 'Escape': {
            // "\*" shows as "*": the backslash only keeps the character from being markup.
            conceal(hide, node.from, node.from + 1);
            return;
          }
        }
      },
    });
  }
  return { decorations: Decoration.set(decos, true), hidden: Decoration.set(hidden, true), objects: Decoration.set(objects, true) };
}

function livePreview(opts: NoteEditorOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      preview: Preview;
      constructor(view: EditorView) {
        this.preview = buildDecorations(view, opts);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((t) =>
            t.effects.some((e) => e.is(refreshEffect) || e.is(startRename) || e.is(endRename) || e.is(setActiveEffect) || e.is(attentionEffect)),
          )
        ) {
          this.preview = buildDecorations(u.view, opts);
        }
      }
    },
    { decorations: (v) => v.preview.decorations },
  );
  const preview = (view: EditorView) => view.plugin(plugin)?.preview;
  return [
    plugin,
    EditorView.atomicRanges.of((view) => preview(view)?.hidden ?? Decoration.none),
    EditorView.atomicRanges.of((view) => preview(view)?.objects ?? Decoration.none),
    // Clicking a link's label follows it.
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const label = (e.target as HTMLElement).closest?.('.cm-link-label');
        if (!label || e.button !== 0 || e.shiftKey) return false;
        e.preventDefault();
        followAt(view, view.posAtDOM(label), opts.onFollow);
        return true;
      },
    }),
    // Typing at the end of a link's label writes after the link, not into it.
    EditorView.inputHandler.of((view, from, to, text) => {
      if (view.state.readOnly) return false;
      const info = from === to ? labelEndingAt(view.state, from) : null;
      if (info) {
        view.dispatch({ changes: { from: info.to, insert: text }, selection: { anchor: info.to + text.length }, userEvent: 'input.type' });
        return true;
      }
      // A bracket typed into a link's label is a bracket, not the end of the link.
      if (/[[\]]/.test(text) && !view.state.field(renameField, false) && wrapsAround(view.state, from).some((w) => w.name === 'Link' && from >= w.textFrom && to <= w.textTo)) {
        const insert = escapeLabel(text);
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type' });
        return true;
      }
      return false;
    }),
    // Filters run last to first: the cursor is placed once the formatting is tidied.
    cursorAfterLineMarks,
    keepFormatting,
    // Ahead of the markdown keys, so Backspace at the start of a list item takes its bullet away
    // whole (rather than leaving its indent showing).
    Prec.highest(
      keymap.of([
        { key: 'Enter', run: enterSmart },
        { key: 'Backspace', run: (v) => deleteSmart(v, preview(v), -1) },
        { key: 'Delete', run: (v) => deleteSmart(v, preview(v), 1) },
      ]),
    ),
  ];
}

/** Extensions for a small editor of one table cell: the same formatted view, on one line. */
export function inlineEditorExtensions(opts: NoteEditorOptions): Extension {
  return [
    history(),
    drawSelection(),
    renameField,
    renameFilter,
    renameKeymap,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(codeHighlight),
    livePreview(opts),
    keymap.of([
      { key: 'Mod-b', run: (v) => (toggleWrap(v, '**'), true) },
      { key: 'Mod-i', run: (v) => (toggleWrap(v, '*'), true) },
      { key: 'Mod-e', run: (v) => (toggleWrap(v, '`'), true) },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
  ];
}

/** Whether the line holding pos is part of a markdown table (tables are edited cell by cell). */
function inTable(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (n.name === 'Table') return true;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (n.name === 'Table') return true;
  return false;
}

// ---------- Deleting in the formatted view ----------

const WRAPPED: Record<string, string> = {
  StrongEmphasis: 'EmphasisMark',
  Emphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  InlineCode: 'CodeMark',
};

/**
 * The changes that delete [from, to) without breaking the formatting around it: hidden markup of
 * links, bold, italic and code that is only partly selected is kept, and a construct whose text
 * would be emptied goes entirely (deleting a link's last letter deletes the link).
 */
function safeDeletion(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  // A line's marks (bullet, number, checkbox, heading, quote) go whole or not at all: part of
  // "1. " left behind would show as text, and joining a line keeps none of the next line's marks.
  const first = state.doc.lineAt(from);
  if (from > first.from && from < textStart(state, first)) from = first.from;
  const last = state.doc.lineAt(to);
  if (to < textStart(state, last) && (from < last.from || to > last.from)) to = textStart(state, last);
  let ranges = [{ from, to }];
  const cut = (a: number, b: number) => {
    ranges = ranges.flatMap((r) =>
      b <= r.from || a >= r.to ? [r] : [...(r.from < a ? [{ from: r.from, to: a }] : []), ...(b < r.to ? [{ from: b, to: r.to }] : [])],
    );
  };
  const revealed = state.field(revealField, false);
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (n.from >= from && n.to <= to) return false;
      let markup: [number, number][];
      let text: [number, number];
      if (n.name === 'Link') {
        const info = linkFromNode(state, n.node);
        if (!info || revealed?.from === info.from) return false;
        markup = [
          [info.from, info.labelFrom],
          [info.labelTo, info.to],
        ];
        text = [info.labelFrom, info.labelTo];
      } else if (WRAPPED[n.name]) {
        const marks = n.node.getChildren(WRAPPED[n.name]);
        if (marks.length < 2) return;
        const [first, last] = [marks[0], marks[marks.length - 1]];
        markup = [
          [first.from, first.to],
          [last.from, last.to],
        ];
        text = [first.to, last.from];
      } else return;
      if (from <= text[0] && to >= text[1]) ranges.push({ from: n.from, to: n.to });
      else for (const [a, b] of markup) cut(a, b);
    },
  });
  ranges.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else if (r.to > r.from) merged.push({ ...r });
  }
  return merged;
}

// ---------- Keeping formatting whole while editing ----------

/** Marks a transaction already made safe here, so the filter leaves it as it is. */
const safeEdit = Annotation.define<boolean>();

interface Wrap {
  name: string;
  /** The whole construct, the text inside it, and its opening and closing markup. */
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
}

/** Bold, italic, strikethrough, code or a link label, as its markup and its text. */
function wrapOf(state: EditorState, node: SyntaxNode): Wrap | null {
  if (node.name === 'Link') {
    const info = linkFromNode(state, node);
    if (!info || state.field(revealField, false)?.from === info.from) return null;
    return { name: 'Link', from: info.from, to: info.to, textFrom: info.labelFrom, textTo: info.labelTo };
  }
  const markName = WRAPPED[node.name];
  if (!markName) return null;
  const marks = node.getChildren(markName);
  if (marks.length < 2) return null;
  return { name: node.name, from: node.from, to: node.to, textFrom: marks[0].to, textTo: marks[marks.length - 1].from };
}

/** The constructs whose markup lies around pos, innermost first. */
function wrapsAround(state: EditorState, pos: number): Wrap[] {
  const out: Wrap[] = [];
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (n) => {
      if (n.from >= pos || n.to <= pos) return;
      const w = wrapOf(state, n.node);
      if (w) out.push(w);
    },
  });
  return out.sort((a, b) => a.to - a.from - (b.to - b.from));
}

/** Where the cursor can go at the start of a line: after its hidden quote, bullet, checkbox or heading marks. */
function textStart(state: EditorState, line: { from: number; to: number }): number {
  const marks = new Map<number, number>();
  syntaxTree(state).iterate({
    from: line.from,
    to: Math.min(line.to, line.from + 40),
    enter: (n) => {
      if (n.name === 'QuoteMark' || n.name === 'HeaderMark' || n.name === 'ListMark' || n.name === 'TaskMarker') marks.set(n.from, n.to);
    },
  });
  let pos = line.from;
  for (let end = marks.get(pos); end !== undefined; end = marks.get(pos)) {
    // A heading mark with nothing after it ("#") is not a heading yet.
    if (state.sliceDoc(end, end + 1) === ' ') end++;
    else if (end === line.to) break;
    pos = end;
  }
  return pos;
}

const EDGE_SPACE = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough']);

/** A cursor at `at` (before tidying) goes to `to`, on this side of anything inserted there. */
type Move = [at: number, to: number, assoc: 1 | -1];

/** Where a cursor goes when the tidy changes are made. */
function moveCursor(pos: number, moves: Move[], set: ChangeSet): number {
  const m = moves.find(([at]) => at === pos);
  return m ? set.mapPos(m[1], m[2]) : set.mapPos(pos, -1);
}

/**
 * Tidies the formatting an edit touched, so it stays formatting (changes against the new text):
 * bold or italic made with "_" becomes "*" (which also works inside a word), spaces at the inside
 * edge of bold, italic or strikethrough move outside it (where they don't undo it), formatting
 * left with no text goes, and two pieces of the same formatting that now touch become one.
 */
function tidyAfter(start: EditorState, changes: ChangeSet, doc: EditorState['doc']): { specs: ChangeSpec[]; moves: Move[] } {
  const touched: { from: number; to: number }[] = [];
  changes.iterChangedRanges((a, b) => touched.push({ from: a, to: b }));
  const moves: Move[] = [];
  if (!touched.length) return { specs: [], moves };
  // Formatting just inside other formatting ("**" in "***") counts as touched too.
  const near = (w: Wrap) => touched.some((t) => t.from <= w.to + 3 && t.to >= w.from - 3);
  const wraps: Wrap[] = [];
  const lo = Math.max(0, Math.min(...touched.map((t) => t.from)) - 4);
  const hi = Math.min(start.doc.length, Math.max(...touched.map((t) => t.to)) + 4);
  syntaxTree(start).iterate({
    from: lo,
    to: hi,
    enter: (n) => {
      if (n.name === 'Link' || !WRAPPED[n.name]) return;
      const w = wrapOf(start, n.node);
      if (w && near(w)) wraps.push(w);
    },
  });
  interface Piece {
    w: Wrap;
    open: [number, number];
    close: [number, number];
    mark: string;
    gone: boolean;
  }
  const pieces: Piece[] = [];
  for (const w of wraps) {
    const open: [number, number] = [changes.mapPos(w.from, 1), changes.mapPos(w.textFrom, -1)];
    const close: [number, number] = [changes.mapPos(w.textTo, 1), changes.mapPos(w.to, -1)];
    const mark = start.sliceDoc(w.from, w.textFrom);
    // Markup the edit took away or changed is left alone.
    if (doc.sliceString(open[0], open[1]) !== mark || doc.sliceString(close[0], close[1]) !== start.sliceDoc(w.textTo, w.to)) continue;
    if (close[0] < open[1]) continue;
    pieces.push({ w, open, close, mark, gone: false });
  }
  const out: ChangeSpec[] = [];
  const star = (m: string) => m.replace(/_/g, '*');
  // Touching pieces of the same formatting join: "**a****b**" is "**ab**". Formatting inside
  // formatting joins once the outer markup between them has gone ("***a******b***").
  const joinedOpen = new Set<Piece>();
  const joinedClose = new Set<Piece>();
  const gaps: [number, number][] = [];
  for (let joined = true; joined; ) {
    joined = false;
    for (const a of pieces) {
      if (joinedClose.has(a)) continue;
      const b = pieces.find((p) => {
        if (p === a || joinedOpen.has(p) || p.w.name !== a.w.name || star(p.mark) !== star(a.mark)) return false;
        return p.open[0] === a.close[1] || gaps.some(([x, y]) => x === a.close[1] && y === p.open[0]);
      });
      if (!b) continue;
      joinedClose.add(a);
      joinedOpen.add(b);
      const inner = gaps.findIndex(([x, y]) => x === a.close[1] && y === b.open[0]);
      if (inner >= 0) gaps.splice(inner, 1);
      gaps.push([a.close[0], b.open[1]]);
      joined = true;
    }
  }
  for (const [from, to] of gaps) out.push({ from, to });
  // Spaces leaving bold that starts or ends together with italic leave both.
  const before = (pos: number): number => {
    const q = pieces.find((q) => q.open[1] === pos && q.open[0] < pos && !joinedOpen.has(q));
    return q ? before(q.open[0]) : pos;
  };
  const after = (pos: number): number => {
    const q = pieces.find((q) => q.close[0] === pos && q.close[1] > pos && !joinedClose.has(q));
    return q ? after(q.close[1]) : pos;
  };
  for (const p of pieces) {
    const text = doc.sliceString(p.open[1], p.close[0]);
    const code = p.w.name === 'InlineCode';
    if ((code ? !text : !text.trim()) && !joinedOpen.has(p) && !joinedClose.has(p)) {
      // Nothing left to format (or only spaces): the markup goes, the spaces stay.
      out.push({ from: p.open[0], to: p.open[1] }, { from: p.close[0], to: p.close[1] });
      continue;
    }
    const lead = EDGE_SPACE.has(p.w.name) && !joinedOpen.has(p) ? text.length - text.trimStart().length : 0;
    const trail = EDGE_SPACE.has(p.w.name) && !joinedClose.has(p) ? text.length - text.trimEnd().length : 0;
    const mark = p.mark.includes('_') ? star(p.mark) : null;
    if (!joinedOpen.has(p)) {
      if (lead) {
        const to = before(p.open[0]);
        out.push({ from: to, insert: text.slice(0, lead) }, { from: p.open[1], to: p.open[1] + lead });
        // A cursor after the spaces stays after them; one before them stays before them.
        moves.push([p.open[1] + lead, to, 1], [p.open[1], to, -1]);
      }
      if (mark) out.push({ from: p.open[0], to: p.open[1], insert: mark });
    }
    if (!joinedClose.has(p)) {
      if (trail) {
        const to = after(p.close[1]);
        out.push({ from: p.close[0] - trail, to: p.close[0] }, { from: to, insert: text.slice(text.length - trail) });
        moves.push([p.close[0], to, 1], [p.close[0] - trail, to, -1]);
      }
      if (mark) out.push({ from: p.close[0], to: p.close[1], insert: mark });
    }
  }
  return { specs: out, moves };
}

/**
 * A numbered list whose first item stopped being one (its number taken away, joined to the line
 * above) would turn the rest into plain text, since a list can only follow a paragraph when it
 * starts at 1: the items after it are numbered again from 1 (changes against the new text).
 */
function renumberAfter(start: EditorState, changes: ChangeSet, doc: EditorState['doc']): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  const seen = new Set<number>();
  changes.iterChangedRanges((_a, _b, _fromB, toB) => {
    const line = doc.lineAt(toB);
    if (line.number >= doc.lines || seen.has(line.number)) return;
    seen.add(line.number);
    if (!line.text.trim() || /^\s*([-*+]|\d+[.)])(\s|$)/.test(line.text) || /^\s/.test(line.text)) return;
    let n = 1;
    for (let l = line.number + 1; l <= doc.lines; l++) {
      const next = doc.line(l);
      const m = next.text.match(/^(\d+)([.)] )/);
      if (!m || (l === line.number + 1 && (m[1] === '1' || !wasNumbered(start, changes.invertedDesc.mapPos(next.from, 1))))) break;
      if (+m[1] !== n) out.push({ from: next.from, to: next.from + m[1].length, insert: String(n) });
      n++;
    }
  });
  return out;
}

/** Whether pos was in a numbered list before the edit (so "2." there was a list item, not text). */
function wasNumbered(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(Math.min(pos + 1, state.doc.length), -1); n; n = n.parent)
    if (n.name === 'OrderedList') return true;
  return false;
}

/** Edits made by hand that can take text away: typing or pasting over a selection, cutting, dragging. */
const HAND_EDIT = ['input.type', 'input.paste', 'input.drop', 'delete', 'move.drop'];

/**
 * Keeps formatting whole whatever the edit: text taken away by typing over a selection, pasting,
 * cutting or deleting a word goes the way Backspace takes it (markup only partly selected stays),
 * and then what the edit touched is tidied (see tidyAfter).
 */
const keepFormatting = EditorState.transactionFilter.of((tr) => {
  const start = tr.startState;
  if (!tr.docChanged || start.readOnly || start.field(renameField, false)) return tr;
  if (!HAND_EDIT.some((e) => tr.isUserEvent(e)) || tr.isUserEvent('input.type.compose')) return tr;
  let changes = tr.changes;
  let selection: EditorSelection | undefined = tr.selection;
  if (!tr.annotation(safeEdit)) {
    const specs: ChangeSpec[] = [];
    let deletes = false;
    let last = -1;
    let lastLength = 0;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (toA > fromA) deletes = true;
      const safe = toA > fromA ? safeDeletion(start, fromA, toA) : [];
      specs.push(...safe);
      // What is typed over a selection takes the formatting of the first character it replaces.
      const at = safe.length ? safe[0].from : fromA;
      if (inserted.length) specs.push({ from: at, insert: inserted });
      last = at;
      lastLength = inserted.length;
    });
    if (deletes) {
      changes = start.changes(specs);
      // The cursor goes after what was typed or pasted, where the selection started.
      const single = start.selection.ranges.length === 1 && (!selection || (selection.ranges.length === 1 && selection.main.empty));
      selection = single ? EditorSelection.single(changes.mapPos(last, -1) + lastLength) : start.selection.map(changes, 1);
    }
  }
  const doc = changes.apply(start.doc);
  const tidy = tidyAfter(start, changes, doc);
  tidy.specs.push(...renumberAfter(start, changes, doc));
  if (changes === tr.changes && !tidy.specs.length) return tr;
  const first = changes === tr.changes ? tr : {
    changes,
    selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: [Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!), safeEdit.of(true)],
  };
  if (!tidy.specs.length) return first;
  // A cursor beside spaces that moved out of the formatting moves with them.
  const set = ChangeSet.of(tidy.specs, doc.length);
  const base = selection ?? start.selection.map(changes);
  const moved = EditorSelection.create(
    base.ranges.map((r) => (r.empty ? EditorSelection.cursor(moveCursor(r.head, tidy.moves, set)) : r.map(set))),
    base.mainIndex,
  );
  return [first, { changes: set, selection: moved, sequential: true }];
});

/** The cursor never stands before a line's hidden marks, where typing would undo the heading or bullet. */
const cursorAfterLineMarks = EditorState.transactionFilter.of((tr) => {
  const sel = tr.selection;
  if (!sel || sel.ranges.length > 1 || !sel.main.empty) return tr;
  const state = tr.state;
  const line = state.doc.lineAt(sel.main.head);
  if (sel.main.head - line.from > 40) return tr;
  const at = textStart(state, line);
  return sel.main.head < at ? [tr, { selection: { anchor: at }, sequential: true }] : tr;
});

/**
 * Enter that keeps formatting: at the start of bold (or italic, code, a link) the line breaks before
 * it, at its end after it, and in the middle the formatting is closed on the first line and opened
 * again on the next, so both halves stay formatted (whatever kind of line it is). Lists and quotes
 * continue as usual.
 */
function enterSmart(view: EditorView): boolean {
  let state = view.state;
  if (state.readOnly || state.field(renameField, false) || state.selection.ranges.length > 1) return false;
  let changes = state.changes([]);
  const step = (spec: ChangeSpec[], anchor: number) => {
    const set = state.changes(spec);
    changes = changes.compose(set);
    state = state.update({ changes: set, selection: { anchor: set.mapPos(anchor, 1) } }).state;
  };
  const sel = state.selection.main;
  let pos = sel.head;
  if (!sel.empty) {
    // The selection goes as Backspace takes it, and the formatting either side is tidied.
    const start = state;
    step(safeDeletion(state, sel.from, sel.to), sel.from);
    let at = changes.mapPos(sel.from, -1);
    const tidy = tidyAfter(start, changes, state.doc);
    if (tidy.specs.length) {
      const set = ChangeSet.of(tidy.specs, state.doc.length);
      at = moveCursor(at, tidy.moves, set);
      step(tidy.specs, 0);
    }
    pos = at;
  }
  // Step out of formatting the cursor is at the edge of.
  for (let moved = true; moved; ) {
    moved = false;
    for (const w of wrapsAround(state, pos)) {
      if (pos <= w.textFrom && pos < w.textTo) pos = w.from;
      else if (pos >= w.textTo) pos = w.to;
      else continue;
      moved = true;
      break;
    }
  }
  const inside = wrapsAround(state, pos).filter((w) => pos > w.textFrom && pos < w.textTo);
  if (inside.length) {
    // Close inside the spaces at the break and open again after them.
    const before = state.sliceDoc(Math.max(...inside.map((w) => w.textFrom)), pos);
    const after = state.sliceDoc(pos, Math.min(...inside.map((w) => w.textTo)));
    const a = pos - (before.length - before.trimEnd().length);
    const b = pos + (after.length - after.trimStart().length);
    const close = inside.map((w) => state.sliceDoc(w.textTo, w.to)).join('');
    const open = [...inside].reverse().map((w) => state.sliceDoc(w.from, w.textFrom)).join('');
    step([{ from: a, insert: close }, { from: b, insert: open }], pos);
    // The cursor stays between the spaces, after what closes and before what opens.
    pos += close.length;
  }
  // The new line starts at its first word, not with the spaces that were after the cursor.
  const rest = state.sliceDoc(pos, state.doc.lineAt(pos).to);
  const spaces = rest.length - rest.trimStart().length;
  if (spaces && spaces < rest.length) step([{ from: pos, to: pos + spaces }], pos);
  // Enter on an empty checkbox item ends the list, as on an empty bullet.
  const line = state.doc.lineAt(pos);
  const emptyTask = line.text.match(/^(\s*(?:> ?)*[-*+] )\[[ xX]\] ?$/);
  if (emptyTask && pos === line.to) {
    step([{ from: line.from + emptyTask[1].length, to: line.to }], line.from);
    pos = state.doc.lineAt(changes.mapPos(line.from)).to;
  }
  state = state.update({ selection: { anchor: pos } }).state;
  let newline: Transaction | null = null;
  const capture = { state, dispatch: (t: Transaction) => (newline = t) };
  if (!insertNewlineContinueMarkup(capture)) insertNewlineAndIndent(capture);
  if (!newline) return false;
  const nl = newline as Transaction;
  // A checkbox left with nothing after it keeps the space that makes it a checkbox.
  const fix: ChangeSpec[] = [];
  const at = nl.newDoc.lineAt(nl.state.selection.main.head).number;
  for (let l = Math.max(1, at - 2); l <= at; l++) {
    const t = nl.newDoc.line(l);
    if (/^\s*(?:> ?)*[-*+] \[[ xX]\]$/.test(t.text)) fix.push({ from: t.to, insert: ' ' });
  }
  const fixSet = ChangeSet.of(fix, nl.newDoc.length);
  view.dispatch({
    changes: changes.compose(nl.changes).compose(fixSet),
    selection: nl.selection!.map(fixSet),
    scrollIntoView: true,
    userEvent: 'input',
    annotations: safeEdit.of(true),
  });
  return true;
}

/** Line formatting that Backspace at the start of the text removes (heading, bullet, task, quote). */
const LINE_FORMAT = /^\s*(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)$/;

/** Backspace (dir -1) and Delete (dir 1) that treat the formatted text as the text. */
function deleteSmart(view: EditorView, preview: Preview | undefined, dir: -1 | 1): boolean {
  const { state } = view;
  if (!preview || state.readOnly || state.field(renameField, false) || state.selection.ranges.length > 1) return false;
  const sel = state.selection.main;
  let changes: { from: number; to: number }[];
  if (!sel.empty) {
    changes = safeDeletion(state, sel.from, sel.to);
  } else {
    let pos = sel.head;
    const line = state.doc.lineAt(pos);
    if (dir < 0 && pos > line.from && LINE_FORMAT.test(state.sliceDoc(line.from, pos))) {
      changes = [{ from: line.from, to: pos }];
    } else {
      // Step over hidden markup; a widget standing for content is deleted whole.
      let object: { from: number; to: number } | null = null;
      for (let moved = true; moved && !object; ) {
        moved = false;
        preview.hidden.between(pos, pos, (a, b) => {
          if (dir < 0 ? b === pos && a < pos : a === pos && b > pos) {
            pos = dir < 0 ? a : b;
            moved = true;
            return false;
          }
        });
        preview.objects.between(pos, pos, (a, b) => {
          if (dir < 0 ? b === pos && a < pos : a === pos && b > pos) object = { from: a, to: b };
        });
      }
      if (object) changes = [object];
      else {
        if (dir < 0 ? pos === 0 : pos === state.doc.length) return true;
        const l = state.doc.lineAt(pos);
        if (dir < 0 ? pos === l.from && inTable(state, pos - 1) : pos === l.to && inTable(state, pos + 1)) return true;
        const other =
          dir < 0
            ? pos === l.from
              ? pos - 1
              : l.from + findClusterBreak(l.text, pos - l.from, false)
            : pos === l.to
              ? pos + 1
              : l.from + findClusterBreak(l.text, pos - l.from, true);
        changes = safeDeletion(state, Math.min(pos, other), Math.max(pos, other));
      }
    }
  }
  if (!changes.length) return true;
  const set = state.changes(changes as ChangeSpec[]);
  const anchor = set.mapPos(sel.empty ? Math.min(...changes.map((c) => c.from)) : sel.from, -1);
  view.dispatch({
    changes: set,
    selection: { anchor },
    scrollIntoView: true,
    userEvent: dir < 0 ? 'delete.backward' : 'delete.forward',
    annotations: safeEdit.of(true),
  });
  return true;
}

// ---------- Formatting commands ----------

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
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syn-type)' },
  { tag: tags.monospace, fontFamily: "'Cascadia Code', Consolas, monospace" },
]);

export function createNoteEditor(parent: HTMLElement, opts: NoteEditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      EditorState.readOnly.of(!!opts.readOnly),
      editorZoom(opts.zoom ?? 1),
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
      claudeChangesField,
      activeLinkField,
      attentionField,
      revealField,
      livePreview(opts),
      renderedTables(opts),
      imagePasting(opts),
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
        { key: 'Alt-Shift-5', run: (v) => (toggleWrap(v, '~~'), true) },
        { key: 'Mod-Shift-k', run: (v) => (insertBlock(v, '```\n\n```', 4), true) },
        { key: 'Mod-Shift-q', run: (v) => (toggleLinePrefix(v, '> '), true) },
        { key: 'Mod-Shift-]', run: (v) => (toggleLinePrefix(v, '- '), true) },
        { key: 'Mod-Shift-[', run: (v) => (toggleLinePrefix(v, '1. '), true) },
        { key: 'Mod-Shift-x', run: (v) => (toggleLinePrefix(v, '- [ ] '), true) },
        ...[0, 1, 2, 3, 4, 5, 6].map((l) => ({ key: `Mod-${l}`, run: (v: EditorView) => (setHeading(v, l), true) })),
        { key: 'Tab', run: (v) => nestList(v, 1) },
        { key: 'Shift-Tab', run: (v) => nestList(v, -1) },
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange();
        if (u.docChanged || u.selectionSet || u.focusChanged) opts.onCursor?.();
      }),
    ],
  });
  return new EditorView({ state, parent });
}

/** Text of the document using its original line endings. */
export function docText(view: EditorView): string {
  return view.state.sliceDoc();
}
