// Finding a cited picture again. A box drawn over a figure, a photo or a scanned drawing has no
// words to quote, so when the document changes there is nothing to look for but the picture itself.
// This finds where the pixels of the old box best line up in a new page: normalised
// cross-correlation, which ignores overall brightness and contrast, coarse to fine so a page takes
// milliseconds. Everything here works on plain grey pixel arrays; rendering is the caller's job.

/** A grey image: one value per pixel, row by row. */
export interface Gray {
  w: number;
  h: number;
  px: Float32Array;
}

export function gray(w: number, h: number, px?: Float32Array): Gray {
  return { w, h, px: px ?? new Float32Array(w * h) };
}

/** RGBA bytes (a canvas's) to grey, with transparent pixels as white paper. */
export function fromRgba(w: number, h: number, rgba: Uint8ClampedArray | Uint8Array): Gray {
  const out = gray(w, h);
  for (let i = 0, j = 0; i < out.px.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const v = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    out.px[i] = v * a + 255 * (1 - a);
  }
  return out;
}

export function crop(g: Gray, x: number, y: number, w: number, h: number): Gray {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(Math.round(w), g.w - x));
  h = Math.max(1, Math.min(Math.round(h), g.h - y));
  const out = gray(w, h);
  for (let r = 0; r < h; r++) out.px.set(g.px.subarray((y + r) * g.w + x, (y + r) * g.w + x + w), r * w);
  return out;
}

/** Shrinks by a whole factor, averaging each block (so fine detail blurs instead of aliasing). */
export function shrink(g: Gray, k: number): Gray {
  if (k <= 1) return g;
  const w = Math.max(1, Math.floor(g.w / k));
  const h = Math.max(1, Math.floor(g.h / k));
  const out = gray(w, h);
  const n = k * k;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++) {
        const row = (y * k + dy) * g.w + x * k;
        for (let dx = 0; dx < k; dx++) s += g.px[row + dx];
      }
      out.px[y * w + x] = s / n;
    }
  return out;
}

