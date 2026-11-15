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
