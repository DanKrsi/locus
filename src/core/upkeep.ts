// Keeping links up to date after a version is saved: rewriting a link's address in a note or
// flowchart, and renumbering a label that names the old place ("p12", "slide 4", "L20-33").
import { rewriteCanvas, isCanvas } from './canvas.ts';
import { escapeLabel, formatSheetRef, type Location } from './link.ts';
import { extractLinks } from './mdlinks.ts';

/** One link to rewrite: every link in the note with this address (and label, when given). */
export interface LinkUpdate {
  dest: string;
  /** Only the link with this label, when one address is used with several labels. */
  label?: string;
  newDest: string;
  newLabel?: string;
  /** A new quote for the link's title; null drops the old one (it no longer applies to a redrawn area). */
  newTitle?: string | null;
}

/**
 * Renumbers the place a label names, when it names the old one: "client.py L20-33" becomes
 * "client.py L24-37", "BDS p12" becomes "BDS p14". Nothing else in the label is touched, and a
 * label that doesn't name the old place comes back unchanged.
 */
export function renumberLabel(label: string, from: Location, to: Location): string {
  if (from.lines && to.lines) {
    const { start, end } = from.lines;
    const next = to.lines.end !== to.lines.start ? `L${to.lines.start}-${to.lines.end}` : `L${to.lines.start}`;
    const old = end !== start ? new RegExp(`\\bL${start}\\s?[-–]\\s?L?${end}\\b`) : new RegExp(`\\bL${start}\\b(?!\\s?[-–]\\s?L?\\d)`);
    return label.replace(old, next);
  }
  if (from.page !== undefined && to.page !== undefined && from.page !== to.page) {
    return label.replace(new RegExp(`\\b(p\\.?\\s?|page\\s)${from.page}\\b`, 'i'), (_m, lead: string) => lead + to.page);
  }
  if (from.slide !== undefined && to.slide !== undefined && from.slide !== to.slide) {
    return label.replace(new RegExp(`\\b(slide\\s)${from.slide}\\b`, 'i'), (_m, lead: string) => lead + to.slide);
  }
  if (from.sheet && to.sheet) {
    const old = formatSheetRef(from.sheet);
    const next = formatSheetRef(to.sheet);
    if (old !== next && label.includes(old)) return label.replace(old, next);
    if (from.sheet.range !== to.sheet.range && label.includes(from.sheet.range)) return label.replace(from.sheet.range, to.sheet.range);
  }
  return label;
}

function updateMarkdown(md: string, updates: LinkUpdate[]): { text: string; count: number } {
  let out = '';
  let last = 0;
  let count = 0;
  for (const link of extractLinks(md)) {
    const u = updates.find((x) => x.dest === link.dest && (x.label === undefined || x.label === link.label));
    if (!u) continue;
    const wrapped = md[link.destFrom] === '<' || /[\s()<>]/.test(u.newDest);
    let dest = wrapped ? `<${u.newDest}>` : u.newDest;
    let destTo = link.destTo;
    if (u.newTitle !== undefined) {
      // Replace everything up to the closing bracket: the address and any title.
      const q = (u.newTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (q) dest += ` "${q}"`;
      destTo = link.to - 1;
    }
    if (u.newLabel !== undefined && u.newLabel !== link.label) {
      const labelFrom = link.from + (link.image ? 2 : 1);
      const labelTo = md.lastIndexOf('](', link.destFrom);
      out += md.slice(last, labelFrom) + escapeLabel(u.newLabel) + md.slice(labelTo, link.destFrom) + dest;
    } else {
      out += md.slice(last, link.destFrom) + dest;
    }
    last = destTo;
    count++;
  }
  return { text: out + md.slice(last), count };
}

/** Applies link updates to the text of a note or flowchart. `count` is how many links changed. */
export function updateLinks(path: string, text: string, updates: LinkUpdate[]): { text: string; count: number } {
  if (!isCanvas(path)) return updateMarkdown(text, updates);
  return rewriteCanvas(text, (md) => updateMarkdown(md, updates)) ?? { text, count: 0 };
}
