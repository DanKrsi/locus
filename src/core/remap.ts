// Maps a cited line range forward through the changes made since it was cited.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface MappedLines {
  start: number;
  end: number;
  /** 'same': untouched · 'moved': shifted only · 'changed': some cited lines were edited · 'gone': all deleted. */
  status: 'same' | 'moved' | 'changed' | 'gone';
}

/** Maps one old line number to the new file. Lines inside an edited block map into the new block. */
function mapLine(hunks: Hunk[], line: number): number {
  let offset = 0;
  for (const h of hunks) {
    if (h.oldLines === 0) {
      // Pure insertion after line oldStart.
      if (h.oldStart < line) offset += h.newLines;
      continue;
    }
    const oldEnd = h.oldStart + h.oldLines - 1;
    if (oldEnd < line) offset += h.newLines - h.oldLines;
    else if (h.oldStart <= line) {
      if (h.newLines === 0) return Math.max(1, h.newStart + 1);
      return h.newStart + Math.min(line - h.oldStart, h.newLines - 1);
    } else break;
  }
  return line + offset;
}

/** `hunks` are zero-context hunks (git diff -U0), in order, from the cited version to the current file. */
export function mapLines(hunks: Hunk[], start: number, end: number): MappedLines {
  let touched = false;
  let deleted = 0;
  for (const h of hunks) {
    if (h.oldLines === 0) {
      if (h.oldStart >= start && h.oldStart < end) touched = true;
      continue;
    }
    const oldEnd = h.oldStart + h.oldLines - 1;
    const overlap = Math.min(end, oldEnd) - Math.max(start, h.oldStart) + 1;
    if (overlap > 0) {
      touched = true;
      if (h.newLines === 0) deleted += overlap;
    }
  }
  const s = mapLine(hunks, start);
  const e = Math.max(s, mapLine(hunks, end));
  if (deleted >= end - start + 1) return { start: s, end: s, status: 'gone' };
  if (touched) return { start: s, end: e, status: 'changed' };
  return { start: s, end: e, status: s === start ? 'same' : 'moved' };
}
