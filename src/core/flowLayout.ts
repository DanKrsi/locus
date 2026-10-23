// Turns a flowchart draft (boxes, loops, arrows; no coordinates) into a laid-out canvas, so Claude
// can describe a flowchart and the person gets something tidy to adjust by hand. ELK's layered
// layout places boxes top to bottom and sizes loop frames around their contents; arrows are then
// routed the way the editor draws them: forward arrows down or out to the side from a decision,
// loop-backs dashed up the side of their loop frame.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { CanvasDoc, CanvasEdge, CanvasNode, Shape, Side } from './canvas.ts';

export interface DraftBox {
  id: string;
  /** Markdown, citations included. */
  text: string;
  shape?: Shape;
  /** The innermost loop the box belongs to. */
  loop?: string;
}
export interface DraftLoop {
  id: string;
  label: string;
  /** The loop this one is nested in. */
  parent?: string;
}
export interface DraftArrow {
  /** Box or loop ids. */
  from: string;
  to: string;
  label?: string;
  /** Defaults to dashed for arrows that go back up (loops). */
  dashed?: boolean;
}
export interface Draft {
  boxes: DraftBox[];
  loops?: DraftLoop[];
  arrows: DraftArrow[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const round8 = (v: number) => Math.round(v / 8) * 8;

let elk: InstanceType<typeof ELK> | null = null;
/**
 * ELK's built-in worker takes any global `self` without a `document` for a web worker and then
 * never starts (PDF.js defines `self` in the MCP server), so hide it while ELK first loads.
 */
function getElk() {
  if (elk) return elk;
  const g = globalThis as { self?: unknown };
  const had = 'self' in g && typeof (globalThis as { document?: unknown }).document === 'undefined';
  const saved = g.self;
  if (had) delete g.self;
  try {
    elk = new ELK();
  } finally {
    if (had) g.self = saved;
  }
  return elk;
}
const LINK = /!?\[((?:[^\]\\]|\\.)*)\]\((?:<[^>]*>|[^)\s]*)(?:\s+"(?:[^"\\]|\\.)*")?\)/g;

/** A box size that fits its text (links count as their label plus an icon). */
export function boxSize(text: string, shape: Shape = 'process'): { w: number; h: number } {
  const visible = text.replace(LINK, '◆ $1');
  const lines = visible.split('\n');
  const CH = 7.3;
  const longest = Math.max(4, ...lines.map((l) => l.length));
  let w = Math.min(264, Math.max(144, round8(longest * CH + 32)));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * CH) / (w - 32))), 0);
  let h = Math.max(48, round8(rows * 19 + 26));
  if (shape === 'decision') {
    w = round8(Math.max(w * 1.3, 152));
    h = round8(Math.max(h * 1.5, 88));
  } else if (shape === 'io') w += 32;
  else if (shape === 'subprocess') w += 24;
  else if (shape === 'terminal') h = Math.max(44, h - 8);
  return { w, h };
}

export function checkDraft(d: Draft): void {
  const ids = new Set<string>();
  for (const x of [...d.boxes, ...(d.loops ?? [])]) {
    if (!x.id) throw new Error('Every box and loop needs an id');
    if (ids.has(x.id)) throw new Error(`Duplicate id "${x.id}"`);
    ids.add(x.id);
  }
  const loops = new Map((d.loops ?? []).map((l) => [l.id, l]));
  for (const b of d.boxes) if (b.loop && !loops.has(b.loop)) throw new Error(`Box "${b.id}" is in loop "${b.loop}", which isn't defined`);
  for (const l of loops.values()) {
    const seen = new Set<string>();
    for (let p = l.parent; p; p = loops.get(p)?.parent) {
      if (!loops.has(p)) throw new Error(`Loop "${l.id}" is inside "${p}", which isn't defined`);
      if (seen.has(p) || p === l.id) throw new Error(`Loop "${l.id}" is nested inside itself`);
      seen.add(p);
    }
  }
  for (const a of d.arrows) {
    if (!ids.has(a.from)) throw new Error(`Arrow from "${a.from}": no box or loop has that id`);
    if (!ids.has(a.to)) throw new Error(`Arrow to "${a.to}": no box or loop has that id`);
  }
}

