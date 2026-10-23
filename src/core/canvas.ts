// Flowcharts are JSON Canvas files (jsoncanvas.org, the format Obsidian's Canvas uses) with a few
// extra fields Obsidian ignores: box shapes, arrow routing, line style and bend points. Box text
// is markdown, so citations in boxes are ordinary reference links.
import { extractLinks, type MdLink } from './mdlinks.ts';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Shape = 'process' | 'decision' | 'terminal' | 'io' | 'note' | 'subprocess';
export type Route = 'straight' | 'elbow' | 'curve';

export interface CanvasNode {
  id: string;
  type: 'text' | 'group' | 'file' | 'link';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Markdown text of a text node. */
  text?: string;
  /** Title of a group (a loop frame here). */
  label?: string;
  color?: string;
  file?: string;
  url?: string;
  /** Locus: the box shape (text nodes; default "process"). */
  shape?: Shape;
  [extra: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  toNode: string;
  toSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  label?: string;
  color?: string;
  /** Locus: how the arrow is drawn (default "elbow"). */
  route?: Route;
  /** Locus: line style (default "solid"). */
  style?: 'solid' | 'dashed';
  /** Locus: bend points the arrow passes through, in canvas coordinates. */
  points?: { x: number; y: number }[];
  [extra: string]: unknown;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

export const isCanvas = (path: string) => /\.canvas$/i.test(path);

export function parseCanvas(text: string): CanvasDoc {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return { nodes: [], edges: [] };
  const raw = JSON.parse(t) as Partial<CanvasDoc>;
  return { ...raw, nodes: Array.isArray(raw.nodes) ? raw.nodes : [], edges: Array.isArray(raw.edges) ? raw.edges : [] };
}

/**
 * Writes the file the way Obsidian does, one node or edge per line, so moving a box changes one
 * line in a diff and "Cited in" can point at the line of the box that cites.
 */
export function serializeCanvas(doc: CanvasDoc): string {
  const { nodes, edges, ...rest } = doc;
  const list = (items: unknown[]) => (items.length ? '[\n\t\t' + items.map((i) => JSON.stringify(i)).join(',\n\t\t') + '\n\t]' : '[]');
  const parts = [`\t"nodes":${list(nodes)}`, `\t"edges":${list(edges)}`];
  for (const [k, v] of Object.entries(rest)) parts.push(`\t${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return '{\n' + parts.join(',\n') + '\n}\n';
}

export interface CanvasLink extends MdLink {
  nodeId: string;
  /** 1-based line of the node in the file. */
  nodeLine: number;
}

/** Reference links in the boxes of a canvas file, with the line of each box. */
export function canvasLinks(text: string): CanvasLink[] {
  let doc: CanvasDoc;
  try {
    doc = parseCanvas(text);
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const lineOf = (id: string) => {
    const needle = `"id":${JSON.stringify(id)}`;
    const i = lines.findIndex((l) => l.includes(needle));
    return i >= 0 ? i + 1 : 1;
  };
  const out: CanvasLink[] = [];
  for (const n of doc.nodes) {
    if (typeof n.text !== 'string') continue;
    const nodeLine = lineOf(n.id);
    for (const l of extractLinks(n.text)) out.push({ ...l, nodeId: n.id, nodeLine });
  }
  return out;
}

/** Rewrites the markdown of every box (for moved files); returns null when nothing changed. */
export function rewriteCanvas(text: string, rewrite: (md: string) => { text: string; count: number }): { text: string; count: number } | null {
  let doc: CanvasDoc;
  try {
    doc = parseCanvas(text);
  } catch {
    return null;
  }
  let count = 0;
  for (const n of doc.nodes) {
    if (typeof n.text !== 'string') continue;
    const r = rewrite(n.text);
    if (r.count) {
      n.text = r.text;
      count += r.count;
    }
  }
  return count ? { text: serializeCanvas(doc), count } : null;
}

/** A starting flowchart for "New flowchart". */
export function newCanvas(): CanvasDoc {
  return {
    nodes: [
      { id: 'start', type: 'text', shape: 'terminal', text: 'Start', x: 0, y: 0, width: 160, height: 48 },
      { id: 'step', type: 'text', shape: 'process', text: 'First step', x: 0, y: 112, width: 160, height: 64 },
    ],
    edges: [{ id: 'e1', fromNode: 'start', fromSide: 'bottom', toNode: 'step', toSide: 'top', toEnd: 'arrow', route: 'elbow' }],
  };
}
