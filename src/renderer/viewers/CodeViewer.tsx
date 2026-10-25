import { useEffect, useRef, useState } from 'react';
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { LanguageDescription, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { defaultKeymap } from '@codemirror/commands';
import { tags } from '@lezer/highlight';
import { basename } from '../../core/link';
import { decodeText } from '../files';
import { Icon } from '../icons';
import { editorZoom, setEditorZoom } from '../zoom';
import { centred, glide, settled, showTravel } from './travel';
import { CiteButton } from './CiteButton';
import { iconSvg } from '../icons';
import type { CiteMark, ViewerProps } from './types';

const marksChanged = StateEffect.define<null>();

class CiteGutterMarker extends GutterMarker {
  constructor(readonly marks: CiteMark[]) {
    super();
  }
  eq(o: CiteGutterMarker) {
    return o.marks === this.marks;
  }
  toDOM() {
    const s = document.createElement('div');
    s.className = 'cm-cite-mark';
    s.innerHTML = iconSvg('bookmark');
    s.title = this.marks.map((m) => `Cited in ${m.note.slice(1)}: ${m.label}`).join('\n');
    return s;
  }
}

const setCited = StateEffect.define<{ start: number; end: number } | null>();

const citedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setCited)) continue;
      if (!e.value) return Decoration.none;
      const b = new RangeSetBuilder<Decoration>();
      const { start, end } = e.value;
      for (let l = start; l <= Math.min(end, tr.state.doc.lines); l++) {
        const cls = 'cm-cited-line' + (l === start ? ' first' : '') + (l === end ? ' last' : '');
        b.add(tr.state.doc.line(l).from, tr.state.doc.line(l).from, Decoration.line({ class: cls }));
      }
      return b.finish();
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const style = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syn-type)' },
  { tag: tags.definition(tags.variableName), color: 'var(--syn-name)' },
  { tag: tags.heading, fontWeight: 'bold' },
]);

