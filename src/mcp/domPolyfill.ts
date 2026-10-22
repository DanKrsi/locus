// PDF.js expects browser geometry classes even when only extracting text. Node has none, and
// PDF.js's own fallback (@napi-rs/canvas) is a native module we don't ship, so provide a
// pure-JS DOMMatrix. Must be imported before pdfjs-dist.
import CSSMatrix from '@thednp/dommatrix';

type M = InstanceType<typeof CSSMatrix>;

class DOMMatrixShim extends CSSMatrix {
  private assign(m: M): this {
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'm11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44', 'is2D', 'isIdentity'] as const) {
      (this as unknown as Record<string, unknown>)[k] = (m as unknown as Record<string, unknown>)[k];
    }
    return this;
  }
  multiplySelf(other: M) {
    return this.assign(this.multiply(other));
  }
  preMultiplySelf(other: M) {
    return this.assign((other as DOMMatrixShim).multiply(this));
  }
  translateSelf(x = 0, y = 0, z = 0) {
    return this.assign(this.translate(x, y, z));
  }
  scaleSelf(x = 1, y = x, z = 1) {
    return this.assign(this.scale(x, y, z));
  }
  invertSelf() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) return this.assign(new CSSMatrix([NaN, NaN, NaN, NaN, NaN, NaN]));
    return this.assign(new CSSMatrix([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]));
  }
  inverse() {
    return new DOMMatrixShim([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf();
  }
}

const g = globalThis as Record<string, unknown>;
if (!g.DOMMatrix) g.DOMMatrix = DOMMatrixShim;
if (!g.ImageData) g.ImageData = class ImageData {};
if (!g.Path2D) g.Path2D = class Path2D {};

// stdout carries the MCP protocol; send library logging (PDF.js warnings) to stderr instead.
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;
