// Finds quoted text among positioned text runs (e.g. a PDF page) and returns its bounding box.
// Lets Claude cite by quoting, which it is good at, instead of guessing coordinates.
import type { Rect } from './link';

export interface TextRun {
  str: string;
  /** Top-left corner and size, in page units (PDF points from the top-left). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface QuoteMatch {
  rect: Rect;
  /** Indices of the runs the match touches. */
  runs: number[];
}

/** Lower-cases, unifies quotes/dashes/ligatures and drops whitespace so line breaks don't matter. */
function normalizeChar(ch: string): string {
  const map: Record<string, string> = {
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '–': '-', '—': '-', '−': '-', 'ﬁ': 'fi', 'ﬂ': 'fl', ' ': ' ',
  };
  return (map[ch] ?? ch).toLowerCase();
}

function normalize(text: string): string {
  let out = '';
  for (const ch of text) {
    const n = normalizeChar(ch);
    if (!/\s/.test(n)) out += n;
  }
  return out;
}

export function findQuote(runs: TextRun[], quote: string, pad = 3): QuoteMatch | null {
  // Build one whitespace-free string with a map from each character back to its run.
  let text = '';
  const owner: number[] = [];
  const offset: number[] = [];
  runs.forEach((run, i) => {
    let k = 0;
    for (const ch of run.str) {
      const n = normalizeChar(ch);
      for (const c of n) {
        if (/\s/.test(c)) continue;
        text += c;
        owner.push(i);
        offset.push(k);
      }
      k++;
    }
  });
  // Hyphenated line breaks ("exam-" + "ple") would otherwise prevent a match.
  const q = normalize(quote);
  if (!q) return null;
  let at = text.indexOf(q);
  let len = q.length;
  if (at < 0) {
    const dehyph = q.replace(/-/g, '');
    const stripped: number[] = [];
    let t2 = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '-') continue;
      t2 += text[i];
      stripped.push(i);
    }
    const j = t2.indexOf(dehyph);
    if (j < 0) return null;
    at = stripped[j];
    len = stripped[j + dehyph.length - 1] - at + 1;
  }
  const touched = new Map<number, { from: number; to: number }>();
  for (let i = at; i < at + len; i++) {
    const r = owner[i];
    const cur = touched.get(r);
    if (cur) cur.to = Math.max(cur.to, offset[i]);
    else touched.set(r, { from: offset[i], to: offset[i] });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [i, span] of touched) {
    const run = runs[i];
    const chars = Math.max(1, [...run.str].length);
    // Partial runs: estimate the sub-span by character position.
    const left = run.x + (run.w * span.from) / chars;
    const right = run.x + (run.w * (span.to + 1)) / chars;
    x0 = Math.min(x0, left);
    x1 = Math.max(x1, right);
    y0 = Math.min(y0, run.y);
    y1 = Math.max(y1, run.y + run.h);
  }
  return {
    rect: { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 },
    runs: [...touched.keys()].sort((a, b) => a - b),
  };
}
