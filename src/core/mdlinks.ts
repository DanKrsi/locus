// Finds inline markdown links in a document without a full markdown parser, skipping code.
import { splitLinkTarget } from './link.ts';

export interface MdLink {
  label: string;
  dest: string;
  title?: string;
  /** 1-based line of the link. */
  line: number;
  from: number;
  to: number;
  image: boolean;
}

export function extractLinks(md: string): MdLink[] {
  const out: MdLink[] = [];
  const lineStarts = [0];
  for (let i = 0; i < md.length; i++) if (md[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  let i = 0;
  let fence: string | null = null;
  while (i < md.length) {
    const atLineStart = i === 0 || md[i - 1] === '\n';
    if (atLineStart) {
      const m = md.slice(i, i + 200).match(/^ {0,3}(```+|~~~+)/);
      if (m) {
        if (!fence) fence = m[1][0];
        else if (m[1][0] === fence) fence = null;
        const nl = md.indexOf('\n', i);
        i = nl < 0 ? md.length : nl + 1;
        continue;
      }
    }
    if (fence) {
      const nl = md.indexOf('\n', i);
      i = nl < 0 ? md.length : nl + 1;
      continue;
    }
    const ch = md[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 0;
      while (md[i + n] === '`') n++;
      const close = md.indexOf('`'.repeat(n), i + n);
      i = close < 0 ? i + n : close + n;
      continue;
    }
    if (ch === '[') {
      const link = tryLink(md, i);
      if (link) {
        out.push({ ...link, line: lineOf(i) });
        i = link.to;
        continue;
      }
    }
    i++;
  }
  return out;
}

function tryLink(md: string, start: number): Omit<MdLink, 'line'> | null {
  const image = start > 0 && md[start - 1] === '!';
  let depth = 0;
  let j = start;
  for (; j < md.length; j++) {
    const c = md[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n' && md[j + 1] === '\n') return null;
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (md[j] !== ']' || md[j + 1] !== '(') return null;
  const labelEnd = j;
  let k = j + 2;
  if (md[k] === '<') {
    const close = md.indexOf('>', k);
    if (close < 0) return null;
    k = close + 1;
  }
  let parens = 1;
  let inTitle: string | null = null;
  for (; k < md.length; k++) {
    const c = md[k];
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '\n') return null;
    if (inTitle) {
      if (c === inTitle) inTitle = null;
      continue;
    }
    if (c === '"' && /\s/.test(md[k - 1])) inTitle = '"';
    else if (c === '(') parens++;
    else if (c === ')' && --parens === 0) break;
  }
  if (md[k] !== ')') return null;
  const { dest, title } = splitLinkTarget(md.slice(j + 2, k));
  return {
    label: md.slice(start + 1, labelEnd).replace(/\\([\\\[\]])/g, '$1'),
    dest,
    title,
    from: image ? start - 1 : start,
    to: k + 1,
    image,
  };
}
