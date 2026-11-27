// Reading a PowerPoint deck as text: the slides in order, each slide's paragraphs joined, its
// speaker notes, and where each piece of text sits on the slide (so a quote can be boxed). Both Claude's reader and the link check need this, and neither wants a rendering engine for it.
import JSZip from 'jszip';

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Where a part's relationships point, with each target as a full path in the zip. */
async function relsOf(zip: JSZip, part: string): Promise<{ id: string; type: string; path: string }[]> {
  const dir = part.slice(0, part.lastIndexOf('/') + 1);
  const xml = (await zip.file(`${dir}_rels/${part.slice(dir.length)}.rels`)?.async('string')) ?? '';
  const out: { id: string; type: string; path: string }[] = [];
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/Id="([^"]+)"/)?.[1];
    const t = m[0].match(/Target="([^"]+)"/)?.[1];
    const type = m[0].match(/Type="([^"]+)"/)?.[1] ?? '';
    if (!id || !t || /TargetMode="External"/.test(m[0])) continue;
    // Targets are relative to the part's folder ("../slideLayouts/x.xml") or absolute from the zip's root.
    const path: string[] = [];
    for (const seg of (t.startsWith('/') ? t.slice(1) : dir + t).split('/')) {
      if (seg === '..') path.pop();
      else if (seg && seg !== '.') path.push(seg);
    }
    out.push({ id, type, path: path.join('/') });
  }
  return out;
}

/** The text of an XML fragment, paragraph by paragraph (blank ones left out). */
const textOf = (xml: string) =>
  [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((p) => [...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1])).join(''))
    .filter((t) => t.trim())
    .join('\n');

/** A box on a slide in the units links use: points of a 960 x 540 slide. */
export interface SlideBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A shape holding text, and where it sits (unknown for the odd shape placed only by a group). */
export interface SlideShape {
  text: string;
  box?: SlideBox;
}

export interface DeckSlide {
  /** All the slide's text, in the order it is written (shapes, tables, groups). */
  text: string;
  /** The speaker notes, or '' when there are none. */
  notes: string;
  shapes: SlideShape[];
}

interface RawShape {
  text: string;
  /** In EMU: x, y, width, height. */
  xfrm?: [number, number, number, number];
  ph?: { type?: string; idx?: string };
}

/** Where groups of shapes start and end in the XML (groups may hold groups). */
function groupSpans(xml: string): [number, number][] {
  const spans: [number, number][] = [];
  const open: number[] = [];
  for (const m of xml.matchAll(/<(\/?)p:grpSp\b[^>]*>/g)) {
    if (!m[1]) open.push(m.index);
    else if (open.length) spans.push([open.pop()!, m.index]);
  }
  return spans;
}

function shapesIn(xml: string): RawShape[] {
  const groups = groupSpans(xml);
  return [...xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)].map((m) => {
    const sp = m[1];
    // A shape in a group is placed in the group's own coordinates, not the slide's: no box for it.
    const grouped = groups.some(([a, b]) => m.index > a && m.index < b);
    const x = grouped ? null : sp.match(/<a:xfrm\b[^>]*>\s*<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>\s*<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    const ph = sp.match(/<p:ph\b([^>]*)>/);
    return {
      text: textOf(sp.match(/<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/)?.[1] ?? ''),
      xfrm: x ? [Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4])] : undefined,
      ph: ph ? { type: ph[1].match(/type="([^"]+)"/)?.[1], idx: ph[1].match(/idx="([^"]+)"/)?.[1] } : undefined,
    };
  });
}

/** A placeholder's kind, with the two spellings of a title (and of body text) made one. */
const phType = (ph: { type?: string }) => (ph.type === 'ctrTitle' ? 'title' : ph.type === 'subTitle' ? 'body' : (ph.type ?? 'obj'));

/** Where a placeholder that doesn't say sits: as its layout's matching placeholder says, or else the master's. */
function placed(ph: NonNullable<RawShape['ph']>, ...from: RawShape[][]): RawShape['xfrm'] {
  for (const shapes of from) {
    const byIdx = ph.idx !== undefined ? shapes.find((s) => s.ph?.idx === ph.idx && s.xfrm) : undefined;
    const hit = byIdx ?? shapes.find((s) => s.ph && phType(s.ph) === phType(ph) && s.xfrm);
    if (hit) return hit.xfrm;
  }
  return undefined;
}