export function CodeViewer({ data, path, reveal, onCite, handle, marks, onMark, onPlace, zoom = 1, children }: ViewerProps) {
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const marksRef = useRef<CiteMark[]>([]);
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;
  const marksAt = (lineNo: number) => marksRef.current.filter((m) => m.loc.lines?.start === lineNo);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [lang, setLang] = useState('Plain text');
  const [lines, setLines] = useState(0);
  const [lineInput, setLineInput] = useState('1');
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    if (viewRef.current) setEditorZoom(viewRef.current, zoom);
  }, [zoom]);

  useEffect(() => {
    const { text } = decodeText(data);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          editorZoom(zoomRef.current),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          syntaxHighlighting(style),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          citedField,
          gutter({
            class: 'cm-cite-gutter',
            lineMarker: (view, line) => {
              const here = marksAt(view.state.doc.lineAt(line.from).number);
              return here.length ? new CiteGutterMarker(here) : null;
            },
            lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(marksChanged))),
            domEventHandlers: {
              mousedown: (view, line) => {
                const here = marksAt(view.state.doc.lineAt(line.from).number);
                if (!here.length) return false;
                onMarkRef.current?.(here[0]);
                return true;
              },
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet) {
              const sel = u.state.selection.main;
              setHasSelection(!sel.empty);
              setLineInput(String(u.state.doc.lineAt(sel.head).number));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    readySince.current = 0;
    // Report the line at the top of the view as the reader scrolls.
    let placeTimer: number | undefined;
    view.scrollDOM.addEventListener('scroll', () => {
      clearTimeout(placeTimer);
      placeTimer = window.setTimeout(() => {
        const n = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
        onPlaceRef.current?.({ lines: { start: n, end: n } });
      }, 120);
    });
    requestAnimationFrame(() => {
      if (view.scrollDOM.clientHeight > 0) readySince.current = performance.now();
    });
    setLines(view.state.doc.lines);
    const desc = LanguageDescription.matchFilename(languages, basename(path));
    if (desc) {
      setLang(desc.name);
      desc.load().then((support) => view.dispatch({ effects: StateEffect.appendConfig.of(support) }));
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [data, path]);

  useEffect(() => {
    marksRef.current = marks ?? [];
    viewRef.current?.dispatch({ effects: marksChanged.of(null) });
  }, [marks, data]);

  /** When the code was first shown (0 until then): later jumps glide instead of snapping. */
  const readySince = useRef(0);
  const goToLine = (n: number, end = n) => {
    const view = viewRef.current;
    if (!view) return;
    const total = view.state.doc.lines;
    const start = Math.min(Math.max(1, n), total);
    const last = Math.min(Math.max(start, end), total);
    const line = view.state.doc.line(start);
    const cited = setCited.of(end !== n || reveal ? { start, end: last } : null);
    const el = view.scrollDOM;
    // The cited lines are centred in the view, the same way whether it glides there or jumps.
    const a = view.lineBlockAt(line.from);
    const b = view.lineBlockAt(view.state.doc.line(last).to);
    const top = centred(el.clientHeight, a.top + view.documentPadding.top, b.bottom + view.documentPadding.top);
    if (settled(el, readySince.current)) {
      // Glide there, and show where in the file that is.
      const from = view.state.doc.lineAt(view.lineBlockAtHeight(el.scrollTop + el.clientHeight / 2).from).number;
      view.dispatch({ selection: { anchor: line.from }, effects: [cited] });
      const mid = el.clientHeight / 2;
      const ms = glide(el, { top });
      showTravel(el.parentElement!.parentElement!, (el.scrollTop + mid) / el.scrollHeight, (top + mid) / el.scrollHeight, `L${from}`, `L${start}`, ms);
      return;
    }
    view.dispatch({ selection: { anchor: line.from }, effects: [cited, EditorView.scrollIntoView(EditorSelection.range(line.from, view.state.doc.line(last).to), { y: 'center' })] });
    if (!readySince.current && el.clientHeight > 0) readySince.current = performance.now();
  };

  useEffect(() => {
    if (reveal?.loc.lines && reveal.follow) {
      // Keeping the sides of a comparison together: the same top line, nothing marked.
      requestAnimationFrame(() => {
        const view = viewRef.current;
        if (!view) return;
        const doc = view.state.doc;
        const line = doc.line(Math.min(Math.max(1, reveal.loc.lines!.start), doc.lines));
        view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
      });
    } else if (reveal?.loc.lines) {
      // Wait a frame so a freshly created view has measured itself.
      requestAnimationFrame(() => goToLine(reveal.loc.lines!.start, reveal.loc.lines!.end));
    }
  }, [reveal, data]);

  useEffect(() => {
    handle({
      citeTarget: () => {
        const view = viewRef.current;
        if (!view) return null;
        const sel = view.state.selection.main;
        const doc = view.state.doc;
        const start = doc.lineAt(sel.from).number;
        let endPos = sel.to;
        if (!sel.empty && endPos > sel.from && doc.lineAt(endPos).from === endPos) endPos -= 1;
        const end = doc.lineAt(endPos).number;
        const quote = sel.empty ? doc.line(start).text.trim() : view.state.sliceDoc(sel.from, sel.to);
        return { loc: { lines: { start, end } }, quote: quote.slice(0, 200) };
      },
    });
    return () => handle(null);
  }, [data]);

  return (
    <>
      <div className="toolbar">
        {children}
        <span className="muted">Line</span>
        <input
          className="page-input"
          value={lineInput}
          onChange={(e) => setLineInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && goToLine(parseInt(lineInput, 10) || 1)}
          onFocus={(e) => e.target.select()}
        />
        <span className="muted">of {lines}</span>
        <div className="sep" />
        <span className="muted">{lang}</span>
        <div className="spacer" />
        <CiteButton icon="code" label={hasSelection ? 'Cite selection' : 'Cite line'} title="Insert a link to these lines into the note (Ctrl+Shift+L)" onCite={onCite} />
      </div>
      <div className="code-viewer" ref={host} />
    </>
  );
}
