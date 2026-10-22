// Hover card for references: preview on the left, details and actions on the right (UI spec §4.1).
import type { EditorView } from '@codemirror/view';
import { basename, dirname, fileKind, formatSheetRef, formatTime, parseA1Range, resolvePath, colLetters } from '../../core/link';
import type { Terminology } from '../../shared/api';
import { decodeText, loadBytes, type FileSource } from '../files';
import { iconSvg, kindIcon } from '../icons';
import { longDate } from '../terms';
import { renderThumb } from '../viewers/pdf';
import { cellKey, loadWorkbook, resolveSheetRef } from '../viewers/sheetModel';
import { removeLink, renameLink, revealLink, type LinkInfo, type RefStatus } from './editor';

export interface HoverContext {
  notePath: string;
  terminology: Terminology;
  status: RefStatus;
  versionDate(sha: string): string | undefined;
  follow(info: LinkInfo): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function describeLocation(info: LinkInfo): string {
  const { loc } = info.ref;
  if (loc.page !== undefined) return loc.viewrect ? `Area on page ${loc.page}` : `Page ${loc.page}`;
  if (loc.slide !== undefined) return `Slide ${loc.slide}`;
  if (loc.lines) return loc.lines.end !== loc.lines.start ? `Lines ${loc.lines.start}–${loc.lines.end}` : `Line ${loc.lines.start}`;
  if (loc.sheet) return loc.sheet.sheet ? `Cells ${loc.sheet.range} on ${loc.sheet.sheet}` : `Range ${formatSheetRef(loc.sheet)}`;
  if (loc.heading) return `Section: ${loc.heading}`;
  if (loc.time !== undefined) return `At ${formatTime(loc.time)}`;
  return 'Whole file';
}

export function sourceOf(info: LinkInfo, notePath: string): FileSource {
  const external = info.ref.pathKind === 'external';
  return { path: external ? info.ref.path : resolvePath(info.ref, notePath), external, rev: info.ref.rev };
}

async function buildPreview(info: LinkInfo, src: FileSource): Promise<HTMLElement | null> {
  const kind = fileKind(src.path);
  const { loc } = info.ref;
  const data = await loadBytes(src);
  if (kind === 'pdf') return renderThumb(data, loc.page ?? 1, 150, loc.viewrect);
  if (kind === 'code' || kind === 'markdown') {
    const lines = decodeText(data).text.split(/\r?\n/);
    const start = loc.lines?.start ?? 1;
    const end = Math.min(loc.lines?.end ?? start + 6, start + 7, lines.length);
    const pre = el('pre');
    for (let l = start; l <= end; l++) {
      pre.append(el('span', 'ln', String(l)), (lines[l - 1] ?? '') + '\n');
    }
    return pre;
  }
  if (kind === 'sheet' && loc.sheet) {
    const wb = await loadWorkbook(data, basename(src.path));
    const hit = resolveSheetRef(wb, loc.sheet);
    if (!hit) return null;
    const sheet = wb.sheets[hit.sheet];
    const table = el('table');
    const head = el('tr');
    head.append(el('th'));
    const right = Math.min(hit.box.right, hit.box.left + 3, sheet.cols);
    const bottom = Math.min(hit.box.bottom, hit.box.top + 5, sheet.rows);
    for (let c = hit.box.left; c <= right; c++) head.append(el('th', undefined, colLetters(c)));
    table.append(head);
    for (let r = hit.box.top; r <= bottom; r++) {
      const tr = el('tr');
      tr.append(el('th', undefined, String(r)));
      for (let c = hit.box.left; c <= right; c++) {
        const cell = sheet.cells.get(cellKey(r, c));
        const td = el('td', undefined, cell?.text ?? '');
        if (cell?.num) td.style.textAlign = 'right';
        tr.append(td);
      }
      table.append(tr);
    }
    return table;
  }
  if (kind === 'image') {
    const img = el('img');
    img.src = URL.createObjectURL(new Blob([data as BlobPart]));
    img.style.width = '100%';
    return img;
  }
  return null;
}

export function renderHoverCard(info: LinkInfo, view: EditorView, ctx: HoverContext): HTMLElement {
  const src = sourceOf(info, ctx.notePath);
  const card = el('div', 'hover-card');
  const preview = el('div', 'preview');
  const kind = fileKind(src.path);
  if (kind === 'pdf' || kind === 'code' || kind === 'markdown' || kind === 'sheet' || kind === 'image') {
    card.append(preview);
    buildPreview(info, src)
      .then((node) => (node ? preview.replaceChildren(node) : preview.remove()))
      .catch(() => preview.remove());
  }

  const infoEl = el('div', 'info');
  const fname = el('div', 'fname');
  fname.innerHTML = iconSvg(kindIcon(kind));
  fname.append(basename(src.path));
  infoEl.append(fname);
  const folder = src.external ? src.path.replace(/[\\/][^\\/]*$/, '') : dirname(src.path);
  infoEl.append(el('div', 'folder', src.external ? `External · ${folder}` : folder === '/' ? 'Workspace root' : folder.slice(1)));
  infoEl.append(el('div', undefined, describeLocation(info)));

  const { rev, at } = info.ref;
  if (rev) {
    const date = ctx.versionDate(rev);
    const v = el('div', 'muted');
    v.textContent = ctx.terminology === 'git' ? `Pinned to ${rev.slice(0, 7)}` : `Version from ${date ? longDate(date) : rev.slice(0, 7)}`;
    infoEl.append(v);
  } else if (at) {
    const date = ctx.versionDate(at);
    infoEl.append(el('div', 'muted', ctx.terminology === 'git' ? `Latest · cited at ${at.slice(0, 7)}` : `Latest version · cited ${date ? longDate(date) : ''}`));
  }
  if (ctx.status.state === 'broken') {
    const b = el('div');
    b.style.color = 'var(--danger)';
    b.textContent = ctx.status.reason ?? 'This link is broken';
    infoEl.append(b);
  }
  if (info.title) infoEl.append(el('div', 'quote', `“${info.title}”`));

  const actions = el('div', 'actions');
  const button = (label: string, cls: string, fn: () => void) => {
    const b = el('button', cls, label);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', fn);
    actions.append(b);
  };
  button('Open', 'primary', () => ctx.follow(info));
  button('Rename', 'outline', () => renameLink(view, info));
  button('Edit target', 'outline', () => revealLink(view, info));
  button('Remove link', 'danger-text', () => removeLink(view, info));
  infoEl.append(actions);
  card.append(infoEl);
  return card;
}

export { parseA1Range };
