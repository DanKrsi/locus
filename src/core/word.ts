// Reading a Word document as paragraphs: the place a Word link points at is a paragraph (or a run
// of them), counted in the file's own order, so the app, Claude's reader and an exported page all
// count the same way whatever draws the document. Pages are left out on purpose: where a page
// breaks depends on the program drawing it, and a link has to mean the same place everywhere.
import JSZip from 'jszip';

export interface WordParagraph {
  /** 1-based, in the order the paragraphs appear in the file (a table's cells row by row). */
  n: number;
  text: string;
  /** 1-9 for a heading (a title counts as 1). */
  heading?: number;
  /** Inside a table. */
  table?: boolean;
  /** A numbered or bulleted list item. */
  list?: boolean;
}

export interface WordDocument {
  paragraphs: WordParagraph[];
  /** Footnotes and endnotes, in order, for reading (they are not places a link points at). */
  notes: string[];
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Heading levels of the paragraph styles that are headings, by style id. */
export function headingStyles(stylesXml: string): Map<string, number> {
  const info = new Map<string, { name: string; level?: number; basedOn?: string }>();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (attr(m[1], 'w:type') !== 'paragraph') continue;
    const id = attr(m[1], 'w:styleId');
    if (!id) continue;
    const name = (m[2].match(/<w:name\b[^>]*w:val="([^"]*)"/)?.[1] ?? '').toLowerCase();
    const lvl = m[2].match(/<w:outlineLvl\b[^>]*w:val="(\d)"/)?.[1];
    info.set(id, { name, level: lvl !== undefined ? Number(lvl) + 1 : undefined, basedOn: m[2].match(/<w:basedOn\b[^>]*w:val="([^"]*)"/)?.[1] });
  }
  const out = new Map<string, number>();
  for (const [id] of info) {
    // The level comes from the style or the one it is based on; the name decides when none says.
    let level: number | undefined;
    for (let s = info.get(id), hops = 0; s && hops < 10 && level === undefined; s = s.basedOn ? info.get(s.basedOn) : undefined, hops++) {
      const named = s.name.match(/^heading (\d)$/);
      level = s.level ?? (named ? Number(named[1]) : s.name === 'title' ? 1 : undefined);
    }
    if (level !== undefined && level <= 9) out.set(id, level);
  }
  return out;
}

/**
 * The paragraphs of a document body, from word/document.xml. A paragraph inside another one (the
 * text in a text box) comes right after the paragraph holding it. Only what is shown counts: text
 * deleted with changes tracked, field codes and a modern drawing's old-style copy are left out.
 */
export function wordParagraphs(documentXml: string, stylesXml = ''): WordParagraph[] {
  const styles = headingStyles(stylesXml);
  let body = documentXml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/)?.[1] ?? documentXml;
  // A drawing written twice keeps only its modern form (the one a reader draws).
  body = body.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, '');
  const out: WordParagraph[] = [];
  const stack: WordParagraph[] = [];
  let tables = 0;
  let props = 0;
  const token =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<(\/?)w:(p|tbl|pPr|rPr|tab|br|cr|noBreakHyphen|softHyphen|sym|pStyle|outlineLvl|numPr)\b([^>]*?)(\/?)>/g;
  for (const m of body.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      if (top) top.text += decode(m[1]);
      continue;
    }
    const [, , close, name, rest, self] = m;
    if (name === undefined) continue; // an empty <w:t/>
    if (name === 'p') {
      if (close) {
        stack.pop();
        continue;
      }
      const p: WordParagraph = { n: out.length + 1, text: '' };
      if (tables > 0) p.table = true;
      out.push(p);
      if (!self) stack.push(p);
    } else if (name === 'tbl') {
      if (self) continue;
      tables += close ? -1 : 1;
    } else if (name === 'pPr' || name === 'rPr') {
      if (self) continue;
      props += close ? -1 : 1;
    } else if (close) {
      continue;
    } else if (name === 'pStyle') {
      const level = styles.get(attr(rest, 'w:val') ?? '');
      if (top && level !== undefined) top.heading = level;
    } else if (name === 'outlineLvl') {
      const v = Number(attr(rest, 'w:val'));
      if (top && props > 0 && v >= 0 && v <= 8) top.heading = v + 1;
    } else if (name === 'numPr') {
      if (top && props > 0) top.list = true;
    } else if (props > 0) {
      continue; // tab stops and the like, inside a paragraph's settings
    } else if (!top) {
      continue;
    } else if (name === 'tab') top.text += '\t';
    else if (name === 'br' || name === 'cr') top.text += attr(rest, 'w:type') === 'page' ? '' : '\n';
    else if (name === 'noBreakHyphen') top.text += '-';
    else if (name === 'sym') {
      const code = attr(rest, 'w:char');
      if (code) top.text += String.fromCodePoint(parseInt(code, 16) & 0xffff);
    }
  }
  return out;
}

