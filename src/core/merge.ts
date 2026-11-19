// Three-way merge of text by lines: combines the changes two people made to the same starting
// text. Used when a note with unsaved changes is also changed outside Locus (by Claude, say).

/** Pairs of matching line indexes [inA, inB] in a longest common run of lines (Myers' diff). */
export function matchLines(a: string[], b: string[]): [number, number][] {
  // Lines that match at the start and end need no search.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0) pairs.push(...myers(a, b, start, n, m));
  for (let i = 0; i < a.length - endA; i++) pairs.push([endA + i, endB + i]);
  return pairs;
}

/**
 * Matching lines between a[start, start+n) and b[start, start+m). Very different texts would take
 * too much memory to search; they are left unmatched, which only makes a merge more cautious.
 */
function myers(a: string[], b: string[], start: number, n: number, m: number): [number, number][] {
  const max = n + m;
  const off = max;
  const width = 2 * max + 2;
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let end = -1;
  for (let d = 0; d <= max; d++) {
    if ((d + 1) * width > 20_000_000) return [];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        end = d;
        break;
      }
    }
    if (end >= 0) break;
  }
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = end; d > 0; d--) {
    const t = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && t[off + k - 1] < t[off + k + 1]) ? k + 1 : k - 1;
    const prevX = t[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      pairs.push([start + x - 1, start + y - 1]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    pairs.push([start + x - 1, start + y - 1]);
    x--;
    y--;
  }
  return pairs.reverse();
}

export interface MergeResult {
  /** True when no line was changed differently on both sides. */
  clean: boolean;
  /** The merged text (only meaningful when clean). */
  text: string;
  /** How many places both sides changed in different ways. */
  overlaps: number;
}

/** One side's change: base lines [start, end) replaced by `lines` (start === end inserts). */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
  side: 0 | 1;
}

function hunks(o: string[], x: string[], side: 0 | 1): Hunk[] {
  const out: Hunk[] = [];
  let pi = -1;
  let pj = -1;
  for (const [i, j] of [...matchLines(o, x), [o.length, x.length] as [number, number]]) {
    if (i > pi + 1 || j > pj + 1) out.push({ start: pi + 1, end: i, lines: x.slice(pj + 1, j), side });
    pi = i;
    pj = j;
  }
  return out;
}

/**
 * Merges the changes from `base` to `mine` with those from `base` to `theirs`. Changes to different
 * lines are all taken, next-door lines included; the same change made on both sides is taken once;
 * changes on both sides to the same lines (or insertions at the same place) make it not clean.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  const o = base.split('\n');
  const all = [...hunks(o, mine.split('\n'), 0), ...hunks(o, theirs.split('\n'), 1)].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let overlaps = 0;
  let pos = 0;
  /** A stretch of the base [from, to) with one side's hunks in it applied. */
  const apply = (from: number, to: number, hs: Hunk[]) => {
    const lines: string[] = [];
    let at = from;
    for (const h of hs) {
      lines.push(...o.slice(at, h.start), ...h.lines);
      at = h.end;
    }
    lines.push(...o.slice(at, to));
    return lines;
  };
  for (let n = 0; n < all.length; ) {
    // Gather the hunks that touch one another into one place: overlapping lines, or two insertions
    // at the same spot. Changes to next-door lines don't touch.
    const from = all[n].start;
    let to = all[n].end;
    const group = [all[n++]];
    while (n < all.length && (all[n].start < to || (all[n].start === to && from === to && all[n].start === all[n].end))) {
      to = Math.max(to, all[n].end);
      group.push(all[n++]);
    }
    out.push(...o.slice(pos, from));
    const mineHere = apply(from, to, group.filter((h) => h.side === 0));
    if (group.every((h) => h.side === group[0].side)) out.push(...apply(from, to, group));
    else {
      const theirsHere = apply(from, to, group.filter((h) => h.side === 1));
      if (mineHere.join('\n') !== theirsHere.join('\n')) overlaps++;
      out.push(...mineHere);
    }
    pos = to;
  }
  out.push(...o.slice(pos));
  return { clean: overlaps === 0, text: out.join('\n'), overlaps };
}
