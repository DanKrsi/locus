// Drawing a Word document (docx-preview) and finding its paragraphs on screen. The viewer and the
// pictures in notes both draw with this, so a paragraph number means the same element in each.
import { renderAsync } from 'docx-preview';
import { alignParagraphs, readWord, type WordParagraph } from '../../core/word';

export interface DrawnWord {
  /** The file's paragraphs (core/word), the numbering every link uses. */
  paragraphs: WordParagraph[];
  /** For each paragraph (index n - 1), the elements that show it: usually one, none when not drawn. */
  elements: HTMLElement[][];
  /** Paragraph number by element, for turning a selection into a place. */
  numberOf: Map<HTMLElement, number>;
  /** The pages, in order. */
  pages: HTMLElement[];
}

/**
 * Draws the document into `host`, its styles into `styleHost`. Pictures come only from inside the
 * file, as blob addresses or (with `inlinePictures`) as data, so a document can't make Locus fetch anything, and embedded web pages are not drawn, so a
 * document from someone else can't run anything.
 */
export async function drawWord(data: Uint8Array, host: HTMLElement, styleHost: HTMLElement, opts: { inlinePictures?: boolean } = {}): Promise<DrawnWord> {
  const [doc] = await Promise.all([
    readWord(data),
    renderAsync(data.slice(), host, styleHost, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      // Word records where its own pages ended; following that keeps the pages close to Word's.
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderAltChunks: false,
      renderComments: false,
      renderChanges: false,
      experimental: false,
      // A picture of the page (notes) is drawn from a copy that must carry its pictures inside it.
      useBase64URL: !!opts.inlinePictures,
    }),
  ]);
  // Paragraphs of the body only: headers, footers and notes are drawn on every page or at the end,
  // and the file counts them separately.
  const drawn = [...host.querySelectorAll<HTMLElement>('article p')];
  const lined = alignParagraphs(
    doc.paragraphs.map((p) => p.text),
    drawn.map((el) => el.textContent ?? ''),
  );
  const elements = lined.map((ix) => ix.map((i) => drawn[i]));
  const numberOf = new Map<HTMLElement, number>();
  elements.forEach((els, i) => els.forEach((el) => numberOf.set(el, i + 1)));
  for (const a of host.querySelectorAll('a')) a.setAttribute('draggable', 'false');
  return { paragraphs: doc.paragraphs, elements, numberOf, pages: [...host.querySelectorAll<HTMLElement>('section.docx')] };
}

/** The paragraph an element is part of, looking up through its parents (a run, a cell). */
export function paragraphAt(word: DrawnWord, node: Node | null): number | undefined {
  for (let el: Node | null = node; el; el = el.parentNode) {
    if (el instanceof HTMLElement) {
      const n = word.numberOf.get(el);
      if (n) return n;
    }
  }
  return undefined;
}

/** The screen box around paragraphs start..end (the parts drawn), or null when none are. */
export function paragraphsBox(word: DrawnWord, start: number, end: number): DOMRect | null {
  let box: { l: number; t: number; r: number; b: number } | null = null;
  for (let n = start; n <= end; n++) {
    for (const el of word.elements[n - 1] ?? []) {
      const b = el.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      box = box ? { l: Math.min(box.l, b.left), t: Math.min(box.t, b.top), r: Math.max(box.r, b.right), b: Math.max(box.b, b.bottom) } : { l: b.left, t: b.top, r: b.right, b: b.bottom };
    }
  }
  return box ? new DOMRect(box.l, box.t, box.r - box.l, box.b - box.t) : null;
}

/** A quote for a paragraph cited without anything selected: its first words, so the link can find it again. */
export function openingWords(text: string, limit = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > limit ? t.slice(0, limit).replace(/\s+\S*$/, '') : t;
}