/** The text of footnotes or endnotes (word/footnotes.xml, word/endnotes.xml), skipping the separators. */
export function wordNotes(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<w:(?:footnote|endnote)\b([^>]*)>([\s\S]*?)<\/w:(?:footnote|endnote)>/g)) {
    if (/w:type="(separator|continuationSeparator|continuationNotice)"/.test(m[1])) continue;
    const text = wordParagraphs(`<w:body>${m[2]}</w:body>`)
      .map((p) => p.text)
      .join(' ')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

export async function readWord(data: Uint8Array): Promise<WordDocument> {
  const zip = await JSZip.loadAsync(data);
  const doc = await zip.file('word/document.xml')?.async('string');
  if (doc === undefined) throw new Error("This isn't a Word document (.docx): it has no document part");
  const styles = (await zip.file('word/styles.xml')?.async('string')) ?? '';
  const notes: string[] = [];
  for (const part of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = await zip.file(part)?.async('string');
    if (xml) notes.push(...wordNotes(xml));
  }
  return { paragraphs: wordParagraphs(doc, styles), notes };
}

/** Letters and digits only, lower-cased: so spacing, line breaks and punctuation don't decide a match. */
export const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export interface ParagraphRange {
  start: number;
  end: number;
}

/**
 * The paragraphs a quote is in now, or null when the words are no longer in the document. A quote
 * may run across paragraphs. When it appears more than once, the place nearest paragraph `near`
 * (where it was cited) wins.
 */
export function findParagraphs(paras: Pick<WordParagraph, 'text'>[], quote: string, near = 1): ParagraphRange | null {
  const want = bare(quote);
  if (!want) return null;
  // One long string of every paragraph's letters, and where each paragraph starts in it.
  const starts: number[] = [];
  let all = '';
  for (const p of paras) {
    starts.push(all.length);
    all += bare(p.text);
  }
  const at = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let best: ParagraphRange | null = null;
  for (let i = all.indexOf(want); i >= 0; i = all.indexOf(want, i + 1)) {
    const hit = { start: at(i), end: at(i + want.length - 1) };
    if (!best || Math.abs(hit.start - near) < Math.abs(best.start - near)) best = hit;
  }
  return best;
}

/** Whether the quote is inside the given paragraphs. */
export function quoteIn(paras: Pick<WordParagraph, 'text'>[], range: ParagraphRange, quote: string): boolean {
  const want = bare(quote);
  return !!want && paras.slice(range.start - 1, range.end).map((p) => bare(p.text)).join('').includes(want);
}

/**
 * Which drawn paragraphs (elements on screen, by index) show each paragraph of the file. A
 * drawing usually has one element per paragraph, but it may split a paragraph where a page breaks
 * or add a footnote's number to it; texts are matched, and where they can't be, the order decides.
 */
export function alignParagraphs(file: string[], drawn: string[]): number[][] {
  const a = file.map(bare);
  const b = drawn.map(bare);
  const out: number[][] = a.map(() => []);
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) {
    const want = a[i];
    if (b[j] === want || (want && b[j].startsWith(want) && !(i + 1 < a.length && a[i + 1] && b[j] === want + a[i + 1]))) {
      out[i].push(j++);
      continue;
    }
    // An empty paragraph the drawing left out: the element is the next paragraph's.
    if (!want && b[j]) {
      const next = a.slice(i + 1).find((t) => t);
      if (next && (b[j] === next || b[j].startsWith(next))) continue;
    }
    // Split across elements: take elements while together they are still the start of the text
    // (the last one may carry a footnote's number after it).
    if (want && b[j] && want.startsWith(b[j])) {
      let got = '';
      const took: number[] = [];
      let k = j;
      while (k < b.length && got.length < want.length) {
        const more = got + b[k];
        if (!want.startsWith(more) && !more.startsWith(want)) break;
        got = more;
        took.push(k++);
      }
      if (got.startsWith(want)) {
        out[i].push(...took);
        j = k;
        continue;
      }
    }
    // Look a little ahead for this paragraph's text (something drawn that the file has no paragraph for).
    if (want) {
      const ahead = b.slice(j + 1, j + 6).findIndex((t) => t === want);
      if (ahead >= 0) {
        j += ahead + 1;
        out[i].push(j++);
        continue;
      }
    }
    out[i].push(j++);
  }
  return out;
}