export async function layoutDraft(d: Draft): Promise<CanvasDoc> {
  checkDraft(d);
  const loops = d.loops ?? [];
  const sizes = new Map(d.boxes.map((b) => [b.id, boxSize(b.text, b.shape)]));
  // Boxes come in reading order, so an arrow to an earlier step is a loop-back. ELK lays out the
  // rest, so steps stack in reading order; loop-backs are routed afterwards, up the loop side.
  const order = new Map(d.boxes.map((b, i) => [b.id, i]));
  const firstIn = (loop: string): number =>
    Math.min(
      Infinity,
      ...d.boxes.filter((b) => b.loop === loop).map((b) => order.get(b.id)!),
      ...loops.filter((l) => l.parent === loop).map((l) => firstIn(l.id)),
    );
  for (const l of loops) order.set(l.id, firstIn(l.id));
  const goesBack = (a: DraftArrow) => order.get(a.to)! <= order.get(a.from)! && a.from !== a.to;
  const elkNodes = new Map<string, ElkNode>();
  for (const l of loops) elkNodes.set(l.id, { id: l.id, children: [], layoutOptions: { 'elk.padding': '[top=48,left=32,bottom=28,right=32]' } });
  for (const b of d.boxes) elkNodes.set(b.id, { id: b.id, width: sizes.get(b.id)!.w, height: sizes.get(b.id)!.h });
  const root: ElkNode = {
    id: '__root',
    children: [],
    edges: d.arrows.filter((a) => !goesBack(a)).map((a, i) => ({ id: 'a' + i, sources: [a.from], targets: [a.to] })),
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.nodeNode': '56',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
  };
  const parentOf = (id: string) => loops.find((l) => l.id === id)?.parent ?? d.boxes.find((b) => b.id === id)?.loop;
  // Loops first, so a frame lists before the boxes in it (model order follows the draft).
  for (const x of [...loops, ...d.boxes]) {
    const parent = parentOf(x.id);
    (parent ? elkNodes.get(parent)! : root).children!.push(elkNodes.get(x.id)!);
  }
  const out = await getElk().layout(root);

  // Absolute rectangles of every box and loop.
  const rects = new Map<string, Rect>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      rects.set(c.id, { x: Math.round(x), y: Math.round(y), w: Math.round(c.width ?? 0), h: Math.round(c.height ?? 0) });
      walk(c, x, y);
    }
  };
  walk(out, 0, 0);

  // Loops containing an id, innermost first.
  const chain = (id: string) => {
    const out: string[] = [];
    for (let p = parentOf(id); p; p = loops.find((l) => l.id === p)?.parent) out.push(p);
    return out;
  };

  const shapeOf = (id: string) => d.boxes.find((b) => b.id === id)?.shape;
  const isBack = (a: DraftArrow) => goesBack(a) || rects.get(a.to)!.y + rects.get(a.to)!.h <= rects.get(a.from)!.y + 4;
  const centerX = (id: string) => rects.get(id)!.x + rects.get(id)!.w / 2;
  // A decision's branch closest to straight below leaves from the bottom; the others from the sides.
  const straightOn = new Map<string, DraftArrow>();
  for (const a of d.arrows) {
    if (shapeOf(a.from) !== 'decision' || isBack(a)) continue;
    const cur = straightOn.get(a.from);
    const off = (x: DraftArrow) => Math.abs(centerX(x.to) - centerX(x.from));
    if (!cur || off(a) < off(cur)) straightOn.set(a.from, a);
  }

  // Tidy: a box that simply follows another sits straight under it when ELK left it a little to one
  // side and nothing would overlap; then loop frames are refitted around what they hold.
  const boxIds = new Set(d.boxes.map((b) => b.id));
  const forward = d.arrows.filter((a) => !isBack(a) && boxIds.has(a.from) && boxIds.has(a.to));
  for (const b of d.boxes) {
    const inc = forward.filter((a) => a.to === b.id);
    if (inc.length !== 1) continue;
    const a = inc[0];
    const outs = forward.filter((x) => x.from === a.from);
    if (shapeOf(a.from) === 'decision' ? straightOn.get(a.from) !== a : outs.length !== 1) continue;
    const r = rects.get(b.id)!;
    const dx = centerX(a.from) - centerX(b.id);
    if (!dx || Math.abs(dx) > 56) continue;
    const moved = { ...r, x: r.x + dx };
    const clash = d.boxes.some((o) => {
      const q = rects.get(o.id)!;
      return o.id !== b.id && moved.x < q.x + q.w + 16 && q.x < moved.x + moved.w + 16 && moved.y < q.y + q.h && q.y < moved.y + moved.h;
    });
    if (!clash) rects.set(b.id, { ...moved, x: Math.round(moved.x) });
  }
  const depth = (id: string) => chain(id).length;
  for (const l of [...loops].sort((a, b) => depth(b.id) - depth(a.id))) {
    const inner = [...d.boxes.filter((b) => b.loop === l.id), ...loops.filter((x) => x.parent === l.id)].map((x) => rects.get(x.id)!);
    if (!inner.length) continue;
    const x = Math.min(...inner.map((r) => r.x)) - 32;
    const y = Math.min(...inner.map((r) => r.y)) - 48;
    rects.set(l.id, { x, y, w: Math.max(...inner.map((r) => r.x + r.w)) + 32 - x, h: Math.max(...inner.map((r) => r.y + r.h)) + 28 - y });
  }

  const nodes: CanvasNode[] = [
    ...loops.map((l) => ({ id: l.id, type: 'group' as const, label: l.label, ...pos(rects.get(l.id)!) })),
    ...d.boxes.map((b) => ({ id: b.id, type: 'text' as const, shape: b.shape ?? 'process', text: b.text, ...pos(rects.get(b.id)!) })),
  ];

  const all = [...rects.values()];
  const bounds = { x: Math.min(...all.map((r) => r.x)), y: 0, w: 0, h: 0 };
  bounds.w = Math.max(...all.map((r) => r.x + r.w)) - bounds.x;
  const lanes = new Map<string, number>();
  const edges: CanvasEdge[] = d.arrows.map((a, i) => {
    const s = rects.get(a.from)!;
    const t = rects.get(a.to)!;
    const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    const base = { id: 'e' + (i + 1), fromNode: a.from, toNode: a.to, toEnd: 'arrow' as const, route: 'elbow' as const, ...(a.label ? { label: a.label } : {}) };
    if (isBack(a)) {
      // Up the side of the innermost loop that holds both ends (or the whole chart).
      const from = chain(a.from);
      const shared = from.find((l) => l === a.to || chain(a.to).includes(l));
      const box = shared ? rects.get(shared)! : bounds;
      const side: Side = sc.x >= box.x + box.w / 2 ? 'right' : 'left';
      const key = (shared ?? '') + side;
      const k = lanes.get(key) ?? 0;
      lanes.set(key, k + 1);
      const inset = shared ? 14 + k * 8 : -(28 + k * 12);
      const x = side === 'left' ? box.x + inset : box.x + box.w - inset;
      return { ...base, fromSide: side, toSide: side, style: a.dashed === false ? undefined : 'dashed', points: [{ x: Math.round(x), y: Math.round(sc.y) }, { x: Math.round(x), y: Math.round(tc.y) }] } as CanvasEdge;
    }
    let fromSide: Side = 'bottom';
    let toSide: Side = 'top';
    const below = t.y >= s.y + s.h - 4;
    const dx = tc.x - sc.x;
    if (below && shapeOf(a.from) === 'decision' && straightOn.get(a.from) !== a) fromSide = dx >= 0 ? 'right' : 'left';
    else if (!below) {
      fromSide = dx > 0 ? 'right' : 'left';
      toSide = dx > 0 ? 'left' : 'right';
    }
    return { ...base, fromSide, toSide, ...(a.dashed ? { style: 'dashed' as const } : {}) };
  });
  return { nodes, edges };
}

function pos(r: Rect) {
  return { x: r.x, y: r.y, width: r.w, height: r.h };
}
