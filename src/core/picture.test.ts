import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { crop, detail, findPicture, gray, judgePicture, resize, SAME_PICTURE, type Gray, type PageBox } from './picture.ts';

/** White paper with a few made-up "pictures" (deterministic noise blocks) drawn where asked. */
function paper(w: number, h: number, pictures: { x: number; y: number; seed: number; w?: number; h?: number }[]): Gray {
  const g = gray(w, h);
  g.px.fill(255);
  for (const p of pictures) {
    let s = p.seed;
    const pw = p.w ?? 60;
    const ph = p.h ?? 40;
    // Smooth-ish blobs, like a photo or a drawing, rather than per-pixel static.
    const cells: number[] = [];
    for (let i = 0; i < 64; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      cells.push(s % 256);
    }
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) g.px[(p.y + y) * w + p.x + x] = cells[Math.floor((y / ph) * 8) * 8 + Math.floor((x / pw) * 8)];
  }
  return g;
}

test('a picture that moved is found where it went, and only there', () => {
  const before = paper(300, 400, [{ x: 20, y: 30, seed: 1 }, { x: 150, y: 250, seed: 2 }]);
  const after = paper(300, 400, [{ x: 150, y: 250, seed: 1 }, { x: 20, y: 30, seed: 2 }]);
  const r = findPicture(after, crop(before, 20, 30, 60, 40));
  assert.ok(r.best && r.best.score > 0.99, String(r.best?.score));
  assert.deepEqual([r.best!.x, r.best!.y], [150, 250]);
  assert.ok(!r.runnerUp || r.runnerUp.score < 0.6, String(r.runnerUp?.score));
});

test('a picture drawn a little larger is found with a resized template', () => {
  const before = paper(300, 400, [{ x: 20, y: 30, seed: 3 }]);
  const after = paper(300, 400, [{ x: 100, y: 200, seed: 3, w: 66, h: 44 }]);
  const tpl = crop(before, 20, 30, 60, 40);
  assert.ok((findPicture(after, tpl).best?.score ?? 0) < SAME_PICTURE);
  const r = findPicture(after, resize(tpl, 66, 44));
  assert.ok(r.best && r.best.score >= SAME_PICTURE, String(r.best?.score));
  assert.ok(Math.abs(r.best!.x - 100) <= 2 && Math.abs(r.best!.y - 200) <= 2, `${r.best!.x},${r.best!.y}`);
});

test('blank paper has no detail to look for', () => {
  const before = paper(300, 400, [{ x: 20, y: 30, seed: 1 }]);
  assert.ok(detail(crop(before, 150, 200, 80, 60)) < 1);
  assert.ok(detail(crop(before, 20, 30, 60, 40)) > 20);
});

const box = (page: number, x: number, y: number, score: number): PageBox => ({ page, x, y, w: 60, h: 40, score });
const old = { page: 1, x: 20, y: 30, w: 60, h: 40 };

test('judging: unchanged, moved, repeated, gone', () => {
  assert.equal(judgePicture(old, [box(1, 20, 30, 0.995), box(1, 200, 300, 0.3)]).kind, 'same');
  const moved = judgePicture(old, [box(1, 0, 0, 0.25), box(2, 20, 30, 0.999), box(2, 200, 10, 0.3)]);
  assert.equal(moved.kind, 'moved');
  assert.equal(moved.kind === 'moved' && moved.at.page, 2);
  // A logo on every page: reported as repeated, nearest the old place proposed.
  const logo = judgePicture(old, [box(1, 22, 300, 0.98), box(2, 22, 300, 0.98), box(3, 22, 300, 0.98)]);
  assert.equal(logo.kind, 'several');
  assert.ok(logo.kind === 'several' && logo.at.page === 1 && logo.count === 3);
  // Still in its old place, even though it is repeated: nothing happened to it.
  assert.equal(judgePicture(old, [box(2, 20, 30, 0.99), box(1, 20, 30, 0.99)]).kind, 'same');
  assert.equal(judgePicture(old, [box(1, 50, 60, 0.71)]).kind, 'gone');
  assert.equal(judgePicture(old, []).kind, 'gone');
});