/** The deck's slides in presentation order (slide 1 first): text, speaker notes, and where each text sits. */
export async function readDeck(data: Uint8Array): Promise<DeckSlide[]> {
  const zip = await JSZip.loadAsync(data);
  const pres = (await zip.file('ppt/presentation.xml')?.async('string')) ?? '';
  const size = pres.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  const [cx, cy] = size ? [Number(size[1]), Number(size[2])] : [12192000, 6858000];
  const target = new Map((await relsOf(zip, 'ppt/presentation.xml')).map((r) => [r.id, r.path]));
  const order = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => target.get(m[1])).filter(Boolean) as string[];
  const read = async (path?: string) => (path ? ((await zip.file(path)?.async('string')) ?? '') : '');
  const layouts = new Map<string, Promise<{ layout: RawShape[]; master: RawShape[] }>>();
  const layoutOf = (path: string) => {
    let p = layouts.get(path);
    if (!p) {
      p = (async () => {
        const master = (await relsOf(zip, path)).find((r) => r.type.endsWith('/slideMaster'))?.path;
        return { layout: shapesIn(await read(path)), master: shapesIn(await read(master)) };
      })();
      layouts.set(path, p);
    }
    return p;
  };
  const out: DeckSlide[] = [];
  for (const path of order) {
    const xml = await read(path);
    const rels = await relsOf(zip, path);
    const layoutPath = rels.find((r) => r.type.endsWith('/slideLayout'))?.path;
    const inherited = layoutPath ? await layoutOf(layoutPath) : { layout: [], master: [] };
    const shapes: SlideShape[] = shapesIn(xml)
      .filter((s) => s.text)
      .map((s) => {
        const f = s.xfrm ?? (s.ph ? placed(s.ph, inherited.layout, inherited.master) : undefined);
        return f ? { text: s.text, box: { x: (f[0] * 960) / cx, y: (f[1] * 540) / cy, w: (f[2] * 960) / cx, h: (f[3] * 540) / cy } } : { text: s.text };
      });
    // A notes page holds a picture of the slide, its number and the notes; only the notes are wanted.
    const notesXml = await read(rels.find((r) => r.type.endsWith('/notesSlide'))?.path);
    const notes = shapesIn(notesXml)
      .filter((s) => s.ph && phType(s.ph) === 'body')
      .map((s) => s.text)
      .filter(Boolean)
      .join('\n');
    out.push({ text: textOf(xml), notes, shapes });
  }
  return out;
}

/** Slide texts in presentation order (slide 1 first). */
export async function readSlides(data: Uint8Array): Promise<string[]> {
  return (await readDeck(data)).map((s) => s.text);
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Puts the fallback in place of each piece of a slide that PowerPoint wrote twice: an equation,
 * a modern chart, a shape with newer effects. PowerPoint keeps a plain picture of such a piece
 * for readers that do not understand the modern form, and a reader that skips the whole block —
 * as the one Locus draws slides with does — shows nothing at all where the equation should be.
 * Where there is no picture to fall back on, the equation's own characters are left in its place
 * so the slide still reads.
 */
export function showFallbacks(xml: string): string {
  const block = /<(?:\w+:)?AlternateContent\b[^>]*>(?:(?!<(?:\w+:)?AlternateContent\b)[\s\S])*?<\/(?:\w+:)?AlternateContent>/;
  let out = xml;
  for (let i = 0; i < 100; i++) {
    const found = block.exec(out);
    if (!found) break;
    const inner = found[0];
    const fallback = /<(?:\w+:)?Fallback\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Fallback>/.exec(inner);
    let replacement = fallback ? fallback[1] : '';
    if (!fallback) {
      // No picture: keep the characters of the equation, so the slide is not silently missing it.
      // A run, not a paragraph: an equation sits inside the paragraph of a text body.
      const text = [...inner.matchAll(/<m:t[^>]*>([\s\S]*?)<\/m:t>/g)].map((m) => m[1]).join('');
      replacement = text ? `<a:r><a:t>${escapeXml(text.replace(/&[a-z]+;/g, ' '))}</a:t></a:r>` : '';
    }
    out = out.slice(0, found.index) + replacement + out.slice(found.index + inner.length);
  }
  return out;
}

/** Letters and digits only, lower-cased: so line breaks and spacing don't decide a match. */
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The smallest placed shape on a slide whose text holds the quote, or null. */
export function findShape(slide: DeckSlide, quote: string): (SlideShape & { box: SlideBox }) | null {
  const want = bare(quote);
  if (!want) return null;
  const hits = slide.shapes.filter((s): s is SlideShape & { box: SlideBox } => !!s.box && bare(s.text).includes(want));
  return hits.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0] ?? null;
}

/**
 * The slide a quote is on now, looking outward from the slide it was cited from, or null when the
 * words are no longer in the deck. Slide numbers, 1-based.
 */
export function findSlide(slides: string[], quote: string, near = 1): number | null {
  const want = bare(quote);
  if (!want) return null;
  const texts = slides.map(bare);
  const order = [near];
  for (let d = 1; d <= slides.length; d++) order.push(near - d, near + d);
  for (const n of order) {
    if (n < 1 || n > slides.length) continue;
    if (texts[n - 1].includes(want)) return n;
  }
  return null;
}
