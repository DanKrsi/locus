// Viewing a note or a flowchart on the right (UI spec §5.1): the same formatted view as editing on
// the left, read-only, with links that open what they cite. "Edit" opens it on the left.
import { useEffect, useRef } from 'react';
import type { EditorView } from '@codemirror/view';
import { slugify } from '../../core/link';
import { decodeText } from '../files';
import { FlowEditor } from '../flow/FlowEditor';
import { Icon } from '../icons';
import { createNoteEditor, flashLine, flashRange, type NoteEditorOptions } from '../notes/editor';
import { setEditorZoom } from '../zoom';
import { CiteButton } from './CiteButton';
import type { ViewerProps } from './types';

export type NoteCallbacks = Pick<NoteEditorOptions, 'onFollow' | 'refStatus' | 'imageUrl' | 'renderHoverCard'>;

interface Props extends ViewerProps {
  callbacks: NoteCallbacks;
  /** Opens this file for editing on the left (absent for past versions). */
  onEdit?(): void;
}

function EditButton({ onEdit }: { onEdit?(): void }) {
  return onEdit ? (
    <button className="outline" title="Open it on the left to change it" onClick={onEdit}>
      <Icon name="edit" /> Edit
    </button>
  ) : null;
}

export function NoteViewer({ data, reveal, onCite, handle, zoom = 1, callbacks, onEdit, children }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const { text, eol } = decodeText(data);
    const view = createNoteEditor(host.current!, {
      doc: text,
      eol,
      readOnly: true,
      zoom: zoomRef.current,
      ...callbacks,
      onChange: () => undefined,
      onSave: () => undefined,
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [data]);

  useEffect(() => {
    if (viewRef.current) setEditorZoom(viewRef.current, zoom);
  }, [zoom]);

  // Links into a note point at lines or at a heading.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    requestAnimationFrame(() => {
      const { loc } = reveal;
      if (loc.lines) return flashLine(view, loc.lines.start);
      if (!loc.heading) return;
      const doc = view.state.doc;
      for (let l = 1; l <= doc.lines; l++) {
        const line = doc.line(l);
        const m = line.text.match(/^#{1,6}\s+(.*)$/);
        if (m && slugify(m[1]) === loc.heading) return flashRange(view, line.from, line.to);
      }
    });
  }, [reveal, data]);

  useEffect(() => {
    handle({
      // Cites the selected lines (or the line with the cursor), quoting them.
      citeTarget: () => {
        const view = viewRef.current;
        if (!view) return null;
        const sel = view.state.selection.main;
        const doc = view.state.doc;
        const start = doc.lineAt(sel.from).number;
        const end = doc.lineAt(sel.to).number;
        const quote = (sel.empty ? doc.line(start).text : view.state.sliceDoc(sel.from, sel.to)).trim().slice(0, 200);
        return { loc: { lines: { start, end } }, quote: quote || undefined };
      },
    });
    return () => handle(null);
  }, []);

  return (
    <>
      <div className="toolbar">
        {children}
        <span className="muted" style={{ fontSize: 12.5 }}>Read-only</span>
        <div className="spacer" />
        <EditButton onEdit={onEdit} />
        <CiteButton icon="note" label="Cite lines" title="Insert a link to the selected lines into the note on the left (Ctrl+Shift+L)" onCite={onCite} />
      </div>
      <div className="editor-wrap note-view" ref={host} />
    </>
  );
}

export function FlowViewer({ data, onCite, handle, callbacks, onEdit }: Props) {
  useEffect(() => {
    handle({ citeTarget: () => ({ loc: {} }) });
    return () => handle(null);
  }, []);
  return (
    <>
      <div className="toolbar">
        <span className="muted" style={{ fontSize: 12.5 }}>Read-only</span>
        <div className="spacer" />
        <EditButton onEdit={onEdit} />
        <CiteButton icon="flow" label="Cite flowchart" title="Insert a link to this flowchart into the note on the left" onCite={onCite} />
      </div>
      <div className="flow-wrap">
        <FlowEditor
          key={data.byteLength + ':' + data[0]}
          initialText={decodeText(data).text}
          callbacks={callbacks}
          readOnly
          onChange={() => undefined}
          onSave={() => undefined}
          register={() => undefined}
          onZoomChange={() => undefined}
        />
      </div>
    </>
  );
}
