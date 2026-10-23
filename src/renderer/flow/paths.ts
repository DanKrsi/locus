// Arrow geometry for flowcharts: elbow (right-angle) routes through bend points, smooth curves
// through them, and where to put an arrow's label.
import type { Side } from '../../core/canvas';

export interface P {
  x: number;
  y: number;
}

const STUB = 18;
const normal = (side: Side): P =>
  side === 'left' ? { x: -1, y: 0 } : side === 'right' ? { x: 1, y: 0 } : side === 'top' ? { x: 0, y: -1 } : { x: 0, y: 1 };

/**
 * Right-angle route from s to t through the bend points: it leaves and enters boxes straight out of
 * their sides, and between points turns at most once, alternating horizontal and vertical runs.
 */
export function elbowRoute(s: P, sSide: Side, t: P, tSide: Side, via: P[]): P[] {
  const ns = normal(sSide);
  const nt = normal(tSide);
  const s2 = { x: s.x + ns.x * STUB, y: s.y + ns.y * STUB };
  const t2 = { x: t.x + nt.x * STUB, y: t.y + nt.y * STUB };
  const out: P[] = [s, s2];
  let horizontal = ns.x !== 0;
  const stops = [...via, t2];
  for (const b of stops) {
    const a = out[out.length - 1];
    if (a.x !== b.x && a.y !== b.y) {
      out.push(horizontal ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
      horizontal = !horizontal;
    } else if (a.y === b.y && a.x !== b.x) horizontal = true;
    else if (a.x === b.x && a.y !== b.y) horizontal = false;
    out.push(b);
  }
  out.push(t);
  return dedupe(out);
}

function dedupe(points: P[]): P[] {
  const out: P[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  // Drop middle points that sit on a straight run.
  return out.filter((p, i) => {
    const a = out[i - 1];
    const b = out[i + 1];
    return !a || !b || !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

/** A polyline path, with corners rounded by up to r. */
export function roundedPath(points: P[], r = 6): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const p = points[i];
    const b = points[i + 1];
    const r1 = Math.min(r, dist(a, p) / 2, dist(p, b) / 2);
    const p1 = toward(p, a, r1);
    const p2 = toward(p, b, r1);
    d += ` L${p1.x},${p1.y} Q${p.x},${p.y} ${p2.x},${p2.y}`;
  }
  const last = points[points.length - 1];
  return d + ` L${last.x},${last.y}`;
}

/** A smooth curve through all the points (Catmull-Rom as cubic Béziers). */
export function curvePath(points: P[]): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
  }
  return d;
}

/** The point halfway along a polyline. */
export function midpoint(points: P[]): P {
  const lengths = points.slice(1).map((p, i) => dist(points[i], p));
  let half = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (half <= lengths[i]) return toward(points[i], points[i + 1], half);
    half -= lengths[i];
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);
function toward(from: P, to: P, len: number): P {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * len) / d, y: from.y + ((to.y - from.y) * len) / d };
}

export const snap = (v: number, grid = 8) => Math.round(v / grid) * grid;
