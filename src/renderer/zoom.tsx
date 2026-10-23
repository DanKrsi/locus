// Zoom for the two panes, set independently: the notes editor, and the document viewers (PDFs keep
// their own zoom steps). Editors scale through a CSS variable on the editor, which makes
// CodeMirror re-measure its lines.
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Icon } from './icons';

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The next zoom step up (dir 1) or down (-1); 0 resets to 100%. */
export function stepZoom(z: number, dir: 1 | -1 | 0): number {
  if (dir === 0) return 1;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.01);
  return next ?? z;
}

const zoomCompartment = new Compartment();
// A theme, not an attribute: CodeMirror re-measures line heights when its theme changes.
const zoomAttrs = (z: number) => EditorView.theme({ '&': { '--zoom': String(z) } });

/** Editor extension holding the zoom; change it with setEditorZoom. */
export const editorZoom = (z: number) => zoomCompartment.of(zoomAttrs(z));

export function setEditorZoom(view: EditorView, z: number) {
  view.dispatch({ effects: zoomCompartment.reconfigure(zoomAttrs(z)) });
}

/** − 100% + buttons; clicking the percentage goes back to 100%. */
export function ZoomControl({ zoom, onZoom, label }: { zoom: number; onZoom(z: number): void; label: string }) {
  return (
    <div className="zoom-control" role="group" aria-label={`${label} zoom`}>
      <button className="icon" title={`Zoom out (Ctrl+−)`} disabled={zoom <= ZOOM_STEPS[0]} onClick={() => onZoom(stepZoom(zoom, -1))}>
        <Icon name="zoomOut" />
      </button>
      <button className="zoom-pct" title="Back to 100%" onClick={() => onZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon" title={`Zoom in (Ctrl+=)`} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => onZoom(stepZoom(zoom, 1))}>
        <Icon name="zoomIn" />
      </button>
    </div>
  );
}
