import type { Location } from '../../core/link';

export interface CiteTarget {
  loc: Location;
  /** Text selected in the document; stored as the link title. */
  quote?: string;
  /** Printed page label, used in the default link name. */
  pageLabel?: string;
}

export interface ViewerHandle {
  citeTarget(): CiteTarget | null;
  /** Viewers with their own zoom (PDF) take the zoom keys here; 0 resets to 100%. */
  zoom?(dir: 1 | -1 | 0): void;
}

export interface RevealRequest {
  loc: Location;
  nonce: number;
  /** Just show this place (keeping the sides of a comparison together): no citation highlight, no glide. */
  follow?: boolean;
}

/** A place in this document that some note cites ("Cited in" markers). */
export interface CiteMark {
  loc: Location;
  label: string;
  note: string;
  line: number;
}

export interface ViewerProps {
  data: Uint8Array;
  path: string;
  reveal?: RevealRequest;
  /** Called by the viewer's Cite button. */
  onCite(): void;
  handle(h: ViewerHandle | null): void;
  /** Places other notes cite, for margin/gutter markers. */
  marks?: CiteMark[];
  onMark?(mark: CiteMark): void;
  /** Reports where the reader is as they scroll (page and position, top line, top-left cell, slide). */
  onPlace?(loc: Location): void;
  /** Documents zoom (1 = 100%); PDFs use their own zoom instead. */
  zoom?: number;
  /** Rendered at the left of the viewer's toolbar (shared controls). */
  children?: React.ReactNode;
}
