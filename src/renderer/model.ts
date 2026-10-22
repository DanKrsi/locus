import type { FileKind, Location } from '../core/link';
import type { RevealRequest } from './viewers/types';

export interface DocTab {
  id: string;
  /** Workspace path ("/docs/a.pdf") or absolute path for external files. */
  path: string;
  external: boolean;
  /** Full SHA when showing a past version; undefined = latest. */
  rev?: string;
  kind: FileKind;
  reveal?: RevealRequest;
  /** When set, the tab compares this version (left) with rev/latest (right). */
  compare?: string;
}

export interface NoteTab {
  /** Stable across renames, so the editor's container isn't remounted. */
  id: string;
  path: string;
  dirty: boolean;
}

let nextId = 1;
export const newId = () => `t${nextId++}`;

let nonce = 1;
export const revealOf = (loc: Location): RevealRequest => ({ loc, nonce: nonce++ });