/** Resizes to w x h by bilinear sampling (a picture that came back larger or smaller). */
export function resize(g: Gray, w: number, h: number): Gray {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const out = gray(w, h);
  const sx = g.w / w;
  const sy = g.h / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(g.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(g.h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(g.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(g.w - 1, x0 + 1);
      const tx = fx - x0;
      const a = g.px[y0 * g.w + x0] * (1 - tx) + g.px[y0 * g.w + x1] * tx;
      const b = g.px[y1 * g.w + x0] * (1 - tx) + g.px[y1 * g.w + x1] * tx;
      out.px[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** How much the picture varies (standard deviation, 0–255). Near 0 is blank paper or a flat fill. */
export function detail(g: Gray): number {
  let s = 0;
  let q = 0;
  for (const v of g.px) {
    s += v;
    q += v * v;
  }
  const n = g.px.length;
  return Math.sqrt(Math.max(0, q / n - (s / n) ** 2));
}

/** Running sums for the mean and variance of any window of the page in constant time. */
function integrals(g: Gray) {
  const W = g.w + 1;
  const sum = new Float64Array(W * (g.h + 1));
  const sq = new Float64Array(W * (g.h + 1));
  for (let y = 0; y < g.h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < g.w; x++) {
      const v = g.px[y * g.w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  const box = (a: Float64Array, x: number, y: number, w: number, h: number) => a[(y + h) * W + x + w] - a[y * W + x + w] - a[(y + h) * W + x] + a[y * W + x];
  return { sum: (x: number, y: number, w: number, h: number) => box(sum, x, y, w, h), sq: (x: number, y: number, w: number, h: number) => box(sq, x, y, w, h) };
}

/** A template with its mean taken out, ready to correlate. */
function prepare(t: Gray) {
  const n = t.px.length;
  let m = 0;
  for (const v of t.px) m += v;
  m /= n;
  const z = new Float32Array(n);
  let q = 0;
  for (let i = 0; i < n; i++) {
    z[i] = t.px[i] - m;
    q += z[i] * z[i];
  }
  return { z, norm: Math.sqrt(q), n };
}

type Prepared = ReturnType<typeof prepare>;
type Sums = ReturnType<typeof integrals>;

/**
 * The correlation of the template at (x, y): 1 is the same picture, 0 unrelated. A window of flat
 * paper (no variation) scores 0 rather than dividing by nothing.
 */
function scoreAt(page: Gray, sums: Sums, t: Gray, p: Prepared, x: number, y: number): number {
  const s = sums.sum(x, y, t.w, t.h);
  const varW = sums.sq(x, y, t.w, t.h) - (s * s) / p.n;
  if (varW <= 1e-6 || p.norm <= 1e-6) return 0;
  let dot = 0;
  for (let r = 0; r < t.h; r++) {
    const row = (y + r) * page.w + x;
    const tr = r * t.w;
    for (let c = 0; c < t.w; c++) dot += page.px[row + c] * p.z[tr + c];
  }
  return dot / (Math.sqrt(varW) * p.norm);
}

export interface Hit {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

const overlaps = (a: Hit, b: { x: number; y: number; w: number; h: number }) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy > 0.25 * Math.min(a.w * a.h, b.w * b.h);
};

/** Every position, keeping the best few that don't overlap each other. */
function scan(page: Gray, t: Gray, keep: number): Hit[] {
  if (t.w > page.w || t.h > page.h) return [];
  const sums = integrals(page);
  const p = prepare(t);
  const best: Hit[] = [];
  for (let y = 0; y <= page.h - t.h; y++)
    for (let x = 0; x <= page.w - t.w; x++) {
      const score = scoreAt(page, sums, t, p, x, y);
      if (best.length >= keep && score <= best[best.length - 1].score) continue;
      const hit = { x, y, w: t.w, h: t.h, score };
      const clash = best.findIndex((b) => overlaps(b, hit));
      if (clash >= 0) {
        if (best[clash].score >= score) continue;
        best.splice(clash, 1);
      }
      best.push(hit);
      best.sort((a, b) => b.score - a.score);
      if (best.length > keep) best.pop();
    }
  return best;
}

/** The best position within `reach` pixels of (x, y). */
function refine(page: Gray, sums: Sums, t: Gray, p: Prepared, x: number, y: number, reach: number): Hit {
  let top: Hit = { x, y, w: t.w, h: t.h, score: -2 };
  for (let yy = Math.max(0, y - reach); yy <= Math.min(page.h - t.h, y + reach); yy++)
    for (let xx = Math.max(0, x - reach); xx <= Math.min(page.w - t.w, x + reach); xx++) {
      const score = scoreAt(page, sums, t, p, xx, yy);
      if (score > top.score) top = { x: xx, y: yy, w: t.w, h: t.h, score };
    }
  return top;
}

/**
 * Where the template best matches in the page, and the best place that is not that one (to tell a
 * unique picture from a repeated logo or a ruled table). Both images are at the same resolution.
 * The whole page is searched shrunk (so the template is a few hundred pixels), and the best few
 * places are then refined at each doubling of resolution, so a page costs about the same whatever
 * the size of the box.
 */
export function findPicture(page: Gray, t: Gray): { best: Hit | null; runnerUp: Hit | null } {
  if (t.w > page.w || t.h > page.h) return { best: null, runnerUp: null };
  // Shrink while the template stays big enough to recognise (16 px a side, or 8 for a thin box).
  const floor = Math.min(t.w, t.h) < 64 ? 8 : 16;
  let k = 1;
  while (k < 32 && t.w / (k * 2) >= floor && t.h / (k * 2) >= floor) k *= 2;
  let hits = scan(shrink(page, k), shrink(t, k), 6);
  for (let level = k / 2; level >= 1; level /= 2) {
    const pg = shrink(page, level);
    const tl = shrink(t, level);
    const sums = integrals(pg);
    const p = prepare(tl);
    hits = hits.map((h) => refine(pg, sums, tl, p, Math.min(pg.w - tl.w, h.x * 2), Math.min(pg.h - tl.h, h.y * 2), 2));
  }
  hits.sort((a, b) => b.score - a.score);
  // At full size, a position is exact; the size is the template's.
  const best = hits[0] ? { ...hits[0], w: t.w, h: t.h } : null;
  const other = best ? hits.find((h) => !overlaps(best, { ...h, w: t.w, h: t.h })) : undefined;
  return { best, runnerUp: other ? { ...other, w: t.w, h: t.h } : null };
}

// ---------- What a search found, in words a person can act on ----------

/** A box on a page, in PDF points from the page's top-left (the units links use). */
export interface PageBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export type PictureVerdict =
  /** The box has no picture in it (blank paper, a flat fill): nothing to look for. */
  | { kind: 'blank' }
  /** Not found anywhere searched with confidence. */
  | { kind: 'gone'; best?: PageBox }
  /** The same picture in the same place. */
  | { kind: 'same'; at: PageBox }
  /** Found once, somewhere else (another page, another spot, another size). */
  | { kind: 'moved'; at: PageBox }
  /** Found in several places about equally well: the one nearest the old place. */
  | { kind: 'several'; at: PageBox; count: number };

/** Scores at or above this are the same picture; below it, a lookalike (measured: text lines reach 0.71). */
export const SAME_PICTURE = 0.9;
/** Same place, to this many points, and this sure: nothing happened to it. */
const STILL_THERE = 0.97;
const NEAR_PT = 3;
/** A rival this close to the best makes the picture repeated rather than found. */
const RIVAL = 0.06;

/**
 * Decides from every page's best and runner-up places. `old` is the cited box (score unused).
 * Repeated pictures (a logo in every header) are reported as such, not followed.
 */
export function judgePicture(old: Omit<PageBox, 'score'>, hits: PageBox[]): PictureVerdict {
  const all = [...hits].sort((a, b) => b.score - a.score);
  const best = all[0];
  if (!best || best.score < SAME_PICTURE) return { kind: 'gone', best };
  const near = (h: PageBox) => h.page === old.page && Math.abs(h.x - old.x) <= NEAR_PT && Math.abs(h.y - old.y) <= NEAR_PT && Math.abs(h.w - old.w) <= NEAR_PT && Math.abs(h.h - old.h) <= NEAR_PT;
  const contenders = all.filter((h) => h.score >= Math.max(SAME_PICTURE, best.score - RIVAL));
  const here = contenders.find((h) => near(h) && h.score >= STILL_THERE);
  if (here) return { kind: 'same', at: here };
  if (contenders.length === 1) return { kind: 'moved', at: best };
  const distance = (h: PageBox) => Math.abs(h.page - old.page) * 1e6 + Math.hypot(h.x - old.x, h.y - old.y);
  const nearest = [...contenders].sort((a, b) => distance(a) - distance(b))[0];
  return { kind: 'several', at: nearest, count: contenders.length };
}

/** Below this much variation (0–255) a box is blank paper or a flat fill, and matches anywhere. */
export const BLANK = 6;
