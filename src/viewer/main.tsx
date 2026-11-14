// Entry point of the viewer bundle that ships with an exported folder. It runs from file://, so
// PDF.js can't load its worker from a sibling file: the worker is carried inside this bundle and
// started from a blob instead.
import { createRoot } from 'react-dom/client';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { pdfjs } from '../renderer/viewers/pdf';
import 'pdfjs-dist/web/pdf_viewer.css';
import '../renderer/styles.css';
import './viewer.css';
import { Viewer } from './Viewer';
import { NOTE_CSS } from '../core/page';

try {
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
} catch {
  /* without a worker PDF.js falls back to the main thread */
}

// The note reads the same here as in an exported page.
const style = document.createElement('style');
style.textContent = NOTE_CSS;
document.head.append(style);

createRoot(document.getElementById('root')!).render(<Viewer />);
