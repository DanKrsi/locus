// Reading a PowerPoint deck as text: the slides in order, each slide's paragraphs joined.
// Both Claude's reader and the link check need this, and neither wants a rendering engine for it.
import JSZip from 'jszip';

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Slide texts in presentation order (slide 1 first). */
export async function readSlides(data: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(data);
  const pres = (await zip.file('ppt/presentation.xml')?.async('string')) ?? '';
  const rels = (await zip.file('ppt/_rels/presentation.xml.rels')?.async('string')) ?? '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/Id="([^"]+)"/)?.[1];
    const t = m[0].match(/Target="([^"]+)"/)?.[1];
    if (id && t) target.set(id, t.replace(/^\//, '').replace(/^(?!ppt\/)/, 'ppt/'));
  }
  const order = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => target.get(m[1])).filter(Boolean) as string[];
  const out: string[] = [];
  for (const path of order) {
    const xml = (await zip.file(path)?.async('string')) ?? '';
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1])).join(''))
      .filter((t) => t.trim());
    out.push(paras.join('\n'));
  }
  return out;
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
