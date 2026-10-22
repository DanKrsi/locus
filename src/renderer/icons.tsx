// Small outline icon set (24px grid, stroke-based), usable from React and plain DOM.
const PATHS = {
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 16.5v-4h1.2a1.2 1.2 0 0 1 0 2.4H8.5M12.5 16.5v-4h.9a1.8 1.8 0 0 1 0 4zM16.5 12.5h-1.5v4M15 14.5h1.2"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  grid: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15M14.5 4.5v15"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h1.5M9 17h1.5M12 12l-1 6M14 12l-1 6M8.5 14.5h6M8 16.5h6"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.5-4.5L7 19.5"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3.5 17V7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2v1"/><path d="m3.5 17 2.6-5.6a1.5 1.5 0 0 1 1.4-.9h13l-3 7.1a1.5 1.5 0 0 1-1.4.9H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  folderPlus: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V8H7M12 8v4.5l3 2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bookmark: '<path d="M7 3.5h10v17l-5-4-5 4z"/>',
  area: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>',
  chevLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevDown: '<path d="m6 9.5 6 6 6-6"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8.5v5M8.5 11h5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h8M6 19h8M14 5l-4 14"/>',
  strike: '<path d="M5 12h14M16 7.5A4 3.5 0 0 0 12 5c-2.5 0-4 1.3-4 3 0 1.3.8 2.3 2.5 3M8 16.5c.5 1.5 2 2.5 4 2.5 2.5 0 4-1.3 4-3 0-.7-.2-1.3-.6-1.8"/>',
  inlineCode: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  codeBlock: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m10 10-2 2 2 2M14 10l2 2-2 2"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r=".9"/><circle cx="4.8" cy="12" r=".9"/><circle cx="4.8" cy="17.5" r=".9"/>',
  numList: '<path d="M10 6.5h10M10 12h10M10 17.5h10M4 5l1.5-1v5M3.8 14.3a1.4 1.4 0 0 1 2.6.7c0 1-2.6 2.2-2.6 3.5h2.8"/>',
  task: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  quote: '<path d="M6 17c-1-1-1.5-2.3-1.5-4 0-3 2-5.5 5-6.5l.5 1.2C8 8.5 7.2 10 7 11.5h2.5V17zM15 17c-1-1-1.5-2.3-1.5-4 0-3 2-5.5 5-6.5l.5 1.2c-2 .8-2.8 2.3-3 3.8h2.5V17z"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M12 9.5v10"/>',
  hr: '<path d="M4 12h16"/>',
  undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H15a4.5 4.5 0 0 1 0 9h-3"/>',
  redo: '<path d="m15 14 4.5-4.5L15 5"/><path d="M19.5 9.5H9a4.5 4.5 0 0 0 0 9h3"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  presentation: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="m10 8 4 2-4 2zM8 20l4-4 4 4"/>',
  compare: '<rect x="3.5" y="4.5" width="7" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="15" rx="1.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function iconSvg(name: IconName, cls = 'ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="ico"
      style={{ width: size, height: size }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

/** Logo: a page with a bookmark ribbon and a link loop, drawn in theme colours. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="3" width="20" height="26" rx="3" fill="var(--accent)" />
      <path d="M9 10h9M9 14h12M9 18h7" stroke="var(--accent-soft)" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19 3h5v9l-2.5-2-2.5 2z" fill="var(--mark)" />
      <circle cx="22.5" cy="23.5" r="5.5" fill="var(--panel)" stroke="var(--accent)" strokeWidth="1.8" />
      <path d="M20.5 23.5h4M22.5 21.5v4" stroke="var(--mark)" strokeWidth="1.8" strokeLinecap="round" transform="rotate(45 22.5 23.5)" />
    </svg>
  );
}

import type { FileKind } from '../core/link';

export function kindIcon(kind: FileKind): IconName {
  switch (kind) {
    case 'pdf': return 'pdf';
    case 'sheet': return 'grid';
    case 'markdown': return 'note';
    case 'image': return 'image';
    case 'media': return 'play';
    case 'slides': return 'slides';
    case 'doc': return 'file';
    case 'code': return 'code';
    default: return 'file';
  }
}
