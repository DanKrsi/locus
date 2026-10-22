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
}

export interface RevealRequest {
  loc: Location;
  nonce: number;
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
  /** Rendered at the left of the viewer's toolbar (shared controls). */
  children?: React.ReactNode;
}
